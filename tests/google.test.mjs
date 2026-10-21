// Sign in with Google, against a LOCAL server started with the test key (see tests/README.md):
//   --var GOOGLE_CLIENT_ID:test-client.apps.googleusercontent.com --var "GOOGLE_TEST_JWKS:<jwks from google-test-key.json>"
// Tokens are signed here with the test key, the way Google would sign them.
import { createSign, createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = (process.argv[2] || 'http://127.0.0.1:8795').replace(/\/$/, '');
const KEY = JSON.parse(readFileSync(new URL('./google-test-key.json', import.meta.url)));
const AUD = 'test-client.apps.googleusercontent.com';
let pass = 0; const fails = [];
const ok = (c, m, d) => { if (c) pass++; else { fails.push(m + (d !== undefined ? ' ' + JSON.stringify(d).slice(0, 300) : '')); } };
const rnd = () => Math.random().toString(36).slice(2, 8);
const b64 = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function token(claims, { kid = 'wl-test', alg = 'RS256' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg, kid, typ: 'JWT' }), body = b64({ iss: 'https://accounts.google.com', aud: AUD, iat: now, exp: now + 3600, ...claims });
  const sig = createSign('RSA-SHA256').update(head + '.' + body).sign(createPrivateKey({ key: KEY.private, format: 'jwk' })).toString('base64url');
  return head + '.' + body + '.' + sig;
}
async function call(path, body, tok) {
  const r = await fetch(BASE + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:8795', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { s: r.status, d: await r.json().catch(() => ({})) };
}

let r = await call('/api/config');
ok(r.d.google === AUD, 'config names the Google client', r.d);

const sub = 'g' + rnd() + rnd();
r = await call('/api/google', { credential: token({ sub, email: sub + '@example.com', email_verified: true, given_name: 'Gina' }) });
ok(r.s === 200 && r.d.created && r.d.token && r.d.player.name === 'Gina' && r.d.google === sub + '@example.com', 'first Google sign-in makes an account named after the profile', r);
const first = r.d;
r = await call('/api/google', { credential: token({ sub, email: sub + '@example.com', email_verified: true }) });
ok(r.s === 200 && !r.d.created && r.d.player.id === first.player.id && r.d.token !== first.token, 'second sign-in reaches the same account on a new session', r);
r = await call('/api/me', null, r.d.token);
ok(r.s === 200 && r.d.google === sub + '@example.com', '/api/me reports the Google account', r.d);

// Bad tokens
const bad = [
  ['wrong audience', token({ sub, aud: 'someone-else' })],
  ['expired', token({ sub, exp: Math.floor(Date.now() / 1000) - 10 })],
  ['wrong issuer', token({ sub, iss: 'https://evil.example' })],
  ['unknown key id', token({ sub }, { kid: 'nope' })],
  ['tampered body', (() => { const t = token({ sub: 'x' + rnd() }).split('.'); t[1] = b64({ iss: 'https://accounts.google.com', aud: AUD, sub, exp: 9e9, iat: 1 }); return t.join('.'); })()],
  ['alg none', b64({ alg: 'none', kid: 'wl-test' }) + '.' + b64({ iss: 'accounts.google.com', aud: AUD, sub, exp: 9e9, iat: 1 }) + '.'],
  ['garbage', 'not.a.token'],
  ['missing', undefined]
];
for (const [what, t] of bad) { r = await call('/api/google', { credential: t }); ok(r.s === 401, `rejects ${what}`, r); }

// Connecting Google to an existing password account, then signing in with it.
const u = 'gu' + rnd();
r = await call('/api/account', { name: 'Pat', username: u, password: 'password ' + rnd() });
const pat = r.d;
const sub2 = 'g' + rnd() + rnd();
r = await call('/api/google', { credential: token({ sub: sub2, email: 'pat@example.com', email_verified: true }) }, pat.token);
ok(r.s === 200 && r.d.ok && r.d.google === 'pat@example.com', 'a signed-in player connects Google', r);
r = await call('/api/google', { credential: token({ sub: sub2 }) });
ok(r.s === 200 && r.d.player.id === pat.player.id && r.d.username === u, 'that Google account then signs in to the password account', r.d);
r = await call('/api/google', { credential: token({ sub }) }, pat.token);
ok(r.s === 409, 'a Google account used by another player cannot be connected', r);
// A verified email already confirmed on an account links to it instead of making a new account: covered by email tests'
// setup, which needs the email test server; checked here only that an unverified email doesn't link anything.
r = await call('/api/google', { credential: token({ sub: 'g' + rnd() + rnd(), email: 'pat@example.com', email_verified: false }) });
ok(r.s === 200 && r.d.created && r.d.player.id !== pat.player.id, 'an unverified email never links to another account', r.d);

// Deleting the account frees the Google account.
r = await call('/api/account/delete', {}, first.token);
ok(r.s === 200, 'account deleted', r);
r = await call('/api/google', { credential: token({ sub, email_verified: false }) });
ok(r.s === 200 && r.d.created && r.d.player.id !== first.player.id, 'after deletion the same Google account makes a fresh account', r.d);

// GET is not a sign-in
r = await call('/api/google');
ok(r.s === 404, 'GET /api/google is not found', r);

console.log(`PASS ${pass}  FAIL ${fails.length}`); fails.forEach(f => console.log('FAIL', f));
process.exit(fails.length ? 1 : 0);
