// Email tests against a LOCAL `wrangler dev` started in email test mode (codes come back in the response instead of
// being sent):
//   wrangler dev --local --port 8791 --ip 127.0.0.1 --compatibility-date 2026-04-17 --var EMAIL_TEST_MODE:1
// Run: node tests/email.test.mjs http://127.0.0.1:8791
import { randomBytes } from 'node:crypto';

const BASE = process.argv[2] || 'http://127.0.0.1:8791';
if (/workers\.dev/.test(BASE)) { console.error('Local server only.'); process.exit(2); }
const net = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
let pass = 0, failN = 0; const fails = [];
const ok = (cond, name, extra) => { if (cond) pass++; else { failN++; fails.push(name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 300) : '')); } };
async function call(path, { body, token, ip = net() } = {}) {
  const h = { 'CF-Connecting-IP': ip, Origin: 'http://localhost:8791' };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method: body !== undefined ? 'POST' : 'GET', headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  let d = null; const t = await r.text(); try { d = JSON.parse(t); } catch { d = t; }
  return { s: r.status, d };
}
const tag = randomBytes(3).toString('hex'), addr = `pat.${tag}@example.com`;

let r = await call('/api/config'); ok(r.s === 200 && r.d.email === true, 'config says email is on in test mode', r.d);
const P = (await call('/api/account', { body: { name: 'Pat', username: 'em' + tag, password: 'correct horse 7' } })).d;
const Q = (await call('/api/account', { body: { name: 'Quinn' } })).d;

// ---- adding an email
r = await call('/api/email', { token: P.token, body: { email: 'not an email' } }); ok(r.s === 400, 'bad address refused', r);
r = await call('/api/email', { token: P.token, body: { email: '  PAT.' + tag.toUpperCase() + '@Example.com ' } }); ok(r.s === 200 && r.d.email === addr && /^\d{6}$/.test(r.d.devCode), 'code sent to a new address (stored lowercase)', r.d);
let code = r.d.devCode;
r = await call('/api/email/verify', { token: P.token, body: { code: code === '000000' ? '111111' : '000000' } }); ok(r.s === 400, 'wrong code refused', r);
r = await call('/api/email/verify', { token: P.token, body: { code } }); ok(r.s === 200 && r.d.email === addr, 'right code confirms the email', r.d);
r = await call('/api/email/verify', { token: P.token, body: { code } }); ok(r.s === 400, 'a code works only once', r);
r = await call('/api/me', { token: P.token }); ok(r.d.email === addr, 'account shows its email', r.d);

// ---- the same address can't be confirmed by a second account
r = await call('/api/email', { token: Q.token, body: { email: addr } }); const qcode = r.d.devCode;
r = await call('/api/email/verify', { token: Q.token, body: { code: qcode } }); ok(r.s === 409, 'an address linked to another account is refused', r);

// ---- a code dies after five wrong tries
r = await call('/api/email', { token: Q.token, body: { email: `q.${tag}@example.com` } }); const good = r.d.devCode;
for (let i = 0; i < 5; i++) await call('/api/email/verify', { token: Q.token, body: { code: String((+good + 1 + i) % 1000000).padStart(6, '0') } });
r = await call('/api/email/verify', { token: Q.token, body: { code: good } }); ok(r.s === 400, 'after five wrong tries even the right code fails', r);

// ---- signing in by email (a forgotten password)
r = await call('/api/email/signin-request', { body: { email: `nobody.${tag}@example.com` } }); ok(r.s === 200 && r.d.ok && !r.d.devCode, 'unknown address gets the same answer and no code', r.d);
r = await call('/api/email/signin-request', { body: { email: addr.toUpperCase() } }); ok(r.s === 200 && /^\d{6}$/.test(r.d.devCode), 'known address gets a sign-in code', r.d);
code = r.d.devCode;
r = await call('/api/email/signin', { body: { email: addr, code: '12 34 56' === code ? '654321' : '123456' } }); ok(r.s === 400, 'wrong sign-in code refused', r);
r = await call('/api/email/signin', { body: { email: addr, code: code.slice(0, 3) + ' ' + code.slice(3) } }); ok(r.s === 200 && r.d.token && r.d.player.id === P.player.id && r.d.email === addr, 'code signs in (spaces ignored)', r.d);
const fresh = r.d.token;
r = await call('/api/password', { token: fresh, body: { username: 'em' + tag, password: 'brand new pass 8' } }); ok(r.s === 200, 'after signing in by email, a new password can be set without the old one', r.d);
r = await call('/api/password/login', { body: { username: 'em' + tag, password: 'brand new pass 8' } }); ok(r.s === 200, 'the new password works', r.s);
r = await call('/api/email/signin', { body: { email: addr, code } }); ok(r.s === 400, 'a sign-in code works only once', r);

// ---- limits
const ip = net(); let limited = false;
const spam = `spam.${tag}@example.com`;
for (let i = 0; i < 7; i++) { r = await call('/api/email/signin-request', { body: { email: spam }, ip: net() }); if (r.s === 429) limited = true; }
ok(limited, 'codes to one address are limited even from many networks', r);
limited = false;
for (let i = 0; i < 22; i++) { r = await call('/api/email/signin-request', { body: { email: `n${i}.${tag}@example.com` }, ip }); if (r.s === 429) limited = true; }
ok(limited, 'one network asking for many codes is limited', r);

// ---- removing it, and account deletion
r = await call('/api/email/remove', { token: P.token, body: {} }); ok(r.s === 200, 'email removed', r);
r = await call('/api/me', { token: P.token }); ok(r.d.email === null, 'account no longer has an email', r.d);
r = await call('/api/email', { token: Q.token, body: { email: addr } }); r = await call('/api/email/verify', { token: Q.token, body: { code: r.d.devCode } }); ok(r.s === 200, 'a freed address can be used by another account', r);
r = await call('/api/account/delete', { token: Q.token, body: {} }); ok(r.s === 200, 'account with an email deletes', r);
r = await call('/api/email/signin-request', { body: { email: addr } }); ok(r.s === 200 && !r.d.devCode, 'a deleted account’s email no longer gets codes', r.d);

console.log(`PASS ${pass}  FAIL ${failN}`); fails.forEach(f => console.log('FAIL', f));
process.exit(failN ? 1 : 0);
