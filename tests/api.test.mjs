// API tests for WonkoLingo against a local `wrangler dev` (local D1). Run: node api_test.mjs http://127.0.0.1:8799
const BASE = process.argv[2] || 'http://127.0.0.1:8799';
let pass = 0, failN = 0; const fails = [];
const ok = (cond, name, extra) => { if (cond) pass++; else { failN++; fails.push(name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 300) : '')); } };
async function call(path, { method, body, token, raw, headers = {} } = {}) {
  const h = { ...headers }; if (body !== undefined || raw !== undefined) h['Content-Type'] = 'application/json'; if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method: method || (body !== undefined || raw !== undefined ? 'POST' : 'GET'), headers: h, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
  let d = null; const t = await r.text(); try { d = JSON.parse(t); } catch { d = t; }
  return { s: r.status, d, h: r.headers };
}
const today = new Date().toISOString().slice(0, 10);
const course = (id, title = 'Test Course', extra = {}) => ({ format: 'wonkolingo-course/1', id, title, description: 'd', units: [{ title: 'U1', lessons: [{ title: 'L1', items: [
  { t: 'mc', p: 'Q1 <img src=x onerror=alert(1)>', o: ['a', 'b'], a: 0, x: 'because' },
  { t: 'recall', p: 'Q2', answer: 'ans', x: 'why' }] }] }], ...extra });

// --- basics
let r = await call('/api/nope', { method: 'OPTIONS', headers: { Origin: 'https://allintz.github.io' } }); ok(r.s === 204 && r.h.get('access-control-allow-origin') === 'https://allintz.github.io', 'OPTIONS CORS for the GitHub Pages copy', r.s);
r = await call('/api/nope', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }); ok(!r.h.get('access-control-allow-origin'), 'no CORS for other websites', r.h.get('access-control-allow-origin'));
r = await call('/api/nope'); ok(r.s === 401, 'unknown route without auth -> 401', r);
r = await call('/'); ok(r.s === 200 && String(r.d).includes('const GLOSSARY'), 'static index served with glossary');
r = await call('/course-guide.md'); ok(r.s === 200, 'course guide served');
r = await call('/mascot/think.webp'); ok(r.s === 200, 'mascot served');

// --- groups
r = await call('/api/groups', { body: {} }); ok(r.s === 400, 'create group: missing names -> 400', r);
r = await call('/api/groups', { body: { groupName: '   ', name: 'x' } }); ok(r.s === 400, 'create group: whitespace name -> 400', r);
r = await call('/api/groups', { raw: '{bad json' }); ok(r.s === 400, 'create group: bad json -> 400', r);
r = await call('/api/groups', { body: { groupName: '<b>Testers</b>' + 'x'.repeat(80), name: 'Alice<script>' } });
ok(r.s === 200 && r.d.code && r.d.token, 'create group ok', r);
ok(!/[<>]/.test(r.d.groupName) && r.d.groupName.length <= 40, 'group name cleaned and capped', r.d.groupName);
ok(r.d.player.name === 'Alicescript', 'player name strips angle brackets', r.d.player.name);
const A = r.d; const code = A.code;
r = await call('/api/groups/' + code.toLowerCase()); ok(r.s === 200 && r.d.members === 1, 'public group lookup (lowercase code)', r);
r = await call('/api/groups/ZZZZZZ'); ok(r.s === 404, 'lookup unknown group -> 404', r);

// --- join
r = await call('/api/join', { body: { code, name: '' } }); ok(r.s === 400, 'join: empty name -> 400', r);
r = await call('/api/join', { body: { code: 'ZZZZZZ', name: 'Bob' } }); ok(r.s === 404, 'join: bad code -> 404', r);
r = await call('/api/join', { body: { code: code.toLowerCase(), name: 'Bob' } }); ok(r.s === 200, 'join ok (lowercase code)', r);
const B = r.d;
r = await call('/api/join', { body: { code, name: 'BOB' } }); ok(r.s === 409, 'join: duplicate name case-insensitive -> 409', r);
r = await call('/api/groups', { body: { groupName: 'Other', name: 'Carol' } }); const C = r.d;

// --- auth
r = await call('/api/me', { token: 'garbage' }); ok(r.s === 401, 'me: garbage token -> 401');
r = await call('/api/me', { token: A.player.id + '.wrongsecret' }); ok(r.s === 401, 'me: wrong secret -> 401');
r = await call('/api/me', { token: A.token }); ok(r.s === 200 && r.d.player.id === A.player.id && r.d.code === code, 'me ok', r);
r = await call('/api/me', { token: A.token, headers: { Authorization: 'Bearer ' + A.token + ' ' } }); ok(r.s === 200, 'me: trailing space in header tolerated', r.s);

// --- completions + board
r = await call('/api/complete', { token: A.token, body: { lessonId: 'au0l0', title: 'L', xp: 99999, acc: 250, day: 'not-a-day' } }); ok(r.s === 400, 'complete: bad day -> 400', r);
r = await call('/api/complete', { token: A.token, body: { lessonId: 'au0l0', title: 'Lesson <x>', xp: 99999, acc: 250, day: today } }); ok(r.s === 200, 'complete ok', r);
r = await call('/api/complete', { token: A.token, body: { lessonId: 'au0l0', title: 'Lesson', xp: 10, acc: 50, day: today } }); ok(r.s === 200, 'complete dup within minute ok (ignored)', r);
r = await call('/api/complete', { token: B.token, body: { lessonId: 'review-1', title: 'review', xp: -50, acc: -3, day: today } }); ok(r.s === 200, 'complete negative xp ok', r);
r = await call('/api/board?today=' + today, { token: A.token });
ok(r.s === 200 && r.d.players.length === 2, 'board lists 2 players', r.d);
const pa = r.d.players.find(p => p.id === A.player.id), pb = r.d.players.find(p => p.id === B.player.id);
ok(pa && pa.week === 500 && pa.total === 500, 'xp clamped to 500 and dup ignored', pa);
ok(pb && pb.week === 0, 'negative xp clamped to 0', pb);
ok(pa && pa.streak === 1, 'streak from completions = 1', pa);
ok(r.d.feed.length === 2 && !/[<>]/.test(r.d.feed.map(f => f.title).join('')), 'feed has 2 entries with cleaned titles', r.d.feed);
r = await call('/api/board?today=garbage', { token: A.token }); ok(r.s === 200, 'board tolerates bad today param', r.s);
r = await call('/api/board', { token: C.token }); ok(r.s === 200 && r.d.players.length === 1 && r.d.feed.length === 0, 'board isolated by group', r.d);

// --- state sync
r = await call('/api/state', { token: A.token }); ok(r.s === 200 && r.d.state === null, 'state initially null', r);
r = await call('/api/state', { token: A.token, body: { state: [] } }); ok(r.s === 400, 'state: array rejected', r);
r = await call('/api/state', { token: A.token, body: { state: { srs: null } } }); ok(r.s === 400 || r.s === 200, 'state: srs null handled (typeof null is object)', r);
r = await call('/api/state', { token: A.token, raw: 'x' }); ok(r.s === 400, 'state: bad json', r);
r = await call('/api/state', { token: A.token, raw: JSON.stringify({ state: { srs: {}, pad: 'x'.repeat(810000) } }) }); ok(r.s === 413, 'state: too large -> 413', r.s);
const st = { v: 1, srs: { 'au0l0#0': { s: 1, d: 5, last: today, due: today, ivl: 1, reps: 1, lapses: 0 } }, activeDays: [today, '2026-10-01'], settings: { days: [true, true, true, true, true, true, true], pauses: [] }, xp: 12 };
r = await call('/api/state', { token: A.token, body: { state: st } }); ok(r.s === 200, 'state save ok', r);
r = await call('/api/state', { token: A.token }); ok(r.s === 200 && JSON.stringify(r.d.state) === JSON.stringify(st), 'state roundtrip exact', r.d);
r = await call('/api/board?today=' + today, { token: A.token }); ok(r.d.players.find(p => p.id === A.player.id).streak === 1, 'board uses synced activeDays', r.d.players);
r = await call('/api/state', { token: B.token }); ok(r.d.state === null, 'state isolated per player', r.d);

// --- courses
r = await call('/api/courses', { token: A.token }); ok(r.s === 200 && r.d.courses.length === 0, 'no courses initially', r);
r = await call('/api/courses', { token: A.token, body: { course: { format: 'nope' } } }); ok(r.s === 422 && Array.isArray(r.d.errors), 'invalid course -> 422 with errors', r);
r = await call('/api/courses', { token: A.token, body: { course: course('Bad ID!') } }); ok(r.s === 422, 'bad slug -> 422', r);
r = await call('/api/courses', { token: A.token, raw: JSON.stringify({ course: course('big', 'Big', { description: 'x'.repeat(210000) }) }) }); ok(r.s === 413, 'oversized course -> 413', r.s);
r = await call('/api/courses', { token: A.token, body: { course: course('test-one','Test Course',{category:'policy'}) } }); ok(r.s === 200 && r.d.version === 1 && !r.d.updated, 'publish course', r);
r = await call('/api/courses', { token: A.token, body: { course: course('test-one', 'Renamed') } }); ok(r.s === 200 && r.d.version === 2 && r.d.updated, 'author update bumps version', r);
r = await call('/api/courses', { token: B.token, body: { course: course('test-one','Test Course',{category:'policy'}) } }); ok(r.s === 409, 'other member same id -> 409', r);
r = await call('/api/courses', { token: C.token, body: { course: course('test-one','Test Course',{category:'policy'}) } }); ok(r.s === 200, 'same id in another group allowed', r);
r = await call('/api/courses', { token: B.token }); ok(r.s === 200 && r.d.courses.length === 1 && r.d.courses[0].title === 'Renamed' && r.d.courses[0].author === 'Alicescript', 'member sees group course', r.d);
const stored = r.d.courses[0].course; ok(stored.units[0].lessons[0].items[0].p.includes('<img'), 'course text stored raw (client must escape)');
// reports
r = await call('/api/courses', { token:A.token,body:{course:course('test-one','Test Course',{categories:['policy','other'],categoryLabel:'Economics'})} }); ok(r.s===200,'category update accepted',r);
r = await call('/api/courses', {token:A.token});ok(r.d.courses.some(x=>x.course.categories?.includes('policy')&&x.course.categories?.includes('other')&&x.course.categoryLabel==='Economics'),'multiple tags and custom label survive API storage');
r = await call('/api/courses', {token:A.token,body:{course:course('bad-tags','Bad',{categories:['policy','invalid']})}});ok(r.s===422,'invalid subject tag rejected by server',r.s);
r = await call('/api/courses', {token:A.token,body:{course:course('bad-category','Bad',{category:'invalid'})}});ok(r.s===422,'invalid category rejected by server',r.s);
r = await call('/api/courses/test-one/reports', { token: B.token, body: { note: '' } }); ok(r.s === 400, 'report: empty note -> 400', r);
r = await call('/api/courses/test-one/reports', { token: B.token, body: { note: 'Wrong <b>answer</b>', itemText: 'Q1', lessonId: 'c:test-one:u0l0' } }); ok(r.s === 200, 'report ok', r);
r = await call('/api/courses/test-one/reports', { token: B.token }); ok(r.s === 403, 'non-author cannot list reports', r);
r = await call('/api/courses/test-one/reports', { token: A.token }); ok(r.s === 200 && r.d.reports.length === 1 && !/[<>]/.test(r.d.reports[0].note), 'author lists reports, note cleaned', r.d);
const repId = r.d.reports[0] && r.d.reports[0].id;
r = await call('/api/courses', { token: B.token }); ok(r.d.courses[0].openReports === 1, 'openReports count = 1', r.d.courses[0]);
r = await call(`/api/reports/${repId}/resolve`, { token: B.token, body: {} }); ok(r.s === 404, 'non-author cannot resolve', r);
r = await call(`/api/reports/${repId}/resolve`, { token: C.token, body: {} }); ok(r.s === 404, 'other group cannot resolve', r);
r = await call(`/api/reports/${repId}/resolve`, { token: A.token, body: {} }); ok(r.s === 200, 'author resolves', r);
r = await call('/api/courses/test-one/reports', { token: A.token }); ok(r.d.reports.length === 0, 'resolved report hidden', r.d);
r = await call('/api/courses/nope-nope/reports', { token: A.token, body: { note: 'x' } }); ok(r.s === 404, 'report on missing course -> 404', r);
r = await call('/api/courses/test-one/delete', { token: B.token, body: {} }); ok(r.s === 403, 'non-author cannot delete', r);
r = await call('/api/courses/test-one/delete', { token: A.token, body: {} }); ok(r.s === 200, 'author deletes', r);
r = await call('/api/courses', { token: A.token }); ok(r.d.courses.length === 0, 'deleted course gone', r.d);
r = await call('/api/courses', { token: C.token }); ok(r.d.courses.length === 1, 'other group course untouched', r.d);

// --- grading endpoints without an API key (local) and validation
r = await call('/api/grade', { body: { question: 'q', answer: 'a', response: '' } }); ok(r.s === 200 && r.d.score === 0 || r.s === 503, 'grade: empty response handled', r);
r = await call('/api/grade', { body: { question: 'q', answer: 'a', response: 'something' } }); ok([503, 200].includes(r.s), 'grade without key -> 503 (or graded if key present)', r);
r = await call('/api/hint', { body: { question: '', answer: '' } }); ok([400, 503].includes(r.s), 'hint: missing fields', r);
r = await call('/api/dispute', { body: { question: 'q', answer: 'a' } }); ok([400, 503].includes(r.s), 'dispute: missing response', r);

r = await call('/api/define', { body: { term: 'x' } }); ok([400, 503].includes(r.s), 'define: too-short term or no key', r);
r = await call('/api/define', { body: { term: 'statutory duty of care', context: 'q' } }); ok([200, 503].includes(r.s), 'define: ok or no key locally', r);
console.log(`PASS ${pass}  FAIL ${failN}`); fails.forEach(f => console.log('FAIL', f));
