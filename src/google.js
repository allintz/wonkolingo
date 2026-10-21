// Sign in with Google. The page gets an ID token from Google's button (Google Identity Services) and posts it here; the
// server checks Google's signature and audience, then signs in the account linked to that Google account, links it to
// the signed-in player, or makes a new account. Switched on by the GOOGLE_CLIENT_ID variable (a Google Cloud OAuth web
// client); /api/config reports it so the page only shows the button when it works.
import { randomString, sha256, newSession, createHomeGroup, accountInfo, playerById, takeRate, ipKey, screen, screenFail, takeNewAccount } from './accounts.js';

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const SECRET_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
let certCache = { at: 0, keys: [] };

export const googleReady = env => !!env.GOOGLE_CLIENT_ID;
const isLocal = req => /^(localhost|127\.0\.0\.1)$/.test(new URL(req.url).hostname);

const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const b64json = s => JSON.parse(new TextDecoder().decode(fromB64url(s)));

// Google's signing keys, cached for an hour. Local test servers can supply their own (GOOGLE_TEST_JWKS), so tests can
// sign tokens; that only works on localhost.
async function certs(env, req) {
  if (env.GOOGLE_TEST_JWKS && isLocal(req)) return JSON.parse(env.GOOGLE_TEST_JWKS).keys;
  if (Date.now() - certCache.at < 3600e3 && certCache.keys.length) return certCache.keys;
  const r = await fetch(CERTS_URL);
  if (!r.ok) throw new Error('Google keys unavailable');
  certCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  return certCache.keys;
}
// Returns the token's claims if Google signed it for this app and it hasn't expired, else null.
export async function verifyIdToken(env, req, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || token.length > 4000) return null;
  let head, claims;
  try { head = b64json(parts[0]); claims = b64json(parts[1]); } catch { return null; }
  if (head.alg !== 'RS256') return null;
  const jwk = (await certs(env, req)).find(k => k.kid === head.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  const now = Date.now() / 1000;
  if (!ok || !ISSUERS.includes(claims.iss) || claims.aud !== env.GOOGLE_CLIENT_ID || !(claims.exp > now) || !(claims.iat < now + 300) || !claims.sub) return null;
  return claims;
}

export async function googleApi(req, env, path, me, { json, fail, body, cleanName }) {
  if (!(req.method === 'POST' && path === '/api/google')) return null;
  if (!googleReady(env)) return fail('Google sign-in isn’t set up.', 404);
  if (!await takeRate(env, await ipKey(req, 'google'), 60, 'hour')) return fail('Too many sign-in attempts. Try again in an hour.', 429);
  const b = await body(req);
  const c = await verifyIdToken(env, req, b.credential).catch(() => null);
  if (!c) return fail('Google sign-in didn’t work. Try again.', 401);
  const sub = String(c.sub), email = c.email_verified ? String(c.email || '').toLowerCase().slice(0, 254) : null;
  const linked = await env.DB.prepare('SELECT player_id FROM google_ids WHERE sub = ?').bind(sub).first();

  // Signed in already: connect this Google account to the player, so it can be used to sign in from now on.
  if (me) {
    if (linked && linked.player_id !== me.id) return fail('That Google account is already used by another WonkoLingo account.', 409);
    await env.DB.prepare('DELETE FROM google_ids WHERE player_id = ? AND sub != ?').bind(me.id, sub).run(); // one Google account per player
    if (!linked) await env.DB.prepare('INSERT INTO google_ids (sub, player_id, email, created_at) VALUES (?, ?, ?, ?)').bind(sub, me.id, email, Date.now()).run();
    return json({ ok: true, google: email || 'connected' });
  }
  if (linked) {
    const p = await playerById(env, linked.player_id);
    if (p) return json({ token: await newSession(env, p.id, 'google'), ...(await accountInfo(env, p)) });
    await env.DB.prepare('DELETE FROM google_ids WHERE sub = ?').bind(sub).run();
  }
  // A WonkoLingo account that confirmed the same email (Google has verified it too) is the same person: link and sign in.
  if (email) {
    const em = await env.DB.prepare('SELECT player_id FROM emails WHERE email = ?').bind(email).first();
    const p = em && await playerById(env, em.player_id);
    if (p) {
      await env.DB.prepare('INSERT OR IGNORE INTO google_ids (sub, player_id, email, created_at) VALUES (?, ?, ?, ?)').bind(sub, p.id, email, Date.now()).run();
      return json({ token: await newSession(env, p.id, 'google'), ...(await accountInfo(env, p)) });
    }
  }
  // Otherwise a new account, named after the Google profile's first name.
  if (!await takeNewAccount(env, req)) return fail('Too many new accounts from this network today. Try again tomorrow.', 429);
  const name = cleanName(c.given_name || c.name, 24) || 'Player';
  if (name !== 'Player') { const mod = await screen(env, req, `Display name: ${name}`); if (!mod.allowed) return screenFail(fail, mod, 'That name can’t be used: '); }
  const code = await createHomeGroup(env);
  const id = randomString(10, ID_ALPHABET), secret = randomString(24, SECRET_ALPHABET);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO players (id, group_code, name, key_hash, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, code, name, await sha256(secret), Date.now()),
    env.DB.prepare('INSERT INTO google_ids (sub, player_id, email, created_at) VALUES (?, ?, ?, ?)').bind(sub, id, email, Date.now())
  ]);
  return json({ token: id + '.' + secret, player: { id, name }, group: null, passkeys: 0, username: null, email: null, google: email || 'connected', created: true });
}
