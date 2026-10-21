// Optional email per account: confirming an address, and signing in with a six-digit code sent to it (how a player who
// forgot their password gets back in). Mail goes out through Resend, using the RESEND_API_KEY secret and the EMAIL_FROM
// variable (an address on a domain verified with Resend). Until both are set, /api/config says email is off and the
// app hides it. EMAIL_TEST_MODE=1 (local `wrangler dev` only) skips sending and returns the code, for the tests.
import { randomString, sha256, takeRate, ipKey, newSession, accountInfo, playerById } from './accounts.js';

export const EMAIL_LIMITS = { codeMinutes: 15, triesPerCode: 5, sendsPerPlayerPerHour: 5, sendsPerAddressPerHour: 5, sendsPerNetPerHour: 20, checksPerNetPerHour: 30 };
const testMode = (env, req) => env.EMAIL_TEST_MODE === '1' && /^(localhost|127\.0\.0\.1)$/.test(new URL(req.url).hostname);
export const emailReady = (env, req) => !!(env.RESEND_API_KEY && env.EMAIL_FROM) || testMode(env, req);
const cleanEmail = s => String(s || '').trim().toLowerCase();
const emailOk = e => e.length <= 254 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i.test(e);
const codeHash = (id, code) => sha256('wl-email:' + id + ':' + code);
const addrKey = async (kind, email) => kind + ':' + (await sha256('wl-addr:' + email)).slice(0, 16);

async function send(env, req, to, subject, text) {
  if (testMode(env, req) && !env.RESEND_API_KEY) return;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text }) });
  if (!r.ok) { console.log('email send failed', r.status, (await r.text()).slice(0, 200)); throw new Error('send'); }
}
// A new code replaces any earlier one of the same kind for this player.
async function issueCode(env, req, playerId, email, kind) {
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  const id = randomString(16, 'abcdefghijkmnpqrstuvwxyz23456789');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM email_codes WHERE (player_id = ? AND kind = ?) OR expires < ?').bind(playerId, kind, Date.now()),
    env.DB.prepare('INSERT INTO email_codes (id, player_id, email, kind, code_hash, expires) VALUES (?, ?, ?, ?, ?, ?)').bind(id, playerId, email, kind, await codeHash(id, code), Date.now() + EMAIL_LIMITS.codeMinutes * 60000)]);
  const text = (kind === 'verify' ? `Your code to confirm this email address for WonkoLingo is ${code}.` : `Your WonkoLingo sign-in code is ${code}.`)
    + `\n\nIt works for ${EMAIL_LIMITS.codeMinutes} minutes. If you didn't ask for it, you can ignore this email.`;
  await send(env, req, email, kind === 'verify' ? `WonkoLingo code: ${code}` : `WonkoLingo sign-in code: ${code}`, text);
  return code;
}
// Each guess uses up one of the code's tries (counted in one statement, so parallel guesses can't get extra), and the
// code is deleted once it works. Returns the code's row, or null.
async function useCode(env, row, code) {
  if (!row) return null;
  const t = await env.DB.prepare('UPDATE email_codes SET tries = tries + 1 WHERE id = ? AND tries < ? AND expires >= ? RETURNING tries').bind(row.id, EMAIL_LIMITS.triesPerCode, Date.now()).first();
  if (!t || row.code_hash !== await codeHash(row.id, code)) return null;
  await env.DB.prepare('DELETE FROM email_codes WHERE id = ?').bind(row.id).run();
  return row;
}
const codeOf = b => String(b.code || '').replace(/\D/g, '');

// Routes that work signed out. Returns a Response, or null if the path isn't ours.
export async function publicEmailApi(req, env, path, { json, fail, body }) {
  const m = req.method;
  if (m === 'GET' && path === '/api/config') return json({ email: emailReady(env, req), google: env.GOOGLE_CLIENT_ID || null });
  // Step 1 of signing in by email: always the same answer, so nobody can use it to find out who has an account.
  if (m === 'POST' && path === '/api/email/signin-request') {
    if (!emailReady(env, req)) return fail('Email isn’t set up yet.', 503);
    const email = cleanEmail((await body(req)).email);
    if (!emailOk(email)) return fail('That doesn’t look like an email address.');
    if (!await takeRate(env, await ipKey(req, 'esend'), EMAIL_LIMITS.sendsPerNetPerHour, 'hour') || !await takeRate(env, await addrKey('eaddr', email), EMAIL_LIMITS.sendsPerAddressPerHour, 'hour'))
      return fail('Too many codes requested. Wait a bit and try again.', 429);
    const row = await env.DB.prepare('SELECT player_id FROM emails WHERE email = ?').bind(email).first();
    let code = null;
    if (row) { try { code = await issueCode(env, req, row.player_id, email, 'signin'); } catch (e) { return fail('The email couldn’t be sent. Try again in a few minutes.', 502); } }
    return json({ ok: true, ...(testMode(env, req) && code ? { devCode: code } : {}) });
  }
  // Step 2: the code from the email signs this device in. A fresh sign-in can then set a new password.
  if (m === 'POST' && path === '/api/email/signin') {
    if (!emailReady(env, req)) return fail('Email isn’t set up yet.', 503);
    const b = await body(req), email = cleanEmail(b.email), code = codeOf(b);
    if (!await takeRate(env, await ipKey(req, 'echeck'), EMAIL_LIMITS.checksPerNetPerHour, 'hour')) return fail('Too many tries. Wait an hour and try again.', 429);
    const row = code.length === 6 && emailOk(email) ? await env.DB.prepare("SELECT id, player_id, code_hash FROM email_codes WHERE email = ? AND kind = 'signin' ORDER BY expires DESC").bind(email).first() : null;
    if (!await useCode(env, row, code)) return fail('That code isn’t right or has expired. Ask for a new one.', 400);
    const p = await playerById(env, row.player_id);
    if (!p) return fail('That account no longer exists.', 404);
    return json({ token: await newSession(env, p.id, 'email'), ...(await accountInfo(env, p)) });
  }
  return null;
}

// Routes for a signed-in player.
export async function emailApi(req, env, path, me, { json, fail, body }) {
  const m = req.method;
  // Add or change the account's email: a code goes to the new address, and it's saved once the code comes back.
  if (m === 'POST' && path === '/api/email') {
    if (!emailReady(env, req)) return fail('Email isn’t set up yet.', 503);
    const email = cleanEmail((await body(req)).email);
    if (!emailOk(email)) return fail('That doesn’t look like an email address.');
    if (!await takeRate(env, 'esendp:' + me.id, EMAIL_LIMITS.sendsPerPlayerPerHour, 'hour') || !await takeRate(env, await addrKey('eaddr', email), EMAIL_LIMITS.sendsPerAddressPerHour, 'hour'))
      return fail('Too many codes requested. Wait a bit and try again.', 429);
    let code;
    try { code = await issueCode(env, req, me.id, email, 'verify'); } catch (e) { return fail('The email couldn’t be sent. Check the address, or try again in a few minutes.', 502); }
    return json({ ok: true, email, ...(testMode(env, req) ? { devCode: code } : {}) });
  }
  if (m === 'POST' && path === '/api/email/verify') {
    const code = codeOf(await body(req));
    if (!await takeRate(env, 'echeckp:' + me.id, EMAIL_LIMITS.checksPerNetPerHour, 'hour')) return fail('Too many tries. Wait an hour and try again.', 429);
    const row = code.length === 6 ? await env.DB.prepare("SELECT id, email, code_hash FROM email_codes WHERE player_id = ? AND kind = 'verify'").bind(me.id).first() : null;
    if (!await useCode(env, row, code)) return fail('That code isn’t right or has expired. Ask for a new one.', 400);
    // Only reachable with the code from that inbox, so saying the address is taken reveals nothing to a stranger.
    const other = await env.DB.prepare('SELECT player_id FROM emails WHERE email = ? AND player_id != ?').bind(row.email, me.id).first();
    if (other) return fail('That email is already linked to another WonkoLingo account.', 409);
    await env.DB.prepare('INSERT INTO emails (player_id, email, verified_at) VALUES (?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET email = excluded.email, verified_at = excluded.verified_at').bind(me.id, row.email, Date.now()).run();
    return json({ ok: true, email: row.email });
  }
  if (m === 'POST' && path === '/api/email/remove') {
    await env.DB.batch([env.DB.prepare('DELETE FROM emails WHERE player_id = ?').bind(me.id), env.DB.prepare('DELETE FROM email_codes WHERE player_id = ?').bind(me.id)]);
    return json({ ok: true });
  }
  return null;
}
