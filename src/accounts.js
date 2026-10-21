// Accounts: every player has one, in a group or not. Sign-in on another device by passkey or a short code;
// the original token is the recovery code. Players outside a group live in a private one-person "home" group.
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { moderate } from './grade.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const SECRET_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
// Origins allowed to use passkeys; the passkey's site (rpID) is the origin's hostname.
const PASSKEY_ORIGINS = ['https://wonkolingo.alex-l-lintz.workers.dev', 'http://localhost:8799', 'http://localhost:8791'];
export const ACCOUNT_LIMITS = { newAccountsPerIpPerDay: 20, codeClaimsPerIpPerHour: 10, passkeysPerPlayer: 10, codeMinutes: 10, passwordTriesPerIpPerHour: 30,
  passwordTriesPerNamePerIpPerHour: 10, passwordTriesPerNamePerHour: 100, passkeyLoginsPerIpPerHour: 60, groupLookupsPerIpPerHour: 60, freshSignInMinutes: 15 };
// AI screening of names and courses: a per-network and a site-wide daily cap, so screening can't run up the bill.
export const MOD_LIMITS = { perNetPerDay: 60, globalPerDay: 3000, chunk: 50000 };

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
// Counts one use and says whether it's within the limit. One statement, so parallel requests can't slip past the count.
export async function takeRate(env, key, max, period) {
  const bucket = period === 'hour' ? new Date().toISOString().slice(0, 13) : new Date().toISOString().slice(0, 10);
  const r = await env.DB.prepare('INSERT INTO rate_limits (key, day, n) VALUES (?, ?, 1) ON CONFLICT(key, day) DO UPDATE SET n = n + 1 RETURNING n').bind(key, bucket).first();
  return !r || r.n <= max;
}
// The visitor's network for per-network limits. An IPv6 user controls a whole /64, so those count as one network.
export function netId(req) {
  const ip = String(req.headers.get('CF-Connecting-IP') || 'unknown').trim().toLowerCase();
  if (!ip.includes(':')) return ip;
  let [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [], t = ip.includes('::') && tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return full.slice(0, 4).map(x => x.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
export const ipKey = async (req, prefix) => prefix + ':' + (await sha256('wl-acct:' + netId(req))).slice(0, 16);
// Screens text others will see, within the caps. Long text (a course) is screened in pieces, so nothing goes unchecked.
export async function screen(env, req, text) {
  if (!env.ANTHROPIC_API_KEY) return { allowed: true };
  const t = String(text || '');
  for (let i = 0; i < t.length || i === 0; i += MOD_LIMITS.chunk) {
    if (!await takeRate(env, await ipKey(req, 'mod'), MOD_LIMITS.perNetPerDay, 'day') || !await takeRate(env, 'mod:all', MOD_LIMITS.globalPerDay, 'day'))
      return { allowed: false, capped: true, reason: 'Too many posts from this network today. Try again tomorrow.' };
    const r = await moderate(env, t.slice(i, i + MOD_LIMITS.chunk));
    if (!r.allowed) return r;
  }
  return { allowed: true };
}
export const screenFail = (fail, mod, what) => mod.capped ? fail(mod.reason, 429) : fail(what + mod.reason, 422);
const passkeySite = req => {
  const origin = req.headers.get('Origin') || '';
  // The iPhone app (pages served from capacitor://localhost) uses the live site's passkeys through Apple's associated
  // domains, and iOS signs those with the site's own https origin.
  if (origin === 'capacitor://localhost') return { origin: PASSKEY_ORIGINS[0], rpID: new URL(PASSKEY_ORIGINS[0]).hostname, app: true };
  return PASSKEY_ORIGINS.includes(origin) ? { origin, rpID: new URL(origin).hostname } : null;
};
// The origins a passkey response may carry. For the iPhone app, iOS is expected to use the site's https origin; an
// origin naming this app is accepted too, and anything else is logged so a mismatch shows up in `wrangler tail`.
function expectedOrigins(site, resp) {
  if (!site.app) return site.origin;
  let o = '';
  try { o = JSON.parse(new TextDecoder().decode(fromB64url(String(resp.response.clientDataJSON)))).origin || ''; } catch (e) {}
  if (o && o !== site.origin) console.log('passkey from app with origin', o);
  return /^(ios:bundle-id:)?(29B8GL5NYV\.)?com\.alexlintz\.wonkolingo$/.test(o) ? [site.origin, o] : site.origin;
}
// What the client needs to know about a signed-in player.
export async function accountInfo(env, p) {
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE player_id = ?').bind(p.id).first();
  const pw = await env.DB.prepare('SELECT username FROM passwords WHERE player_id = ?').bind(p.id).first();
  const em = await env.DB.prepare('SELECT email FROM emails WHERE player_id = ?').bind(p.id).first();
  const ids = (await env.DB.prepare('SELECT provider, email FROM sign_in_ids WHERE player_id = ?').bind(p.id).all()).results;
  const via = pr => { const r = ids.find(x => x.provider === pr); return r ? r.email || 'connected' : null; };
  return { player: { id: p.id, name: p.name }, group: p.solo ? null : { code: p.group_code, groupName: p.group_name }, passkeys: n.n, username: pw ? pw.username : null, email: em ? em.email : null, google: via('google'), apple: via('apple') };
}

// Usernames and passwords. A forgotten password is reset by signing in another way (an emailed code, a passkey, a code
// from another device) and then setting a new one.
const PBKDF2_ITERATIONS = 100000; // the most Workers allow
const cleanUsername = s => String(s || '').trim().toLowerCase();
function usernameProblem(u) {
  if (u.length < 3 || u.length > 40) return 'Pick a username of 3 to 40 characters.';
  if (!/^[a-z0-9._@+-]+$/.test(u)) return 'Usernames can use letters, numbers and . _ - + @ (no spaces).';
  return '';
}
const passwordProblem = pw => typeof pw !== 'string' || pw.length < 8 ? 'Use a password of at least 8 characters.' : pw.length > 200 ? 'That password is too long.' : '';
async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(await pbkdf2(password, salt, PBKDF2_ITERATIONS))}`;
}
// Same cost as a real check, so a missing username takes as long as a wrong password.
const DUMMY_HASH = 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
async function checkPassword(password, stored) {
  const [kind, iters, salt, hash] = String(stored).split('$');
  if (kind !== 'pbkdf2') return false;
  const got = b64url(await pbkdf2(password, fromB64url(salt), +iters));
  let diff = got.length ^ hash.length;
  for (let i = 0; i < Math.min(got.length, hash.length); i++) diff |= got.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}
// Sets (or changes) an account's username and password. Returns an error message, or '' on success.
async function setPassword(env, playerId, username, password) {
  const u = cleanUsername(username), up = usernameProblem(u) || passwordProblem(password);
  if (up) return up;
  const taken = await env.DB.prepare('SELECT player_id FROM passwords WHERE username = ?').bind(u).first();
  if (taken && taken.player_id !== playerId) return 'That username is taken. Try another.';
  await env.DB.prepare('INSERT INTO passwords (player_id, username, hash, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET username = excluded.username, hash = excluded.hash, updated_at = excluded.updated_at')
    .bind(playerId, u, await hashPassword(password), Date.now()).run();
  return '';
}
// One limit on new accounts per network, whichever route makes them (sign-up, or starting or joining a group signed out).
export const takeNewAccount = async (env, req) => takeRate(env, await ipKey(req, 'acct'), ACCOUNT_LIMITS.newAccountsPerIpPerDay, 'day');
// Signed in on this device in the last few minutes (a fresh passkey, code, password or email sign-in).
const isFresh = me => me.via === 'session' && me.sessionAt > Date.now() - ACCOUNT_LIMITS.freshSignInMinutes * 60000;
export async function playerById(env, id) {
  return env.DB.prepare('SELECT p.id, p.name, p.group_code, g.name AS group_name, g.solo FROM players p JOIN groups g ON g.code = p.group_code WHERE p.id = ?').bind(id).first();
}

// Routes that work without a signed-in player. Returns a Response, or null if the path isn't ours.
export async function publicAccountApi(req, env, path, { json, fail, body, cleanName }) {
  const m = req.method;
  // A new account with no group, made on the sign-up screen with the player's display name.
  if (m === 'POST' && path === '/api/account') {
    const b = await body(req);
    const name = cleanName(b.name, 24) || 'Player';
    // Optional username and password, checked before anything is created.
    const withPw = b.username !== undefined || b.password !== undefined;
    if (withPw) { const up = usernameProblem(cleanUsername(b.username)) || passwordProblem(b.password); if (up) return fail(up); }
    if (!await takeNewAccount(env, req)) return fail('Too many new accounts from this network today. Try again tomorrow.', 429);
    if (withPw && await env.DB.prepare('SELECT 1 FROM passwords WHERE username = ?').bind(cleanUsername(b.username)).first()) return fail('That username is taken. Try another.', 409);
    if (name !== 'Player') { const mod = await screen(env, req, `Display name: ${name}`); if (!mod.allowed) return screenFail(fail, mod, 'That name can’t be used: '); }
    const code = await createHomeGroup(env);
    const id = randomString(10, ID_ALPHABET), secret = randomString(24, SECRET_ALPHABET);
    await env.DB.prepare('INSERT INTO players (id, group_code, name, key_hash, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, code, name, await sha256(secret), Date.now()).run();
    let username = null;
    if (withPw) { const e = await setPassword(env, id, b.username, b.password); if (!e) username = cleanUsername(b.username); }
    return json({ token: id + '.' + secret, player: { id, name }, group: null, passkeys: 0, username });
  }
  // Sign in with a username and password.
  if (m === 'POST' && path === '/api/password/login') {
    const b = await body(req), u = cleanUsername(b.username);
    if (!u || typeof b.password !== 'string' || !b.password) return fail('Enter your username and password.');
    // Limits per network, per username from one network, and per username overall (high, so guessing from many
    // networks is slow but one attacker can't lock the owner out of their own account).
    const nameKey = (await sha256('wl-pw:' + u)).slice(0, 16);
    if (!await takeRate(env, await ipKey(req, 'pw'), ACCOUNT_LIMITS.passwordTriesPerIpPerHour, 'hour')
      || !await takeRate(env, await ipKey(req, 'pwname:' + nameKey), ACCOUNT_LIMITS.passwordTriesPerNamePerIpPerHour, 'hour')
      || !await takeRate(env, 'pwname:' + nameKey, ACCOUNT_LIMITS.passwordTriesPerNamePerHour, 'hour'))
      return fail('Too many sign-in attempts. Wait an hour, or sign in with a passkey or a code.', 429);
    const row = await env.DB.prepare('SELECT player_id, hash FROM passwords WHERE username = ?').bind(u).first();
    const good = await checkPassword(b.password, row ? row.hash : DUMMY_HASH);
    if (!row || !good) return fail('That username and password don’t match.', 401);
    const p = await playerById(env, row.player_id);
    if (!p) return fail('That account no longer exists.', 404);
    return json({ token: await newSession(env, p.id, 'password'), ...(await accountInfo(env, p)) });
  }
  // Sign in with a code shown on a device that is already signed in.
  if (m === 'POST' && path === '/api/link/claim') {
    if (!await takeRate(env, await ipKey(req, 'claim'), ACCOUNT_LIMITS.codeClaimsPerIpPerHour, 'hour')) return fail('Too many code attempts. Wait an hour and try again.', 429);
    const b = await body(req);
    const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    // Marking the code used is the check, so two devices can't both claim it.
    const row = code.length === 8 && await env.DB.prepare('UPDATE link_codes SET used = 1 WHERE code = ? AND used = 0 AND expires >= ? RETURNING player_id').bind(code, Date.now()).first();
    if (!row) return fail('That code isn’t valid or has expired. Get a new one on your other device.', 404);
    const p = await playerById(env, row.player_id);
    if (!p) return fail('That account no longer exists.', 404);
    return json({ token: await newSession(env, p.id, 'code'), ...(await accountInfo(env, p)) });
  }
  // Passkey sign-in, step 1: a challenge for any passkey saved for this site.
  if (m === 'POST' && path === '/api/passkey/login-options') {
    const site = passkeySite(req); if (!site) return fail('Passkeys work only on the main WonkoLingo site.', 400);
    if (!await takeRate(env, await ipKey(req, 'pkopt'), ACCOUNT_LIMITS.passkeyLoginsPerIpPerHour, 'hour')) return fail('Too many sign-in attempts. Wait a bit and try again.', 429);
    await env.DB.prepare('DELETE FROM webauthn_challenges WHERE expires < ?').bind(Date.now()).run();
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
      v = await verifyAuthenticationResponse({ response: resp, expectedChallenge: ch.challenge, expectedOrigin: expectedOrigins(site, resp), expectedRPID: site.rpID, requireUserVerification: false,
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
  // Delete the account and everything tied to it (App Store rule): progress, lesson results, courses written, sign-ins.
  if (m === 'POST' && path === '/api/account/delete') {
    const id = me.id, mine = await env.DB.prepare('SELECT id FROM courses WHERE author_id = ?').bind(id).all();
    const stmts = mine.results.map(c => env.DB.prepare('DELETE FROM reports WHERE course_id = ?').bind(c.id));
    for (const sql of ['DELETE FROM courses WHERE author_id = ?', 'DELETE FROM reports WHERE player_id = ?', 'DELETE FROM completions WHERE player_id = ?',
      'DELETE FROM player_state WHERE player_id = ?', 'DELETE FROM sessions WHERE player_id = ?', 'DELETE FROM passkeys WHERE player_id = ?',
      'DELETE FROM link_codes WHERE player_id = ?', 'DELETE FROM webauthn_challenges WHERE player_id = ?', 'DELETE FROM grade_usage WHERE player_id = ?',
      'DELETE FROM disputes WHERE who = ?', 'DELETE FROM card_feedback WHERE who = ?', 'DELETE FROM passwords WHERE player_id = ?',
      'DELETE FROM card_ratings WHERE who = ?', 'DELETE FROM session_feedback WHERE who = ?']) stmts.push(env.DB.prepare(sql).bind(id));
    stmts.push(env.DB.prepare('DELETE FROM blocks WHERE player_id = ? OR blocked_id = ?').bind(id, id), env.DB.prepare('DELETE FROM grade_usage WHERE player_id = ?').bind('dispute:' + id),
      env.DB.prepare('DELETE FROM rate_limits WHERE key = ?').bind('rm:' + id), env.DB.prepare('DELETE FROM emails WHERE player_id = ?').bind(id), env.DB.prepare('DELETE FROM email_codes WHERE player_id = ?').bind(id), env.DB.prepare('DELETE FROM sign_in_ids WHERE player_id = ?').bind(id),
      env.DB.prepare('DELETE FROM players WHERE id = ?').bind(id));
    if (me.solo) stmts.push(env.DB.prepare('DELETE FROM groups WHERE code = ? AND solo = 1').bind(me.group_code));
    await env.DB.batch(stmts);
    return json({ ok: true });
  }
  if (m === 'POST' && (path === '/api/block' || path === '/api/unblock')) {
    const other = String((await body(req)).playerId || '');
    if (!other || other === me.id) return fail('Pick someone else to block.');
    if (path === '/api/unblock') { await env.DB.prepare('DELETE FROM blocks WHERE player_id = ? AND blocked_id = ?').bind(me.id, other).run(); return json({ ok: true }); }
    // Only people you can see: someone in your group (blocking also hides them if they come back after leaving).
    const p = await env.DB.prepare('SELECT id FROM players WHERE id = ? AND group_code = ?').bind(other, me.group_code).first();
    if (!p) return fail('You can only block people in your group.', 404);
    await env.DB.prepare('INSERT OR IGNORE INTO blocks (player_id, blocked_id, created_at) VALUES (?, ?, ?)').bind(me.id, other, Date.now()).run();
    return json({ ok: true });
  }
  // Set or change this account's username and password.
  // Changing an existing password needs the current one, or a sign-in on this device in the last few minutes
  // (how a player who forgot it gets back in: sign in with a code, passkey or email, then set a new one).
  if (m === 'POST' && path === '/api/password') {
    const b = await body(req);
    const cur = await env.DB.prepare('SELECT hash FROM passwords WHERE player_id = ?').bind(me.id).first();
    if (cur && !isFresh(me)) {
      if (typeof b.current !== 'string' || !b.current) return fail('Enter your current password.', 403);
      if (!await takeRate(env, 'pwchange:' + me.id, 10, 'hour')) return fail('Too many tries. Wait an hour and try again.', 429);
      if (!await checkPassword(b.current, cur.hash)) return fail('Your current password isn’t right.', 403);
    }
    const e = await setPassword(env, me.id, b.username, b.password);
    if (e) return fail(e, /taken/.test(e) ? 409 : 400);
    return json({ ok: true, username: cleanUsername(b.username) });
  }
  // Signs out every other device and replaces the recovery code, for a lost phone or a leaked code.
  if (m === 'POST' && path === '/api/account/signout-others') {
    const secret = randomString(24, SECRET_ALPHABET);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE player_id = ? AND key_hash != ?').bind(me.id, me.via === 'session' ? me.keyHash : ''),
      env.DB.prepare('DELETE FROM link_codes WHERE player_id = ?').bind(me.id),
      env.DB.prepare('UPDATE players SET key_hash = ? WHERE id = ?').bind(await sha256(secret), me.id)]);
    // This device keeps working: with its own session, or with the new recovery code if it was using the old one.
    return json({ ok: true, recovery: me.id + '.' + secret, token: me.via === 'primary' ? me.id + '.' + secret : null });
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
      userName: (me.name && me.name !== 'Player' ? me.name : 'WonkoLingo player') + ' (' + me.id.slice(0, 4) + ')', userDisplayName: me.name,
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
    try { v = await verifyRegistrationResponse({ response: b.response, expectedChallenge: ch.challenge, expectedOrigin: expectedOrigins(site, b.response), expectedRPID: site.rpID, requireUserVerification: false }); }
    catch (e) { return fail('The passkey couldn’t be saved.', 400); }
    if (!v.verified) return fail('The passkey couldn’t be saved.', 400);
    const c = v.registrationInfo.credential;
    const owner = await env.DB.prepare('SELECT player_id FROM passkeys WHERE id = ?').bind(c.id).first();
    if (owner && owner.player_id !== me.id) return fail('That passkey is already linked to another account.', 409);
    const have = await env.DB.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE player_id = ?').bind(me.id).first();
    if (!owner && have.n >= ACCOUNT_LIMITS.passkeysPerPlayer) return fail('This account already has the most passkeys allowed.', 403);
    await env.DB.prepare('INSERT OR REPLACE INTO passkeys (id, player_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(c.id, me.id, b64url(c.publicKey), c.counter || 0, JSON.stringify(c.transports || (b.response.response && b.response.response.transports) || []), Date.now()).run();
    return json({ ok: true, passkeys: (await env.DB.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE player_id = ?').bind(me.id).first()).n });
  }
  return null;
}
