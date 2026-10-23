// Course requests (Courses > Request a course) against a local `wrangler dev`: sign-in required, validation, storing,
// the per-player daily limit, and removal with the account. Locally there's no RESEND_API_KEY, so nothing is emailed.
// Run: node tests/course-request.test.mjs http://127.0.0.1:8799
import { randomBytes } from 'node:crypto';

const BASE = process.argv[2] || 'http://127.0.0.1:8799';
const IP = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
let pass = 0, failN = 0; const fails = [];
const ok = (cond, name, extra) => { if (cond) pass++; else { failN++; fails.push(name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 300) : '')); } };
async function call(path, { body, token, ip = IP } = {}) {
  const h = { 'CF-Connecting-IP': ip, Origin: 'http://localhost:8799' };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method: body !== undefined ? 'POST' : 'GET', headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  let d = null; const t = await r.text(); try { d = JSON.parse(t); } catch { d = t; }
  return { s: r.status, d };
}
const good = { topic: 'How the annual defense bill gets written', why: 'I staff a member on the Armed Services Committee.', level: 'intermediate', details: 'Markup, conference, the Rules Committee.', contact: 'someone@example.com' };

let r = await call('/api/course-request', { body: good });
ok(r.s === 401, 'a request needs an account', r);

r = await call('/api/account', { body: { name: 'Requester' } });
const token = r.d && r.d.token;
ok(r.s === 200 && token, 'made a test account', r.d);

for (const [bad, why] of [[{ ...good, topic: 'AI' }, 'topic too short'], [{ ...good, why: 'work' }, 'reason too short'], [{ ...good, level: 'expert' }, 'unknown level'], [{ ...good, contact: 'not an email' }, 'bad email']]) {
  r = await call('/api/course-request', { body: bad, token });
  ok(r.s === 400 && typeof r.d.error === 'string', 'rejects: ' + why, r);
}

r = await call('/api/course-request', { body: good, token });
ok(r.s === 200 && r.d.ok && r.d.id > 0 && r.d.emailed === false, 'stores a valid request (no email locally)', r.d);
r = await call('/api/course-request', { body: { ...good, contact: '', details: '' }, token });
ok(r.s === 200 && r.d.ok, 'contact and details are optional', r.d);
r = await call('/api/course-request', { body: { ...good, topic: 'x'.repeat(500), why: 'y'.repeat(5000) }, token });
ok(r.s === 200, 'long text is trimmed, not rejected', r.d);
r = await call('/api/course-request', { body: good, token });
ok(r.s === 429, 'the fourth request in a day is refused', r);

r = await call('/api/account/delete', { body: {}, token });
ok(r.s === 200, 'account deletion still works with requests on file', r);

console.log(`PASS ${pass}  FAIL ${failN}`); fails.forEach(f => console.log('FAIL', f));
process.exit(failN ? 1 : 0);
