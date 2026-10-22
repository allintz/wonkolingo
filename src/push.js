// Push notifications to the iPhone app through Apple's push service (APNs), for things that happen on a friend's
// phone: nudges, high-fives, friend-streak requests and accepts, and "they're done, your turn" on a friend streak.
// Needs two secrets: APNS_KEY (the text of the .p8 key file from the Apple developer account) and APNS_KEY_ID.
// Cloudflare's servers reach APNs over HTTP/2 (checked 10/22 with a probe worker); local wrangler dev can't, so tests
// point APNS_HOST at a fake.
import { takeRate } from './accounts.js';

const TEAM = '29B8GL5NYV', TOPIC = 'com.alexlintz.wonkolingo';
export const PUSH_LIMITS = { perPlayerPerDay: 8, devicesPerPlayer: 5 };
export const pushReady = env => !!(env.APNS_KEY && env.APNS_KEY_ID);

const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlText = s => b64url(new TextEncoder().encode(s));
// Apple accepts the same signed token for up to an hour, so one is kept for 40 minutes.
let cached = null;
async function providerToken(env) {
  if (cached && cached.kid === env.APNS_KEY_ID && Date.now() - cached.at < 40 * 60000) return cached.token;
  const pem = String(env.APNS_KEY).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const unsigned = b64urlText(JSON.stringify({ alg: 'ES256', kid: env.APNS_KEY_ID })) + '.' + b64urlText(JSON.stringify({ iss: TEAM, iat: Math.floor(Date.now() / 1000) }));
  // WebCrypto's ECDSA signature is already the raw r||s form a JWT uses.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  cached = { kid: env.APNS_KEY_ID, at: Date.now(), token: unsigned + '.' + b64url(sig) };
  return cached.token;
}

// Sends one alert to every phone the player registered, unless they turned friend notifications off (prefs.pushFriends)
// or already got PUSH_LIMITS.perPlayerPerDay today. Returns how many phones accepted it. Never throws.
export async function pushTo(env, playerId, { title, body, kind }) {
  try {
    if (!pushReady(env)) return 0;
    const rows = (await env.DB.prepare('SELECT token, sandbox FROM push_tokens WHERE player_id = ?').bind(playerId).all()).results;
    if (!rows.length) return 0;
    const st = await env.DB.prepare("SELECT json_extract(json, '$.prefs.pushFriends') AS opt FROM player_state WHERE player_id = ?").bind(playerId).first();
    if (st && (st.opt === 0 || st.opt === false)) return 0;
    if (!await takeRate(env, 'push:' + playerId, PUSH_LIMITS.perPlayerPerDay, 'day')) return 0;
    const auth = 'bearer ' + await providerToken(env);
    let sent = 0;
    for (const r of rows) {
      const host = env.APNS_HOST || (r.sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
      const res = await fetch(`${host}/3/device/${r.token}`, { method: 'POST',
        headers: { authorization: auth, 'apns-topic': TOPIC, 'apns-push-type': 'alert', 'apns-priority': '10', 'content-type': 'application/json' },
        body: JSON.stringify({ aps: { alert: { title, body }, sound: 'default', 'thread-id': kind }, kind }) });
      if (res.ok) { sent++; continue; }
      const why = await res.text().catch(() => '');
      // A phone that uninstalled the app, or a token from the other APNs environment, is forgotten.
      if (res.status === 410 || /BadDeviceToken|Unregistered|DeviceTokenNotForTopic/.test(why)) await env.DB.prepare('DELETE FROM push_tokens WHERE token = ?').bind(r.token).run();
      else console.log('apns failed', res.status, why.slice(0, 200));
    }
    return sent;
  } catch (e) { console.log('push error', String(e && e.message)); return 0; }
}

// /api/push/register and /api/push/unregister. A token belongs to one player at a time (signing in as someone else on
// the same phone moves it), and a player keeps their newest few phones.
export async function pushApi(req, env, path, me, { json, fail, body }) {
  if (req.method !== 'POST' || !/^\/api\/push\/(register|unregister)$/.test(path)) return null;
  const b = await body(req);
  const token = typeof b.token === 'string' && /^[0-9a-fA-F]{32,200}$/.test(b.token) ? b.token.toLowerCase() : '';
  if (!token) return fail('Bad device token.');
  if (path === '/api/push/unregister') {
    await env.DB.prepare('DELETE FROM push_tokens WHERE token = ? AND player_id = ?').bind(token, me.id).run();
    return json({ ok: true });
  }
  await env.DB.batch([
    env.DB.prepare('INSERT INTO push_tokens (token, player_id, sandbox, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(token) DO UPDATE SET player_id = excluded.player_id, sandbox = excluded.sandbox, created_at = excluded.created_at').bind(token, me.id, b.sandbox ? 1 : 0, Date.now()),
    env.DB.prepare('DELETE FROM push_tokens WHERE player_id = ? AND token NOT IN (SELECT token FROM push_tokens WHERE player_id = ? ORDER BY created_at DESC LIMIT ?)').bind(me.id, me.id, PUSH_LIMITS.devicesPerPlayer)]);
  return json({ ok: true, ready: pushReady(env) });
}
