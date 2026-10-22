// Push notifications against a LOCAL wrangler dev whose Apple push service is a fake run by this test.
// Start the server with the test key (tests/README.md), then: node tests/push.test.mjs http://127.0.0.1:8814
// The fake listens on 127.0.0.1:8841, checks every request's signed token with the test key's public half, and answers
// 410 for tokens starting with "dead" (an uninstalled app).
import http from 'node:http';
import { createVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:8814';
const KEY = JSON.parse(readFileSync(new URL('./push-test-key.json', import.meta.url)));
let pass = 0, failN = 0; const fails = [];
const ok = (cond, name, extra) => { if (cond) pass++; else { failN++; fails.push(name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : '')); } };
const RUN_IP = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.7`;
async function call(path, { body, token, ip } = {}) {
  const h = { 'CF-Connecting-IP': ip || RUN_IP }; if (body !== undefined) h['Content-Type'] = 'application/json'; if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method: body !== undefined ? 'POST' : 'GET', headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  let d = null; const t = await r.text(); try { d = JSON.parse(t); } catch { d = t; }
  return { s: r.status, d };
}

// The fake Apple push service.
const got = [];
const b64 = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
    const jwt = String(req.headers.authorization || '').replace(/^bearer /, '');
    const [h, p, sig] = jwt.split('.');
    let valid = false, head = {}, claims = {};
    try {
      head = JSON.parse(b64(h)); claims = JSON.parse(b64(p));
      const v = createVerify('SHA256'); v.update(h + '.' + p);
      valid = v.verify({ key: KEY.publicPem, dsaEncoding: 'ieee-p1363' }, b64(sig));
    } catch {}
    const token = req.url.split('/').pop();
    got.push({ path: req.url, token, topic: req.headers['apns-topic'], type: req.headers['apns-push-type'], valid, head, claims, body: JSON.parse(raw || '{}') });
    if (!valid) { res.writeHead(403); res.end('{"reason":"InvalidProviderToken"}'); return; }
    if (token.startsWith('dead')) { res.writeHead(410); res.end('{"reason":"Unregistered"}'); return; }
    res.writeHead(200); res.end();
  });
});
await new Promise(r => server.listen(8841, '127.0.0.1', r));
const since = () => { const n = got.length; return () => got.slice(n); };
const tok = c => c.repeat(64);
const today = new Date().toISOString().slice(0, 10);
const wait = () => new Promise(r => setTimeout(r, 300));

try {
  const tag = Math.random().toString(36).slice(2, 6);
  let r = await call('/api/groups', { body: { groupName: 'Push ' + tag, name: 'Ann' + tag } }); const A = r.d; ok(r.s === 200, 'group made', r);
  r = await call('/api/join', { body: { code: A.code, name: 'Bo' + tag }, ip: RUN_IP.replace(/\.7$/, '.8') }); const B = r.d; ok(r.s === 200, 'Bo joins', r);
  r = await call('/api/join', { body: { code: A.code, name: 'Cy' + tag }, ip: RUN_IP.replace(/\.7$/, '.9') }); const C = r.d; ok(r.s === 200, 'Cy joins', r);

  r = await call('/api/push/register', { token: B.token, body: { token: 'xyz' } }); ok(r.s === 400, 'bad device token refused', r);
  r = await call('/api/push/register', { token: B.token, body: { token: tok('b') } }); ok(r.s === 200 && r.d.ready === true, 'Bo registers a phone; server has a key', r);
  r = await call('/api/push/register', { token: B.token, body: { token: 'dead' + tok('0').slice(4) } }); ok(r.s === 200, 'Bo registers a second (uninstalled) phone', r);

  // nudge -> push, correctly signed, to both phones; the dead one is forgotten
  let mark = since();
  r = await call('/api/nudge', { token: A.token, body: { to: B.player.id } }); ok(r.s === 200, 'Ann nudges Bo', r);
  let sent = mark();
  ok(sent.length === 2, 'push sent to both of Bo’s phones', sent.map(x => x.token.slice(0, 6)));
  const first = sent.find(x => x.token === tok('b')) || {};
  ok(first.valid && first.head.alg === 'ES256' && first.head.kid === KEY.keyId && first.claims.iss === '29B8GL5NYV', 'signed token is valid (ES256, key id, team)', { head: first.head, claims: first.claims });
  ok(first.topic === 'com.alexlintz.wonkolingo' && first.type === 'alert', 'topic and push type', first);
  ok(first.body.aps && /Ann.* nudged you/.test(first.body.aps.alert.body) && first.body.kind === 'nudge', 'nudge text', first.body);
  mark = since();
  await call('/api/kudos', { token: C.token, body: { to: B.player.id, ref: 'nope' } });
  await call('/api/complete', { token: B.token, body: { lessonId: 'review-1', reviewed: 2, xp: 20, acc: 100, day: today } });
  r = await call('/api/kudos', { token: C.token, body: { to: B.player.id, ref: 'review-1' } }); ok(r.s === 200, 'Cy high-fives Bo', r);
  sent = mark();
  ok(sent.length === 1 && sent[0].token === tok('b') && /high-fived/.test(sent[0].body.aps.alert.body), 'high-five pushed, dead phone no longer tried', sent.map(x => [x.token.slice(0, 6), x.body.aps && x.body.aps.alert.body]));

  // friend streak request and accept push to the other person
  await call('/api/push/register', { token: A.token, body: { token: tok('a') } });
  mark = since();
  await call('/api/friend/request', { token: B.token, body: { to: A.player.id, today } });
  await call('/api/friend/accept', { token: A.token, body: { to: B.player.id, today } });
  sent = mark();
  ok(sent.length === 2 && sent[0].token === tok('a') && /wants to start a friend streak/.test(sent[0].body.aps.alert.body) && sent[1].token === tok('b') && /accepted/.test(sent[1].body.aps.alert.body), 'request pushed to Ann, accept pushed to Bo', sent.map(x => [x.token.slice(0, 1), x.body.aps.alert.body]));

  // "your turn": Bo already practiced today (his completion), so Ann finishing doesn't push him;
  // Ann hasn't practiced, so Bo finishing pushes her, once a day
  await call('/api/state', { token: B.token, body: { state: { srs: {}, activeDays: [today] } } });
  mark = since();
  await call('/api/complete', { token: A.token, body: { lessonId: 'review-2', reviewed: 2, xp: 20, acc: 100, day: today } });
  ok(mark().length === 0, 'no "your turn" for a partner who already practiced');
  await call('/api/state', { token: A.token, body: { state: { srs: {}, activeDays: [] } } });
  mark = since();
  await call('/api/complete', { token: B.token, body: { lessonId: 'review-3', reviewed: 2, xp: 20, acc: 100, day: today } });
  await call('/api/complete', { token: B.token, body: { lessonId: 'review-4', reviewed: 2, xp: 20, acc: 100, day: today } });
  sent = mark();
  ok(sent.length === 1 && sent[0].token === tok('a') && sent[0].body.kind === 'turn' && /practiced today/.test(sent[0].body.aps.alert.body), '"your turn" pushed to Ann once', sent.map(x => x.body.aps.alert.body));

  // turning friend notifications off stops pushes (the in-app note still arrives)
  await call('/api/state', { token: A.token, body: { state: { srs: {}, activeDays: [], prefs: { pushFriends: false } } } });
  mark = since();
  r = await call('/api/nudge', { token: C.token, body: { to: A.player.id } });
  ok(r.s === 200 && mark().length === 0, 'no push when friend notifications are off', r);
  r = await call('/api/inbox', { token: A.token }); ok(r.d.notes.some(n => n.kind === 'nudge'), 'the nudge is still in the inbox');

  // daily cap
  await call('/api/state', { token: A.token, body: { state: { srs: {}, activeDays: [], prefs: {} } } });
  mark = since();
  const pals = [];
  for (let i = 0; i < 9; i++) pals.push((await call('/api/join', { body: { code: A.code, name: 'P' + i + tag }, ip: RUN_IP.replace(/\.7$/, '.' + (20 + i)) })).d);
  for (const p of pals) await call('/api/nudge', { token: p.token, body: { to: A.player.id } });
  ok(mark().length <= 8, 'at most 8 pushes a day per player (counting earlier ones)', mark().length);

  // unregister, and a token moving to another account
  mark = since();
  await call('/api/push/unregister', { token: B.token, body: { token: tok('b') } });
  await call('/api/nudge', { token: pals[0].token, body: { to: B.player.id } });
  ok(mark().length === 0, 'unregistered phone gets nothing');
  await call('/api/push/register', { token: C.token, body: { token: tok('a') } });
  mark = since();
  await call('/api/nudge', { token: pals[1].token, body: { to: C.player.id } });
  sent = mark();
  ok(sent.length === 1 && sent[0].token === tok('a'), 'a phone signed in as someone else now gets their pushes', sent.length);
  // deleting an account forgets its phones
  await call('/api/account/delete', { token: C.token, body: {} });
  r = await call('/api/push/register', { token: pals[2].token, body: { token: tok('a') } }); ok(r.s === 200, 'token free after account deletion', r);
} finally { server.close(); }
console.log(`${pass} pass, ${failN} fail`); fails.forEach(x => console.log('FAIL', x));
process.exit(failN ? 1 : 0);
