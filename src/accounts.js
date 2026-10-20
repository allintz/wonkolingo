// Accounts: every player has one, in a group or not. Sign-in on another device by passkey or a short code;
// the original token is the recovery code. Players outside a group live in a private one-person "home" group.
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const SECRET_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
// Origins allowed to use passkeys; the passkey's site (rpID) is the origin's hostname.
const PASSKEY_ORIGINS = ['https://wonkolingo.alex-l-lintz.workers.dev', 'http://localhost:8799', 'http://localhost:8791'];
export const ACCOUNT_LIMITS = { newAccountsPerIpPerDay: 20, codeClaimsPerIpPerHour: 10, passkeysPerPlayer: 10, codeMinutes: 10 };

export function randomString(n, alphabet) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}
export async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));

// A private, unjoinable group for a player who isn't in a real group. Its code is long so it can't be guessed.
export async function createHomeGroup(env) {
  const code = 'H' + randomString(15, CODE_ALPHABET);
  await env.DB.prepare('INSERT INTO groups (code, name, created_at, solo) VALUES (?, ?, ?, 1)').bind(code, '', Date.now()).run();
  return code;
}
// A new secret for an existing player (another device). Returns the full token.
export async function newSession(env, playerId, label) {
  const secret = randomString(24, SECRET_ALPHABET);
  await env.DB.prepare('INSERT INTO sessions (player_id, key_hash, label, created_at) VALUES (?, ?, ?, ?)').bind(playerId, await sha256(secret), String(label || '').slice(0, 40), Date.now()).run();
  return playerId + '.' + secret;
}
async function takeRate(env, key, max, period) {
  const bucket = period === 'hour' ? new Date().toISOString().slice(0, 13) : new Date().toISOString().slice(0, 10);
  const r = await env.DB.prepare('SELECT n FROM rate_limits WHERE key = ? AND day = ?').bind(key, bucket).first();
  if (r && r.n >= max) return false;
  await env.DB.prepare('INSERT INTO rate_limits (key, day, n) VALUES (?, ?, 1) ON CONFLICT(key, day) DO UPDATE SET n = n + 1').bind(key, bucket).run();
  return true;
}
const ipKey = async (req, prefix) => prefix + ':' + (await sha256('wl-acct:' + (req.headers.get('CF-Connecting-IP') || 'unknown'))).slice(0, 16);
const passkeySite = req => {
  const origin = req.headers.get('Origin') || '';
  return PASSKEY_ORIGINS.includes(origin) ? { origin, rpID: new URL(origin).hostname } : null;
};
// What the client needs to know about a signed-in player.
export async function accountInfo(env, p) {
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE player_id = ?').bind(p.id).first();
  return { player: { id: p.id, name: p.name }, group: p.solo ? null : { code: p.group_code, groupName: p.group_name }, passkeys: n.n };
}
async function playerById(env, id) {
  return env.DB.prepare('SELECT p.id, p.name, p.group_code, g.name AS group_name, g.solo FROM players p JOIN groups g ON g.code = p.group_code WHERE p.id = ?').bind(id).first();
}

// Routes that work without a signed-in player. Returns a Response, or null if the path isn't ours.
export async function publicAccountApi(req, env, path, { json, fail, body }) {
  const m = req.method;
  // A new account with no group. Created by the app the first time a player has progress worth saving.
  if (m === 'POST' && path === '/api/account') {
    if (!await takeRate(env, await ipKey(req, 'acct'), ACCOUNT_LIMITS.newAccountsPerIpPerDay, 'day')) return fail('Too many new accounts from this network today. Try again tomorrow.', 429);
    const code = await createHomeGroup(env);
    const id = randomString(10, ID_ALPHABET), secret = randomString(24, SECRET_ALPHABET);
    await env.DB.prepare('INSERT INTO players (id, group_code, name, key_hash, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, code, 'Player', await sha256(secret), Date.now()).run();
    return json({ token: id + '.' + secret, player: { id, name: 'Player' }, group: null, passkeys: 0 });
  }
  // Sign in with a code shown on a device that is already signed in.
  if (m === 'POST' && path === '/api/link/claim') {
    if (!await takeRate(env, await ipKey(req, 'claim'), ACCOUNT_LIMITS.codeClaimsPerIpPerHour, 'hour')) return fail('Too many code attempts. Wait an hour and try again.', 429);
    const b = await body(req);
    const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const row = code.length === 8 && await env.DB.prepare('SELECT player_id, expires, used FROM link_codes WHERE code = ?').bind(code).first();
    if (!row || row.used || row.expires < Date.now()) return fail('That code isn’t valid or has expired. Get a new one on your other device.', 404);
    await env.DB.prepare('UPDATE link_codes SET used = 1 WHERE code = ?').bind(code).run();
    const p = await playerById(env, row.player_id);
    if (!p) return fail('That account no longer exists.', 404);
    return json({ token: await newSession(env, p.id, 'code'), ...(await accountInfo(env, p)) });
  }
  // Passkey sign-in, step 1: a challenge for any passkey saved for this site.
  if (m === 'POST' && path === '/api/passkey/login-options') {
    const site = passkeySite(req); if (!site) return fail('Passkeys work only on the main WonkoLingo site.', 400);
    const opts = await generateAuthenticationOptions({ rpID: site.rpID, userVerification: 'preferred' });
    const cid = randomString(16, ID_ALPHABET);
    await env.DB.prepare('INSERT INTO webauthn_challenges (id, player_id, challenge, kind, expires) VALUES (?, NULL, ?, ?, ?)').bind(cid, opts.challenge, 'login', Date.now() + 5 * 60000).run();
    return json({ challengeId: cid, options: opts });
  }
  // Passkey sign-in, step 2: check the signature and issue a token for this device.
  if (m === 'POST' && path === '/api/passkey/login') {
    const site = passkeySite(req); if (!site) return fail('Passkeys work only on the main WonkoLingo site.', 400);
    const b = await body(req);
    const ch = await env.DB.prepare('SELECT challenge, kind, expires FROM webauthn_challenges WHERE id = ?').bind(String(b.challengeId || '')).first();
    if (!ch || ch.kind !== 'login' || ch.expires < Date.now()) return fail('The sign-in request expired. Try again.', 400);
    await env.DB.prepare('DELETE FROM webauthn_challenges WHERE id = ?').bind(String(b.challengeId)).run();
    const resp = b.response;
    const cred = resp && resp.id && await env.DB.prepare('SELECT id, player_id, public_key, counter, transports FROM passkeys WHERE id = ?').bind(String(resp.id)).first();
    if (!cred) return fail('This passkey isn’t linked to a WonkoLingo account. It may have been made for a different account or removed.', 404);
    let v;
    try {
      v = await verifyAuthenticationResponse({ response: resp, expectedChallenge: ch.challenge, expectedOrigin: site.origin, expectedRPID: site.rpID, requireUserVerification: false,
        credential: { id: cred.id, publicKey: fromB64url(cred.public_key), counter: cred.counter, transports: JSON.parse(cred.transports || '[]') } });
    } catch (e) { return fail('The passkey couldn’t be verified.', 400); }
    if (!v.verified) return fail('The passkey couldn’t be verified.', 400);
    await env.DB.prepare('UPDATE passkeys SET counter = ?, last_used = ? WHERE id = ?').bind(v.authenticationInfo.newCounter, Date.now(), cred.id).run();
    const p = await playerById(env, cred.player_id);
    if (!p) return fail('That account no longer exists.', 404);
    return json({ token: await newSession(env, p.id, 'passkey'), ...(await accountInfo(env, p)) });
  }
  return null;
}

// Routes for a signed-in player (`me` from auth()).
export async function accountApi(req, env, path, me, { json, fail, body }) {
  const m = req.method;
  if (m === 'POST' && path === '/api/link') {
    await env.DB.prepare('DELETE FROM link_codes WHERE expires < ?').bind(Date.now()).run();
    const code = randomString(8, CODE_ALPHABET), expires = Date.now() + ACCOUNT_LIMITS.codeMinutes * 60000;
    await env.DB.prepare('INSERT INTO link_codes (code, player_id, expires) VALUES (?, ?, ?)').bind(code, me.id, expires).run();
    return json({ code, expires });
  }
  // Leave a group but keep the account and its progress.
  if (m === 'POST' && path === '/api/leave') {
    if (me.solo) return json({ ok: true });
    const code = await createHomeGroup(env);
    await env.DB.prepare('UPDATE players SET group_code = ? WHERE id = ?').bind(code, me.id).run();
    return json({ ok: true });
  }
  if (m === 'POST' && path === '/api/passkey/register-options') {
    const site = passkeySite(req); if (!site) return fail('Passkeys work only on the main WonkoLingo site.', 400);
    const existing = await env.DB.prepare('SELECT id, transports FROM passkeys WHERE player_id = ?').bind(me.id).all();
    if (existing.results.length >= ACCOUNT_LIMITS.passkeysPerPlayer) return fail('This account already has the most passkeys allowed.', 403);
    const opts = await generateRegistrationOptions({
      rpName: 'WonkoLingo', rpID: site.rpID, userID: new TextEncoder().encode(me.id),
      userName: (me.solo ? 'WonkoLingo player' : me.name) + ' (' + me.id.slice(0, 4) + ')', userDisplayName: me.name,
      attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      excludeCredentials: existing.results.map(c => ({ id: c.id, transports: JSON.parse(c.transports || '[]') })),
    });
    const cid = randomString(16, ID_ALPHABET);
    await env.DB.prepare('INSERT INTO webauthn_challenges (id, player_id, challenge, kind, expires) VALUES (?, ?, ?, ?, ?)').bind(cid, me.id, opts.challenge, 'register', Date.now() + 5 * 60000).run();
    return json({ challengeId: cid, options: opts });
  }
  if (m === 'POST' && path === '/api/passkey/register') {
    const site = passkeySite(req); if (!site) return fail('Passkeys work only on the main WonkoLingo site.', 400);
    const b = await body(req);
    const ch = await env.DB.prepare('SELECT player_id, challenge, kind, expires FROM webauthn_challenges WHERE id = ?').bind(String(b.challengeId || '')).first();
    if (!ch || ch.kind !== 'register' || ch.player_id !== me.id || ch.expires < Date.now()) return fail('The passkey request expired. Try again.', 400);
    await env.DB.prepare('DELETE FROM webauthn_challenges WHERE id = ?').bind(String(b.challengeId)).run();
    let v;
    try { v = await verifyRegistrationResponse({ response: b.response, expectedChallenge: ch.challenge, expectedOrigin: site.origin, expectedRPID: site.rpID, requireUserVerification: false }); }
    catch (e) { return fail('The passkey couldn’t be saved.', 400); }
    if (!v.verified) return fail('The passkey couldn’t be saved.', 400);
    const c = v.registrationInfo.credential;
    await env.DB.prepare('INSERT OR REPLACE INTO passkeys (id, player_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(c.id, me.id, b64url(c.publicKey), c.counter || 0, JSON.stringify(c.transports || (b.response.response && b.response.response.transports) || []), Date.now()).run();
    return json({ ok: true, passkeys: (await env.DB.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE player_id = ?').bind(me.id).first()).n });
  }
  return null;
}
