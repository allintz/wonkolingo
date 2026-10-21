// Regression tests for the 10/21 red-team findings, against a LOCAL `wrangler dev` only (it creates accounts and groups).
// Run: node tests/security.test.mjs http://127.0.0.1:8799
import { randomBytes } from 'node:crypto';

const BASE = process.argv[2] || 'http://127.0.0.1:8799';
if (/workers\.dev/.test(BASE)) { console.error('Local server only.'); process.exit(2); }
const net = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
let IP = net();
let pass = 0, failN = 0; const fails = [];
const ok = (cond, name, extra) => { if (cond) pass++; else { failN++; fails.push(name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 300) : '')); } };
async function call(path, { body, token, headers = {}, ip = IP, raw, ctype } = {}) {
  const h = { 'CF-Connecting-IP': ip, Origin: 'http://localhost:8799', ...headers };
  if (body !== undefined || raw !== undefined) h['Content-Type'] = ctype || 'application/json';
  if (token) h.Authorization = 'Bearer ' + token;
  const t0 = Date.now();
  const r = await fetch(BASE + path, { method: body !== undefined || raw !== undefined ? 'POST' : 'GET', headers: h, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
  let d = null; const t = await r.text(); try { d = JSON.parse(t); } catch { d = t; }
  return { s: r.status, d, h: r.headers, ms: Date.now() - t0 };
}
const today = new Date().toISOString().slice(0, 10);
const acct = async name => (await call('/api/account', { body: { name }, ip: net() })).d;
const group = async (token, name) => (await call('/api/groups', { token, body: { groupName: 'Sec ' + randomBytes(2).toString('hex'), name } })).d;

// ---- 1. A malformed practice day can't break the board for the group
const A = await acct('Alice'), M = await acct('Mallory');
const g = await group(A.token, 'Alice');
await call('/api/join', { token: M.token, body: { code: g.code, name: 'Mallory' } });
let r = await call('/api/complete', { token: M.token, body: { lessonId: 'au0l0', title: 'L', xp: 10, acc: 90, day: '2026-10-00' } });
ok(r.s === 400, 'completion with an impossible date is refused', r);
r = await call('/api/complete', { token: M.token, body: { lessonId: 'au0l0', title: 'L', xp: 10, acc: 90, day: ['x'] } }); ok(r.s === 400, 'completion with a non-string date is refused', r.s);
r = await call('/api/complete', { token: M.token, body: { lessonId: 'au0l0', title: 'L', xp: 10, acc: 90, day: '2020-01-01' } }); ok(r.s === 400, 'completion dated years ago is refused', r.s);
r = await call('/api/state', { token: M.token, body: { state: { srs: {}, activeDays: ['2026-01-00', today, 'junk'] } } }); ok(r.s === 200, 'state with bad days is accepted (bad days dropped)', r);
r = await call('/api/state', { token: M.token }); ok(JSON.stringify(r.d.state.activeDays) === JSON.stringify([today]), 'bad practice days were dropped', r.d.state && r.d.state.activeDays);
r = await call('/api/board', { token: A.token }); ok(r.s === 200, 'board still works for everyone', r.s);

// ---- 2. A huge synced schedule can't make the board slow
const pauses = Array.from({ length: 2000 }, (_, i) => ({ from: '2025-01-0' + (1 + i % 9), to: '2025-01-0' + (1 + i % 9) }));
r = await call('/api/state', { token: M.token, body: { state: { srs: {}, activeDays: ['0001-01-01', '1999-05-05', today], settings: { days: [true, true, true, true, true, true, true], pauses } } } });
ok(r.s === 200, 'big state accepted (trimmed)', r.s);
r = await call('/api/board?today=9999-12-31', { token: A.token }); ok(r.s === 200 && r.ms < 1500, 'board stays fast with a huge schedule and a far-future date', { s: r.s, ms: r.ms });
r = await call('/api/board?today=2026-13-01', { token: A.token }); ok(r.s === 200, 'board ignores an impossible date', r.s);

// ---- 3. One network can't make unlimited accounts through any route
IP = net();
let made = 0;
for (let i = 0; i < 12; i++) if ((await call('/api/account', { body: { name: 'Bulk ' + i } })).s === 200) made++;
for (let i = 0; i < 12; i++) if ((await call('/api/groups', { body: { groupName: 'Bulk group ' + i, name: 'Bulk' } })).s === 200) made++;
ok(made === 20, 'account cap is shared by sign-up and signed-out group creation', made);
r = await call('/api/join', { body: { code: g.code, name: 'Overflow' } }); ok(r.s === 429, 'signed-out join counts against the same cap', r.s);
// IPv6: the same /64 is one network.
const v6pre = `2001:db8:${randomBytes(2).toString('hex')}:${randomBytes(2).toString('hex')}`, v6 = n => `${v6pre}:${n.toString(16)}::${(n * 7).toString(16)}`;
let v6made = 0;
for (let i = 1; i <= 22; i++) if ((await call('/api/account', { body: { name: 'Six ' + i }, ip: v6(i) })).s === 200) v6made++;
ok(v6made === 20, 'addresses in one IPv6 /64 share the cap', v6made);

// ---- 4. Rate limits hold under parallel requests
IP = net();
const P = (await call('/api/account', { body: { name: 'Pat', username: 'sec' + randomBytes(3).toString('hex'), password: 'correct horse 9' } })).d;
const tries = await Promise.all(Array.from({ length: 30 }, (_, i) => call('/api/password/login', { body: { username: P.username, password: 'wrong ' + i } })));
const checked = tries.filter(t => t.s === 401).length;
ok(checked <= 10, 'parallel wrong passwords: at most 10 checked per username per network', checked);
r = await call('/api/password/login', { body: { username: P.username, password: 'correct horse 9' }, ip: net() });
ok(r.s === 200, 'the owner can still sign in from another network after someone hammers their username', r.s);
r = await call('/api/password/login', { body: { username: 'nobody-' + randomBytes(4).toString('hex'), password: 'whatever' }, ip: net() });
ok(r.s === 401 && r.ms > 3, 'unknown usernames get the same answer', r);

// ---- 5. Sign-in codes can't be claimed twice, even in parallel
r = await call('/api/link', { token: P.token, body: {} });
const code = r.d.code;
const claims = await Promise.all(Array.from({ length: 6 }, () => call('/api/link/claim', { body: { code }, ip: net() })));
ok(claims.filter(c => c.s === 200).length === 1, 'a sign-in code works exactly once', claims.map(c => c.s));

// ---- 6. Feed text comes from the app, not the player; XP is capped per day
r = await call('/api/complete', { token: M.token, body: { lessonId: '"><img src=x>', title: 'T', xp: 10, acc: 90, day: today } }); ok(r.s === 400, 'lesson id with markup is refused', r.s);
r = await call('/api/complete', { token: M.token, body: { lessonId: 'review-1', title: 'Buy my stuff at example.com', reviewed: 3, xp: 10, acc: 90, day: today } });
r = await call('/api/board', { token: A.token });
ok(r.d.feed.some(f => f.lessonId === 'review-1' && f.title === 'today’s review (3 cards)'), 'review sessions get a server-made title', r.d.feed.map(f => f.title));
let total = 0;
for (let i = 0; i < 8; i++) { r = await call('/api/complete', { token: M.token, body: { lessonId: 'au0l' + i + 'x', title: 'L', xp: 500, acc: 90, day: today } }); total += r.d.xp || 0; }
ok(total <= 3000, 'XP posted per day is capped', total);

// ---- 7. CORS and content types
r = await call('/api/me', { token: A.token, headers: { Origin: 'https://evil.example' } }); ok(!r.h.get('access-control-allow-origin'), 'other websites get no CORS access', r.h.get('access-control-allow-origin'));
r = await call('/api/me', { token: A.token, headers: { Origin: 'capacitor://localhost' } }); ok(r.h.get('access-control-allow-origin') === 'capacitor://localhost', 'the iPhone app gets CORS access');
r = await call('/api/grade', { raw: JSON.stringify({ question: 'q', answer: 'a', response: 'r' }), ctype: 'text/plain' }); ok(r.s === 415, 'a text/plain post (no preflight) is refused', r.s);

// ---- 8. Names: no invisible or direction-flipping characters
r = await call('/api/account', { body: { name: '‮ecilA' }, ip: net() }); ok(r.s === 200 && r.d.player.name === 'ecilA', 'direction override stripped from names', r.d.player);
r = await call('/api/account', { body: { name: 'Al​ice' }, ip: net() }); ok(r.d.player.name === 'Alice', 'zero-width space stripped', r.d.player);
r = await call('/api/account', { body: { name: '​⁦' }, ip: net() }); ok(r.d.player.name === 'Player', 'an invisible name becomes the default', r.d.player);
const E1 = await acct('Émile'), E2 = await acct('émile');
await call('/api/join', { token: E1.token, body: { code: g.code, name: 'Émile' } });
r = await call('/api/join', { token: E2.token, body: { code: g.code, name: 'émile' } }); ok(r.s === 409, 'names differing only in accented case count as taken', r.s);

// ---- 9. Synced state: shape checked, prototype keys dropped, size in bytes
r = await call('/api/state', { token: A.token, body: { state: { srs: null } } }); ok(r.s === 400, 'srs: null refused', r.s);
r = await call('/api/state', { token: A.token, body: { state: { srs: [] } } }); ok(r.s === 400, 'srs: [] refused', r.s);
r = await call('/api/state', { token: A.token, body: { state: { srs: {}, activeDays: 'x' } } }); ok(r.s === 400, 'activeDays must be a list', r.s);
r = await call('/api/state', { token: A.token, raw: '{"state":{"srs":{},"__proto__":{"polluted":1},"prefs":{"constructor":{"x":1},"style":"short"}}}' });
r = await call('/api/state', { token: A.token }); ok(r.d.state && !Object.prototype.hasOwnProperty.call(r.d.state, '__proto__') && r.d.state.prefs.style === 'short' && !Object.prototype.hasOwnProperty.call(r.d.state.prefs, 'constructor'), 'prototype keys dropped from synced state', r.d.state);
r = await call('/api/state', { token: A.token, raw: JSON.stringify({ state: { srs: {}, pad: '€'.repeat(300000) } }) }); ok(r.s === 413, 'state size counted in bytes', r.s);

// ---- 10. Courses: an author can delete theirs after leaving; reports from blocked players stay hidden
const cj = { format: 'wonkolingo-course/1', id: 'sec-course', title: 'Sec course', description: 'd', units: [{ title: 'U', lessons: [{ title: 'L', items: [{ t: 'mc', p: 'Q?', o: ['a', 'b'], a: 0, x: 'x' }, { t: 'mc', p: 'Q2?', o: ['c', 'd'], a: 1, x: 'y' }] }] }] };
r = await call('/api/courses', { token: A.token, body: { course: cj } }); ok(r.s === 200, 'course uploaded', r);
r = await call('/api/courses', { token: A.token, body: { course: cj } }); ok(r.s === 200 && r.d.unchanged, 'unchanged re-upload is a no-op (no new screening)', r.d);
r = await call('/api/courses/sec-course/reports', { token: M.token, body: { note: 'harass harass', itemText: 'Q' } }); ok(r.s === 200, 'report filed', r.s);
await call('/api/block', { token: A.token, body: { playerId: M.player.id } });
r = await call('/api/courses/sec-course/reports', { token: A.token }); ok(r.s === 200 && r.d.reports.length === 0, 'reports from a blocked player are hidden from the author', r.d);
const X = await acct('Xavier');
r = await call('/api/block', { token: A.token, body: { playerId: X.player.id } }); ok(r.s === 404, 'can’t block someone outside your group', r.s);
await call('/api/leave', { token: A.token, body: {} });
r = await call('/api/courses/sec-course/delete', { token: A.token, body: {} }); ok(r.s === 200, 'author deletes their course after leaving the group', r);
r = await call('/api/courses', { token: M.token }); ok(r.s === 200 && !r.d.courses.some(c => c.slug === 'sec-course'), 'the deleted course is gone for the group', r.d);

// ---- 11. Big or odd requests
r = await call('/api/account', { raw: '{"name":' + '"' + 'x'.repeat(200000) + '"}' }); ok(r.s !== 500, 'oversized body handled', r.s);
r = await call('/api/account', { raw: '{not json' }); ok(r.s !== 500, 'malformed JSON handled', r.s);

// ---- 12. Bug reports: stored, cleaned, limited per network
IP = net();
r = await call('/api/bug', { body: { message: 'boom \u001b[31m red', stack: 'at x', where: '#me', build: 'test', app: false, ua: 'node' } }); ok(r.s === 200 && r.d.ok && !r.d.dropped, 'bug report stored', r.d);
let dropped = false;
for (let i = 0; i < 21; i++) { r = await call('/api/bug', { body: { message: 'flood ' + i } }); if (r.d && r.d.dropped) dropped = true; }
ok(dropped, 'bug reports from one network are capped', r.d);
r = await call('/api/bug', { body: { message: '' } }); ok(r.s === 400, 'empty bug report refused', r.s);

console.log(`PASS ${pass}  FAIL ${failN}`); fails.forEach(f => console.log('FAIL', f));
process.exit(failN ? 1 : 0);
