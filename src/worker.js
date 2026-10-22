// WonkoLingo group play API. Static files come from ./docs; only /api/* reaches this code.
// Identity is a random token per player (no passwords). The token doubles as a recovery code.
// Every player has an account; groups are optional (see accounts.js for passkeys, sign-in codes and home groups).

import { validateCourse, COURSE_LIMITS, computeStreak } from './course-format.js';
import Anthropic from '@anthropic-ai/sdk';
import { gradeAnswer, takeGradeQuota, takeDisputeQuota, hintFor, defineTerm } from './grade.js';
import { publicEmailApi, emailApi } from './email.js';
import { adminApi } from './admin.js';
import { socialApi, friendRows } from './social.js';
import { sendNudgeEmail } from './email.js';
import { idpApi } from './idp.js';
import { randomString, sha256, accountInfo, publicAccountApi, accountApi, takeRate, netId, ipKey, screen, screenFail, takeNewAccount, ACCOUNT_LIMITS } from './accounts.js';
const REMOVE_REASONS = ['trivia', 'wrong', 'unclear', 'known', 'other', 'restored'];

// Only WonkoLingo's own pages may call the API from a browser: the site, its GitHub Pages copy, the iPhone app and local
// development. Other websites can't use visitors' browsers to spend the AI grading quota.
const CORS_ORIGINS = ['https://wonkolingo.alex-l-lintz.workers.dev', 'https://allintz.github.io', 'capacitor://localhost'];
const corsOk = o => CORS_ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
function withCors(res, req) {
  const o = req.headers.get('Origin') || '';
  if (corsOk(o)) {
    res.headers.set('Access-Control-Allow-Origin', o);
    res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.headers.set('Vary', 'Origin');
  }
  return res;
}
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// A real calendar day, not just the shape (2026-10-00 would break streak math for the whole group).
const realDay = d => typeof d === 'string' && DAY_RE.test(d) && !isNaN(Date.parse(d + 'T12:00:00Z')) && new Date(d + 'T12:00:00Z').toISOString().slice(0, 10) === d;
const utcDay = (n = 0) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const XP_PER_DAY = 3000;
const APPLE_APP_SITE_ASSOCIATION = { webcredentials: { apps: ['29B8GL5NYV.com.alexlintz.wonkolingo'] } };
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const fail = (msg, status = 400) => json({ error: msg }, status);

// Names and short text others will see: no control or invisible formatting characters (direction overrides, zero-width
// spaces), no angle brackets, one line, cut by characters rather than halfway through an emoji, and at least one letter
// or digit (so a name can't be blank-looking).
function cleanName(s, max) {
  const t = String(s || '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}<>]/gu, '').replace(/\s+/g, ' ').trim();
  const out = Array.from(t).slice(0, max).join('').trim();
  return /[\p{L}\p{N}]/u.test(out) ? out : '';
}
// Longer text kept for review (disputes, feedback): control characters out, so nothing odd reaches a terminal.
const cleanText = (s, max) => Array.from(String(s || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')).slice(0, max).join('');
const nameKey = s => String(s || '').normalize('NFKC').toLowerCase();
const BODY_MAX = 100000;
async function body(req) {
  try { const t = await req.text(); return t.length > BODY_MAX ? {} : JSON.parse(t) || {}; } catch { return {}; }
}
// Drops keys that could change an object's prototype if a client ever merged the data with Object.assign.
const safeParse = t => JSON.parse(t, (k, v) => k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v);

// Monday 00:00 UTC of the current week, in ms.
function weekStart(now = Date.now()) {
  const d = new Date(now);
  const dow = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
}
function shiftDay(day, n) {
  const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
async function auth(req, env) {
  const h = req.headers.get('Authorization') || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const [id, secret] = tok.split('.');
  if (!id || !secret) return null;
  const p = await env.DB.prepare('SELECT p.id, p.name, p.group_code, p.key_hash, g.name AS group_name, g.solo FROM players p JOIN groups g ON g.code = p.group_code WHERE p.id = ?').bind(id).first();
  if (!p) return null;
  const h2 = await sha256(secret);
  if (p.key_hash === h2) return { ...p, via: 'primary', keyHash: h2 };
  // Devices signed in by passkey, password, email or sign-in code have their own secret.
  const s = await env.DB.prepare('SELECT created_at FROM sessions WHERE player_id = ? AND key_hash = ?').bind(id, h2).first();
  return s ? { ...p, via: 'session', keyHash: h2, sessionAt: s.created_at } : null;
}

// Identity for grading quotas: the signed-in player, or a salted hash of the visitor's IP.
async function graderId(req, env) {
  const me = await auth(req, env);
  if (me) return me.id;
  return 'ip:' + (await sha256('wl-grade:' + netId(req))).slice(0, 16);
}

async function createPlayer(env, code, name) {
  const id = randomString(10, 'abcdefghijkmnpqrstuvwxyz23456789');
  const secret = randomString(24, 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789');
  await env.DB.prepare('INSERT INTO players (id, group_code, name, key_hash, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, code, name, await sha256(secret), Date.now()).run();
  return { id, token: id + '.' + secret };
}
// A signed-in player joins or starts a group: the same account moves, keeping its progress.
// Coming from a home group, lesson results move too and the home group is removed.
async function moveToGroup(env, me, code, name) {
  const stmts = [env.DB.prepare('UPDATE players SET group_code = ?, name = ? WHERE id = ?').bind(code, name, me.id)];
  // Courses come along only while the group has room (50).
  const room = me.solo ? Math.max(0, 50 - (await env.DB.prepare('SELECT COUNT(*) AS n FROM courses WHERE group_code = ?').bind(code).first()).n) : 0;
  if (me.solo) stmts.push(
    env.DB.prepare('UPDATE completions SET group_code = ? WHERE player_id = ? AND group_code = ?').bind(code, me.id, me.group_code),
    env.DB.prepare('UPDATE OR IGNORE courses SET group_code = ? WHERE id IN (SELECT id FROM courses WHERE group_code = ? ORDER BY created_at LIMIT ?)').bind(code, me.group_code, room),
    env.DB.prepare('DELETE FROM groups WHERE code = ? AND solo = 1 AND NOT EXISTS (SELECT 1 FROM courses WHERE group_code = ?)').bind(me.group_code, me.group_code));
  await env.DB.batch(stmts);
}

async function api(req, env, path) {
  const m = req.method;
  if (path.startsWith('/api/admin/')) return adminApi(req, env, path, await auth(req, env), m === 'POST' ? await body(req) : {});

  if (m === 'POST' && path === '/api/groups') {
    const b = await body(req);
    const gname = cleanName(b.groupName, 40), pname = cleanName(b.name, 24);
    if (!gname || !pname) return fail('Group name and your name are both required.');
    const me0 = await auth(req, env);
    if (!me0 && !await takeNewAccount(env, req)) return fail('Too many new accounts from this network today. Try again tomorrow.', 429);
    const gmod = await screen(env, req, `Group name: ${gname}\nDisplay name: ${pname}`);
    if (!gmod.allowed) return screenFail(fail, gmod, 'That name can’t be used: ');
    let code;
    for (let i = 0; i < 5; i++) {
      code = randomString(6, CODE_ALPHABET);
      const r = await env.DB.prepare('INSERT OR IGNORE INTO groups (code, name, created_at) VALUES (?, ?, ?)').bind(code, gname, Date.now()).run();
      if (r.meta.changes) break;
      code = null;
    }
    if (!code) return fail('Could not create a group. Try again.', 500);
    const me = me0;
    if (me) { await moveToGroup(env, me, code, pname); return json({ code, groupName: gname, player: { id: me.id, name: pname } }); }
    const p = await createPlayer(env, code, pname);
    return json({ code, groupName: gname, player: { id: p.id, name: pname }, token: p.token });
  }

  const gm = path.match(/^\/api\/groups\/([A-Za-z0-9]{6})$/);
  if (m === 'GET' && gm) {
    if (!await takeRate(env, await ipKey(req, 'glook'), ACCOUNT_LIMITS.groupLookupsPerIpPerHour, 'hour')) return fail('Too many lookups. Wait a bit and try again.', 429);
    const g = await env.DB.prepare('SELECT g.name, COUNT(p.id) AS n FROM groups g LEFT JOIN players p ON p.group_code = g.code WHERE g.code = ? GROUP BY g.code').bind(gm[1].toUpperCase()).first();
    return g ? json({ code: gm[1].toUpperCase(), groupName: g.name, members: g.n }) : fail('No group with that code.', 404);
  }

  if (m === 'POST' && path === '/api/join') {
    const b = await body(req);
    const code = String(b.code || '').trim().toUpperCase(), pname = cleanName(b.name, 24);
    if (!pname) return fail('Pick a display name.');
    const g = await env.DB.prepare('SELECT name FROM groups WHERE code = ? AND solo = 0').bind(code).first();
    if (!g) return fail('No group with that code.', 404);
    const me = await auth(req, env);
    if (!me && !await takeNewAccount(env, req)) return fail('Too many new accounts from this network today. Try again tomorrow.', 429);
    // Same name in any letter case (including accented and non-Latin letters) counts as taken.
    const others = await env.DB.prepare('SELECT name FROM players WHERE group_code = ? AND id != ?').bind(code, me ? me.id : '').all();
    const taken = others.results.some(r => nameKey(r.name) === nameKey(pname));
    if (!taken) { const nmod = await screen(env, req, `Display name: ${pname}`); if (!nmod.allowed) return screenFail(fail, nmod, 'That name can’t be used: '); }
    if (taken) return fail('Someone in this group already uses that name. If it’s you, sign in to your account instead.', 409);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM players WHERE group_code = ?').bind(code).first();
    if (n.n >= 200 && !(me && me.group_code === code)) return fail('This group is full.', 403);
    if (me) { await moveToGroup(env, me, code, pname); return json({ code, groupName: g.name, player: { id: me.id, name: pname } }); }
    const p = await createPlayer(env, code, pname);
    return json({ code, groupName: g.name, player: { id: p.id, name: pname }, token: p.token });
  }

  if (path === '/api/google' || path === '/api/apple') return await idpApi(req, env, path, await auth(req, env), { json, fail, body, cleanName }) || fail('Not found.', 404);
  const acct = await publicAccountApi(req, env, path, { json, fail, body, cleanName }) || await publicEmailApi(req, env, path, { json, fail, body });
  if (acct) return acct;

  // The app hit an error (sent by its crash banner). No account data; limited per network and per day.
  if (m === 'POST' && path === '/api/bug') {
    const b = await body(req);
    const message = cleanText(b.message, 300).trim();
    if (!message) return fail('Nothing to report.');
    if (!await takeRate(env, await ipKey(req, 'bug'), 20, 'hour') || !await takeRate(env, 'bug:all', 500, 'day')) return json({ ok: true, dropped: true });
    await env.DB.prepare('INSERT INTO bug_reports (message, stack, place, build, app, ua, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(message, cleanText(b.stack, 1500), cleanText(b.where, 60), cleanText(b.build, 40), b.app ? 1 : 0, cleanText(b.ua, 160), Date.now()).run();
    return json({ ok: true });
  }

  // A player removed a question from their reviews (or put it back). Kept as course feedback; see scripts/removals.sh.
  if (m === 'POST' && path === '/api/feedback/remove') {
    const who = await graderId(req, env), b = await body(req);
    const reason = String(b.reason || ''), card = cleanText(b.card, 120), course = cleanText(b.course, 60);
    if (!REMOVE_REASONS.includes(reason) || !card || !course) return fail('Bad feedback.');
    if (!await takeRate(env, 'rm:' + who, 300, 'day')) return fail('That’s a lot of removals today.', 429);
    await env.DB.prepare('INSERT INTO card_feedback (who, course, card, question, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(who, course, card, cleanName(b.question, 400), reason, Date.now()).run();
    return json({ ok: true });
  }

  // Tester mode: a rating tap or comment on one card. Each field is optional; fields left out keep their earlier value.
  if (m === 'POST' && path === '/api/rating') {
    const who = await graderId(req, env), b = await body(req);
    const card = cleanText(b.card, 120), course = cleanText(b.course, 60);
    const scale = v => v == null ? null : Number.isInteger(v) && v >= 1 && v <= 5 ? v : NaN;
    const useful = scale(b.useful), level = scale(b.level), comment = b.comment == null ? null : cleanText(b.comment, 1000).trim();
    if (!card || !course || Number.isNaN(useful) || Number.isNaN(level) || (useful == null && level == null && comment == null)) return fail('Bad rating.');
    if (!await takeRate(env, 'rate:' + who, 600, 'day')) return fail('That’s a lot of ratings today.', 429);
    await env.DB.prepare(`INSERT INTO card_ratings (who, course, card, question, useful, level, comment, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (who, card) DO UPDATE SET course = excluded.course, question = excluded.question, useful = COALESCE(excluded.useful, useful),
        level = COALESCE(excluded.level, level), comment = COALESCE(excluded.comment, comment), updated_at = excluded.updated_at`)
      .bind(who, course, card, cleanName(b.question, 400), useful, level, comment, Date.now()).run();
    return json({ ok: true });
  }

  // Tester mode: the end-of-session note about the set as a whole.
  if (m === 'POST' && path === '/api/rating/session') {
    const who = await graderId(req, env), b = await body(req);
    const comment = cleanText(b.comment, 2000).trim();
    const list = (v, n, max) => (Array.isArray(v) ? v : []).slice(0, n).map(s => cleanText(s, max)).filter(Boolean).join(',');
    if (!comment) return fail('Nothing to send.');
    if (!await takeRate(env, 'rates:' + who, 50, 'day')) return fail('That’s a lot of notes today.', 429);
    await env.DB.prepare('INSERT INTO session_feedback (who, courses, cards, comment, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(who, list(b.courses, 10, 60), list(b.cards, 60, 120), comment, Date.now()).run();
    return json({ ok: true });
  }

  // Grading and hints work without a group: visitors are counted by a hash of their IP for the daily cap.
  if (m === 'POST' && (path === '/api/grade' || path === '/api/hint' || path === '/api/dispute' || path === '/api/define')) {
    const who = await graderId(req, env);
    if (m === 'POST' && path === '/api/grade') {
      if (!env.ANTHROPIC_API_KEY) return fail('Answer grading isn’t set up.', 503);
      const b = await body(req);
      if (!String(b.response || '').trim()) return json({ score: 0, feedback: 'No answer given.' });
      if (!String(b.question || '').trim() || !String(b.answer || '').trim()) return fail('Missing question or model answer.');
      const capped = await takeGradeQuota(env, who);
      if (capped) return fail(capped, 429);
      try {
        const g = await gradeAnswer(env, b);
        if (!g) return fail('The grader couldn’t grade that one. Grade yourself.', 502);
      if (g.refused) return fail('The AI grader declined this one, which sometimes happens on biosecurity and weapons topics. Grade yourself.', 422);
        return json({ score: g.score, percent: g.percent, points: g.points, missed: g.missed, feedback: g.feedback });
      } catch (e) {
        if (e instanceof Anthropic.RateLimitError) return fail('The grader is busy. Grade yourself for this one.', 503);
        if (e instanceof Anthropic.AuthenticationError) return fail('Answer grading isn’t set up correctly.', 503);
        if (e instanceof Anthropic.APIError) return fail('The grader had an error. Grade yourself for this one.', 502);
        throw e;
      }
    }

    // "I think the grader is wrong": Opus re-grades with the learner's note, and the case is saved for review.
    if (m === 'POST' && path === '/api/dispute') {
      if (!env.ANTHROPIC_API_KEY) return fail('Answer grading isn’t set up.', 503);
      const b = await body(req);
      if (!String(b.response || '').trim() || !String(b.question || '').trim() || !String(b.answer || '').trim()) return fail('Missing the answer to re-grade.');
      const capped = await takeDisputeQuota(env, who);
      if (capped) return fail(capped, 429);
      const first = b.first && typeof b.first === 'object' ? { percent: b.first.percent, points: b.first.points, feedback: b.first.feedback } : {};
      const note = String(b.note || '').slice(0, 800);
      const ins = await env.DB.prepare('INSERT INTO disputes (who, course, card, question, answer, response, note, first_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(who, cleanText(b.course, 80), cleanText(b.card, 120), cleanText(b.question, 700), cleanText(b.answer, 700), cleanText(b.response, 1200), cleanText(note, 800), JSON.stringify(first).slice(0, 4000), Date.now()).run();
      const id = ins.meta.last_row_id;
      try {
        const g = await gradeAnswer(env, b, { first, note });
        if (!g || g.refused) return fail('The second grader couldn’t grade this one. Your note was saved for review.', 422);
        await env.DB.prepare('UPDATE disputes SET regrade_json = ?, outcome = ? WHERE id = ?').bind(JSON.stringify({ percent: g.percent, points: g.points, missed: g.missed, feedback: g.feedback, reply: g.reply }), g.outcome, id).run();
        return json({ score: g.score, percent: g.percent, points: g.points, missed: g.missed, feedback: g.feedback, outcome: g.outcome, reply: g.reply });
      } catch (e) {
        if (e instanceof Anthropic.APIError) return fail('The second grader had an error. Your note was saved for review.', 502);
        throw e;
      }
    }

    // Definition of a phrase the learner selected in a card. Shares the grading quota.
    if (m === 'POST' && path === '/api/define') {
      if (!env.ANTHROPIC_API_KEY) return fail('Definitions aren’t set up.', 503);
      const b = await body(req);
      const term = String(b.term || '').replace(/\s+/g, ' ').trim();
      if (term.length < 2 || term.length > 80) return fail('Select a word or short phrase to define.');
      const capped = await takeGradeQuota(env, who);
      if (capped) return fail(capped, 429);
      try {
        const d = await defineTerm(env, { term, context: String(b.context || '') });
        if (d === null) return fail('No definition available for that.', 422);
        return json({ term, definition: d });
      } catch (e) {
        if (e instanceof Anthropic.APIError) return fail('Couldn’t get a definition right now.', 502);
        throw e;
      }
    }

    if (m === 'POST' && path === '/api/hint') {
      if (!env.ANTHROPIC_API_KEY) return fail('Hints aren’t set up.', 503);
      const b = await body(req);
      if (!String(b.question || '').trim() || !String(b.answer || '').trim()) return fail('Missing question or model answer.');
      const capped = await takeGradeQuota(env, who);
      if (capped) return fail(capped, 429);
      try {
        const h = await hintFor(env, b);
        return h ? json({ hint: h }) : fail('No hint available for this one.', 502);
      } catch (e) {
        if (e instanceof Anthropic.APIError) return fail('Couldn’t get a hint right now.', 502);
        throw e;
      }
    }
  }

  const me = await auth(req, env);
  if (!me) return fail('Not signed in.', 401);

  if (m === 'GET' && path === '/api/me') {
    const info = await accountInfo(env, me);
    return json({ ...info, code: info.group ? info.group.code : null, groupName: info.group ? info.group.groupName : null });
  }
  const mine = await accountApi(req, env, path, me, { json, fail, body }) || await emailApi(req, env, path, me, { json, fail, body })
    || await socialApi(req, env, path, me, { json, fail, body, today: utcDay(), dayOk: d => realDay(d) && d >= utcDay(-1) && d <= utcDay(1), sendNudgeEmail: (to, from) => sendNudgeEmail(env, req, to, from) });
  if (mine) return mine;

  if (m === 'POST' && path === '/api/complete') {
    const b = await body(req);
    let xp = Math.max(0, Math.min(500, Math.round(+b.xp || 0)));
    const acc = Math.max(0, Math.min(100, Math.round(+b.acc || 0)));
    const lessonId = typeof b.lessonId === 'string' && /^[A-Za-z0-9:#._-]{1,90}$/.test(b.lessonId) ? b.lessonId : '';
    // Review sessions get a title built here from their counts; lesson titles are shown by the app from its own copy of
    // the course, so text a player sends never reaches the group feed as is.
    const n = k => Math.max(0, Math.min(999, Math.round(+b[k] || 0)));
    const title = lessonId.startsWith('review-') && (b.reviewed !== undefined || b.fresh !== undefined)
      ? (n('reviewed') ? `today’s review (${n('reviewed')} card${n('reviewed') === 1 ? '' : 's'})` : `${n('fresh')} new card${n('fresh') === 1 ? '' : 's'}`)
      : cleanName(b.title, 60);
    // The practice day must be a real date within a day of now in some time zone.
    if (!lessonId || !title || !realDay(b.day) || b.day < utcDay(-2) || b.day > utcDay(2)) return fail('Bad completion.');
    // A daily XP cap keeps the leaderboard honest if someone posts results by hand.
    const today = await env.DB.prepare('SELECT COALESCE(SUM(xp), 0) AS xp, COUNT(*) AS n FROM completions WHERE player_id = ? AND created_at > ?').bind(me.id, Date.now() - 864e5).first();
    if (today.n >= 300) return fail('That’s a lot of lessons today.', 429);
    xp = Math.max(0, Math.min(xp, XP_PER_DAY - today.xp));
    // At most one completion of the same lesson per minute, to blunt double-submits.
    const dup = await env.DB.prepare('SELECT 1 FROM completions WHERE player_id = ? AND lesson_id = ? AND created_at > ?').bind(me.id, lessonId, Date.now() - 60000).first();
    if (!dup) await env.DB.prepare('INSERT INTO completions (player_id, group_code, lesson_id, title, xp, acc, day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(me.id, me.group_code, lessonId, title, xp, acc, b.day, Date.now()).run();
    return json({ ok: true, xp });
  }

  if (m === 'GET' && path === '/api/board') {
    const url = new URL(req.url);
    // The player's local date, if it's a real day within a day of the server's.
    const t = url.searchParams.get('today') || '';
    const today = realDay(t) && t >= utcDay(-1) && t <= utcDay(1) ? t : utcDay();
    const ws = weekStart();
    const g = me.group_code;
    const [players, totals, days, feed, states, blocked, unseen] = await env.DB.batch([
      env.DB.prepare('SELECT id, name FROM players WHERE group_code = ?').bind(g),
      env.DB.prepare('SELECT player_id, SUM(xp) AS total, SUM(CASE WHEN created_at >= ? THEN xp ELSE 0 END) AS week, COUNT(*) AS lessons FROM completions WHERE group_code = ? GROUP BY player_id').bind(ws, g),
      env.DB.prepare('SELECT DISTINCT player_id, day FROM completions WHERE group_code = ? AND day >= ?').bind(g, shiftDay(today, -400)),
      env.DB.prepare('SELECT c.player_id, p.name, c.lesson_id, c.title, c.acc, c.xp, c.created_at FROM completions c JOIN players p ON p.id = c.player_id WHERE c.group_code = ? ORDER BY c.created_at DESC LIMIT 12').bind(g),
      env.DB.prepare("SELECT s.player_id, json_extract(s.json, '$.activeDays') AS ad, json_extract(s.json, '$.settings') AS st FROM player_state s JOIN players p ON p.id = s.player_id WHERE p.group_code = ?").bind(g),
      env.DB.prepare('SELECT b.blocked_id AS id, p.name FROM blocks b LEFT JOIN players p ON p.id = b.blocked_id WHERE b.player_id = ?').bind(me.id),
      env.DB.prepare('SELECT COUNT(*) AS n FROM notes WHERE player_id = ? AND seen = 0').bind(me.id)
    ]);
    // People this player blocked disappear from their board and feed.
    const hide = new Set(blocked.results.map(b => b.id));
    const synced = new Map(states.results.map(r => { let ad = null, st = null; try { ad = JSON.parse(r.ad); } catch {} try { st = JSON.parse(r.st); } catch {} return [r.player_id, { ad, st }]; }));
    const tot = new Map(totals.results.map(r => [r.player_id, r]));
    const dayMap = new Map();
    for (const r of days.results) { if (!dayMap.has(r.player_id)) dayMap.set(r.player_id, []); dayMap.get(r.player_id).push(r.day); }
    // Practice and kept days per player, for friend streaks.
    const per = new Map();
    const rows = players.results.filter(p => !hide.has(p.id)).map(p => {
      const t = tot.get(p.id) || {};
      // Prefer the player's synced practice days and streak settings; fall back to days with posted results.
      const sy = synced.get(p.id) || {};
      const daysFor = Array.isArray(sy.ad) ? sy.ad.concat(dayMap.get(p.id) || []) : (dayMap.get(p.id) || []);
      let st = { streak: 0, atRisk: false, freezes: 0, offToday: false };
      try { st = computeStreak(daysFor, sy.st, today); } catch (e) { /* one player's odd data never breaks the board for the rest */ }
      per.set(p.id, { name: p.name, practiced: new Set(daysFor), kept: new Set(st.kept || []) });
      return { id: p.id, name: p.name, week: t.week || 0, total: t.total || 0, lessons: t.lessons || 0, streak: st.streak, atRisk: st.atRisk, freezes: st.freezes, offToday: st.offToday, doneToday: !!st.doneToday };
    });
    let friends = [];
    try { friends = await friendRows(env, me, per, today, hide); } catch (e) { console.log('friend streaks failed', String(e)); }
    return json({ code: g, groupName: me.group_name, me: me.id, weekStart: ws, players: rows, friends, unseen: (unseen.results[0] || {}).n || 0, blocked: blocked.results.map(b => ({ id: b.id, name: b.name || 'Former player' })), feed: feed.results.filter(f => !hide.has(f.player_id)).map(f => ({ id: f.player_id, name: f.name, lessonId: f.lesson_id, title: f.title, acc: f.acc, xp: f.xp, at: f.created_at })) });
  }

  // ---- synced progress (review schedule, practice days, streak settings) ----
  if (m === 'GET' && path === '/api/state') {
    const r = await env.DB.prepare('SELECT json, updated_at FROM player_state WHERE player_id = ?').bind(me.id).first();
    return json({ state: r ? JSON.parse(r.json) : null, updatedAt: r ? r.updated_at : null });
  }
  if (m === 'POST' && path === '/api/state') {
    const text = await req.text();
    if (new TextEncoder().encode(text).length > 800000) return fail('Progress is too large to sync.', 413);
    let st; try { st = safeParse(text).state; } catch { return fail('That isn’t valid JSON.'); }
    const obj = v => v && typeof v === 'object' && !Array.isArray(v);
    if (!obj(st) || !obj(st.srs)) return fail('Bad progress data.');
    if (st.activeDays !== undefined && !Array.isArray(st.activeDays)) return fail('Bad progress data.');
    if (st.settings !== undefined && st.settings !== null && !obj(st.settings)) return fail('Bad progress data.');
    // Practice days: real dates only, not in the future. Streak settings: lists capped, so the board stays fast.
    if (st.activeDays) st.activeDays = st.activeDays.filter(d => realDay(d) && d <= utcDay(1)).slice(-2000);
    if (obj(st.settings)) ['pauses', 'past'].forEach(k => { if (st.settings[k] !== undefined) st.settings[k] = Array.isArray(st.settings[k]) ? st.settings[k].slice(-50) : []; });
    // Bought freezes and repaired days: real dates, not in the future, capped.
    if (obj(st.settings)) ['bought', 'repaired'].forEach(k => { if (st.settings[k] !== undefined) st.settings[k] = Array.isArray(st.settings[k]) ? st.settings[k].filter(d => realDay(d) && d <= utcDay(1)).slice(-400) : []; });
    await env.DB.prepare('INSERT INTO player_state (player_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at').bind(me.id, JSON.stringify(st), Date.now()).run();
    return json({ ok: true });
  }

  // ---- group-made courses ----
  if (m === 'GET' && path === '/api/courses') {
    const rows = await env.DB.prepare(`SELECT c.id, c.slug, c.title, c.json, c.version, c.author_id, p.name AS author, c.created_at, c.updated_at,
      (SELECT COUNT(*) FROM reports r WHERE r.course_id = c.id AND r.resolved = 0) AS open_reports
      FROM courses c JOIN players p ON p.id = c.author_id WHERE c.group_code = ? AND c.author_id NOT IN (SELECT blocked_id FROM blocks WHERE player_id = ?) ORDER BY c.created_at`).bind(me.group_code, me.id).all();
    return json({ courses: rows.results.map(r => ({ slug: r.slug, title: r.title, version: r.version, authorId: r.author_id, author: r.author, createdAt: r.created_at, updatedAt: r.updated_at, openReports: r.open_reports, course: JSON.parse(r.json) })) });
  }

  if (m === 'POST' && path === '/api/courses') {
    const text = await req.text();
    if (text.length > COURSE_LIMITS.bytes + 1000) return fail('That course file is too large.', 413);
    let raw; try { raw = safeParse(text).course; } catch { return fail('That isn’t valid JSON.'); }
    const v = validateCourse(raw);
    if (!v.ok) return json({ error: 'The course has problems.', errors: v.errors }, 422);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM courses WHERE group_code = ?').bind(me.group_code).first();
    const existing = await env.DB.prepare('SELECT id, author_id, version, json FROM courses WHERE group_code = ? AND slug = ?').bind(me.group_code, v.course.id).first();
    const body = JSON.stringify(v.course), now = Date.now();
    if (existing && existing.author_id !== me.id) return fail('Someone else in this group already has a course with that id. Change "id" in your file.', 409);
    if (existing && existing.json === body) return json({ slug: v.course.id, version: existing.version, updated: false, unchanged: true });
    if (!existing && n.n >= 50) return fail('This group already has 50 courses.', 403);
    // Every part of the course is screened (in pieces if it's long), within the daily caps.
    const cmod = await screen(env, req, body);
    if (!cmod.allowed) return screenFail(fail, cmod, 'This course can’t be posted: ');
    if (existing) {
      await env.DB.prepare('UPDATE courses SET title = ?, json = ?, version = version + 1, updated_at = ? WHERE id = ?').bind(v.course.title, body, now, existing.id).run();
      return json({ slug: v.course.id, version: existing.version + 1, updated: true });
    }
    await env.DB.prepare('INSERT INTO courses (group_code, slug, author_id, title, json, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').bind(me.group_code, v.course.id, me.id, v.course.title, body, now, now).run();
    return json({ slug: v.course.id, version: 1, updated: false });
  }

  const cm = path.match(/^\/api\/courses\/([a-z0-9-]{2,40})(\/reports|\/delete)?$/);
  if (cm) {
    // An author can still delete a course they wrote after leaving its group.
    const c = await env.DB.prepare('SELECT id, author_id, version FROM courses WHERE group_code = ? AND slug = ?').bind(me.group_code, cm[1]).first()
      || (cm[2] === '/delete' ? await env.DB.prepare('SELECT id, author_id, version FROM courses WHERE author_id = ? AND slug = ? ORDER BY updated_at DESC').bind(me.id, cm[1]).first() : null);
    if (!c) return fail('No course with that id in this group.', 404);
    if (m === 'POST' && cm[2] === '/reports') {
      const b = await body(req);
      const note = cleanName(b.note, 500), itemText = cleanName(b.itemText, 300), lessonId = typeof b.lessonId === 'string' && /^[A-Za-z0-9:#._-]{0,90}$/.test(b.lessonId) ? b.lessonId : '';
      if (!note) return fail('Say what’s wrong.');
      const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM reports WHERE player_id = ? AND created_at > ?').bind(me.id, Date.now() - 3600000).first();
      if (recent.n >= 30) return fail('That’s a lot of reports this hour. Try again later.', 429);
      await env.DB.prepare('INSERT INTO reports (course_id, player_id, lesson_id, item_text, note, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(c.id, me.id, lessonId, itemText || '(no text)', note, c.version, Date.now()).run();
      return json({ ok: true });
    }
    if (c.author_id !== me.id) return fail('Only the course’s author can do that.', 403);
    if (m === 'GET' && cm[2] === '/reports') {
      const r = await env.DB.prepare('SELECT r.id, r.lesson_id, r.item_text, r.note, r.version, r.created_at, p.name FROM reports r JOIN players p ON p.id = r.player_id WHERE r.course_id = ? AND r.resolved = 0 AND r.player_id NOT IN (SELECT blocked_id FROM blocks WHERE player_id = ?) ORDER BY r.created_at DESC').bind(c.id, me.id).all();
      return json({ reports: r.results.map(x => ({ id: x.id, lessonId: x.lesson_id, itemText: x.item_text, note: x.note, version: x.version, at: x.created_at, by: x.name })) });
    }
    if (m === 'POST' && cm[2] === '/delete') {
      await env.DB.batch([env.DB.prepare('DELETE FROM reports WHERE course_id = ?').bind(c.id), env.DB.prepare('DELETE FROM courses WHERE id = ?').bind(c.id)]);
      return json({ ok: true });
    }
  }
  const rm = path.match(/^\/api\/reports\/(\d+)\/resolve$/);
  if (m === 'POST' && rm) {
    const r = await env.DB.prepare('SELECT r.id FROM reports r JOIN courses c ON c.id = r.course_id WHERE r.id = ? AND c.author_id = ?').bind(+rm[1], me.id).first();
    if (!r) return fail('Report not found.', 404);
    await env.DB.prepare('UPDATE reports SET resolved = 1 WHERE id = ?').bind(r.id).run();
    return json({ ok: true });
  }

  return fail('Not found.', 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }), req);
      // JSON only: a plain form or text post from another website can't reach the API without the browser asking first.
      if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers.get('Content-Type') || '')) return withCors(fail('Send JSON.', 415), req);
      if (+(req.headers.get('Content-Length') || 0) > 1000000) return withCors(fail('That request is too large.', 413), req);
      try { return withCors(await api(req, env, url.pathname), req); }
      catch (e) { console.log('server error', url.pathname, e && e.message); return withCors(fail('Server error.', 500), req); }
    }
    // Lets the iPhone app use this site's passkeys (Apple's associated domains, webcredentials).
    if (url.pathname === '/.well-known/apple-app-site-association') {
      return new Response(JSON.stringify(APPLE_APP_SITE_ASSOCIATION), { headers: { 'Content-Type': 'application/json' } });
    }
    // Course content for the iPhone app, whose page runs at capacitor://localhost and so needs CORS to read it.
    if (url.pathname === '/content.json') {
      const r = await env.ASSETS.fetch(req);
      return withCors(new Response(r.body, r), req);
    }
    return env.ASSETS.fetch(req);
  }
};
