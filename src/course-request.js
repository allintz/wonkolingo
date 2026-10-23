// Course requests: a player asks for a built-in course that doesn't exist yet. Each request is stored (course_requests)
// and emailed to COURSE_REQUEST_TO through Resend, with the player's optional email as Reply-To so Alex can answer
// from his inbox. Needs an account; limited per player, per network and overall. EMAIL_TEST_MODE skips the send.
import { takeRate, ipKey } from './accounts.js';

export const REQUEST_LIMITS = { perPlayerPerDay: 3, perNetPerDay: 10, allPerDay: 60, topic: 120, why: 1000, details: 1500 };
export const REQUEST_LEVELS = ['beginner', 'intermediate', 'advanced', 'any'];
const LEVEL_TEXT = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced', any: 'Not sure' };
const clean = (s, max) => Array.from(String(s || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '')).slice(0, max).join('').trim();
const emailOk = e => e.length <= 254 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i.test(e);
const testMode = (env, req) => env.EMAIL_TEST_MODE === '1' && /^(localhost|127\.0\.0\.1)$/.test(new URL(req.url).hostname);

export async function courseRequestApi(req, env, me, b, { json, fail }) {
  if (!me) return fail('Sign in to request a course.', 401);
  const topic = clean(b.topic, REQUEST_LIMITS.topic), why = clean(b.why, REQUEST_LIMITS.why), details = clean(b.details, REQUEST_LIMITS.details);
  const level = REQUEST_LEVELS.includes(b.level) ? b.level : '';
  const contact = clean(b.contact, 254).toLowerCase();
  if (topic.length < 3) return fail('Say what the course should be about.');
  if (why.length < 10) return fail('Add a sentence on what you’d use it for.');
  if (!level) return fail('Pick a level.');
  if (contact && !emailOk(contact)) return fail('That email address doesn’t look right.');
  if (!await takeRate(env, 'creq:' + me.id, REQUEST_LIMITS.perPlayerPerDay, 'day')) return fail('That’s plenty of requests for today. Try again tomorrow.', 429);
  if (!await takeRate(env, await ipKey(req, 'creq'), REQUEST_LIMITS.perNetPerDay, 'day') || !await takeRate(env, 'creq:all', REQUEST_LIMITS.allPerDay, 'day')) return fail('Too many requests today. Try again tomorrow.', 429);
  const now = Date.now();
  const row = await env.DB.prepare('INSERT INTO course_requests (player_id, name, topic, why, level, details, contact, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
    .bind(me.id, me.name || '', topic, why, level, details, contact, now).first();
  let emailed = false;
  const to = env.COURSE_REQUEST_TO;
  if (to && env.RESEND_API_KEY && env.EMAIL_FROM && !testMode(env, req)) {
    const text = [
      `${me.name || 'A player'} asked for a new WonkoLingo course.`, '',
      `Topic: ${topic}`, `Level: ${LEVEL_TEXT[level]}`, '', 'What they’d use it for:', why, '',
      details ? 'Details:\n' + details + '\n' : '',
      contact ? `Reply to: ${contact} (replying to this email goes to them)` : 'They left no email for a reply.',
      '', `Player ${me.id} · request #${row.id}`].join('\n');
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject: 'Course request: ' + topic.slice(0, 80), text, ...(contact ? { reply_to: contact } : {}) }) });
    emailed = r.ok;
    if (!r.ok) console.log('course request email failed', r.status, (await r.text()).slice(0, 200));
    await env.DB.prepare('UPDATE course_requests SET emailed = ? WHERE id = ?').bind(emailed ? 1 : 0, row.id).run();
  }
  return json({ ok: true, id: row.id, emailed });
}
