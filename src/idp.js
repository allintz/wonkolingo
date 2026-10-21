// Sign in with Google or Apple. The page (Google's web button) or the iPhone app (native Google and Apple sign-in) gets
// an ID token from the provider and posts it here; the server checks the provider's signature, issuer, audience and
// expiry, then signs in the account linked to that provider account, links it to the signed-in player, or makes a new
// account. Google is on when GOOGLE_CLIENT_ID (web) or GOOGLE_IOS_CLIENT_ID is set; Apple is on in the iPhone app,
// with the app's bundle id (APPLE_AUDIENCE, default below) as the audience. /api/config reports what's on.
import { randomString, sha256, newSession, createHomeGroup, accountInfo, playerById, takeRate, ipKey, screen, screenFail, takeNewAccount } from './accounts.js';

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const SECRET_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PROVIDERS = {
  google: { certs: 'https://www.googleapis.com/oauth2/v3/certs', issuers: ['accounts.google.com', 'https://accounts.google.com'],
    audiences: env => [env.GOOGLE_CLIENT_ID, env.GOOGLE_IOS_CLIENT_ID].filter(Boolean) },
  apple: { certs: 'https://appleid.apple.com/auth/keys', issuers: ['https://appleid.apple.com'],
    audiences: env => [env.APPLE_AUDIENCE || 'com.alexlintz.wonkolingo'] }
};
const certCache = {};
export const providerConfig = env => ({ google: env.GOOGLE_CLIENT_ID || null, googleIos: env.GOOGLE_IOS_CLIENT_ID || null, apple: true });
const isLocal = req => /^(localhost|127\.0\.0\.1)$/.test(new URL(req.url).hostname);

const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const b64json = s => JSON.parse(new TextDecoder().decode(fromB64url(s)));

// The provider's signing keys, cached for an hour. Local test servers can supply their own (IDP_TEST_JWKS), so tests can
// sign tokens; that only works on localhost.
async function certs(env, req, P) {
  if (env.IDP_TEST_JWKS && isLocal(req)) return JSON.parse(env.IDP_TEST_JWKS).keys;
  const c = certCache[P.certs];
  if (c && Date.now() - c.at < 3600e3 && c.keys.length) return c.keys;
  const r = await fetch(P.certs);
  if (!r.ok) throw new Error('Sign-in keys unavailable');
  certCache[P.certs] = { at: Date.now(), keys: (await r.json()).keys || [] };
  return certCache[P.certs].keys;
}
// Returns the token's claims if the provider signed it for this app and it hasn't expired, else null.
export async function verifyIdToken(env, req, token, P) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || token.length > 4000) return null;
  let head, claims;
  try { head = b64json(parts[0]); claims = b64json(parts[1]); } catch { return null; }
  if (head.alg !== 'RS256') return null;
  const jwk = (await certs(env, req, P)).find(k => k.kid === head.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  const now = Date.now() / 1000;
  if (!ok || !P.issuers.includes(claims.iss) || !P.audiences(env).includes(claims.aud) || !(claims.exp > now) || !(claims.iat < now + 300) || !claims.sub) return null;
  return claims;
}

// POST /api/google or /api/apple with { credential } (Apple also sends { name } the first time, since its token has none).
export async function idpApi(req, env, path, me, { json, fail, body, cleanName }) {
  const provider = path === '/api/google' ? 'google' : path === '/api/apple' ? 'apple' : null;
  if (!provider || req.method !== 'POST') return null;
  const P = PROVIDERS[provider], label = provider === 'google' ? 'Google' : 'Apple';
  if (!P.audiences(env).length) return fail(`${label} sign-in isn’t set up.`, 404);
  if (!await takeRate(env, await ipKey(req, 'idp'), 60, 'hour')) return fail('Too many sign-in attempts. Try again in an hour.', 429);
  const b = await body(req);
  const c = await verifyIdToken(env, req, b.credential, P).catch(() => null);
  if (!c) return fail(`${label} sign-in didn’t work. Try again.`, 401);
  // Apple sends email_verified as the string "true".
  const verified = c.email_verified === true || c.email_verified === 'true';
  const sub = String(c.sub), email = verified ? String(c.email || '').toLowerCase().slice(0, 254) : null;
  const shown = email || 'connected';
  const linked = await env.DB.prepare('SELECT player_id FROM sign_in_ids WHERE provider = ? AND sub = ?').bind(provider, sub).first();
  const link = id => env.DB.prepare('INSERT OR IGNORE INTO sign_in_ids (provider, sub, player_id, email, created_at) VALUES (?, ?, ?, ?, ?)').bind(provider, sub, id, email, Date.now());

  // Signed in already: connect this provider account to the player, so it can be used to sign in from now on.
  if (me) {
    if (linked && linked.player_id !== me.id) return fail(`That ${label} account is already used by another WonkoLingo account.`, 409);
    await env.DB.prepare('DELETE FROM sign_in_ids WHERE player_id = ? AND provider = ? AND sub != ?').bind(me.id, provider, sub).run(); // one per provider
    if (!linked) await link(me.id).run();
    return json({ ok: true, provider, [provider]: shown });
  }
  if (linked) {
    const p = await playerById(env, linked.player_id);
    if (p) return json({ token: await newSession(env, p.id, provider), ...(await accountInfo(env, p)) });
    await env.DB.prepare('DELETE FROM sign_in_ids WHERE provider = ? AND sub = ?').bind(provider, sub).run();
  }
  // A WonkoLingo account that confirmed the same email (the provider has verified it too) is the same person.
  if (email) {
    const em = await env.DB.prepare('SELECT player_id FROM emails WHERE email = ?').bind(email).first();
    const p = em && await playerById(env, em.player_id);
    if (p) { await link(p.id).run(); return json({ token: await newSession(env, p.id, provider), ...(await accountInfo(env, p)) }); }
  }
  // Otherwise a new account, named after the profile's first name (Apple's comes from the app, on first sign-in only).
  if (!await takeNewAccount(env, req)) return fail('Too many new accounts from this network today. Try again tomorrow.', 429);
  const name = cleanName(provider === 'google' ? c.given_name || c.name : b.name, 24) || 'Player';
  if (name !== 'Player') { const mod = await screen(env, req, `Display name: ${name}`); if (!mod.allowed) return screenFail(fail, mod, 'That name can’t be used: '); }
  const code = await createHomeGroup(env);
  const id = randomString(10, ID_ALPHABET), secret = randomString(24, SECRET_ALPHABET);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO players (id, group_code, name, key_hash, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, code, name, await sha256(secret), Date.now()),
    link(id)
  ]);
  return json({ token: id + '.' + secret, player: { id, name }, group: null, passkeys: 0, username: null, email: null, google: null, apple: null, [provider]: shown, created: true });
}
