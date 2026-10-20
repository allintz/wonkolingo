// WonkoLingo group play API. Static files come from ./docs; only /api/* reaches this code.
// Identity is a random token per player (no passwords). The token doubles as a recovery code.
// Every player has an account; groups are optional (see accounts.js for passkeys, sign-in codes and home groups).

import { validateCourse, COURSE_LIMITS, computeStreak } from './course-format.js';
import Anthropic from '@anthropic-ai/sdk';
import { gradeAnswer, takeGradeQuota, takeDisputeQuota, hintFor, defineTerm } from './grade.js';
import { randomString, sha256, accountInfo, publicAccountApi, accountApi } from './accounts.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const fail = (msg, status = 400) => json({ error: msg }, status);

function cleanName(s, max) {
  return String(s || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
async function body(req) { try { return await req.json(); } catch { return {}; } }

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
  if (p.key_hash === h2) return p;
  // Devices signed in by passkey or sign-in code have their own secret.
  const s = await env.DB.prepare('SELECT 1 FROM sessions WHERE player_id = ? AND key_hash = ?').bind(id, h2).first();
  return s ? p : null;
}

// Identity for grading quotas: the signed-in player, or a salted hash of the visitor's IP.
async function graderId(req, env) {
  const me = await auth(req, env);
  if (me) return me.id;
  return 'ip:' + (await sha256('wl-grade:' + (req.headers.get('CF-Connecting-IP') || 'unknown'))).slice(0, 16);
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
  if (me.solo) stmts.push(
    env.DB.prepare('UPDATE completions SET group_code = ? WHERE player_id = ? AND group_code = ?').bind(code, me.id, me.group_code),
    env.DB.prepare('UPDATE OR IGNORE courses SET group_code = ? WHERE group_code = ?').bind(code, me.group_code),
    env.DB.prepare('DELETE FROM groups WHERE code = ? AND solo = 1 AND NOT EXISTS (SELECT 1 FROM courses WHERE group_code = ?)').bind(me.group_code, me.group_code));
  await env.DB.batch(stmts);
}

async function api(req, env, path) {
  const m = req.method;

  if (m === 'POST' && path === '/api/groups') {
    const b = await body(req);
    const gname = cleanName(b.groupName, 40), pname = cleanName(b.name, 24);
    if (!gname || !pname) return fail('Group name and your name are both required.');
    let code;
    for (let i = 0; i < 5; i++) {
      code = randomString(6, CODE_ALPHABET);
      const r = await env.DB.prepare('INSERT OR IGNORE INTO groups (code, name, created_at) VALUES (?, ?, ?)').bind(code, gname, Date.now()).run();
      if (r.meta.changes) break;
      code = null;
    }
    if (!code) return fail('Could not create a group. Try again.', 500);
    const me = await auth(req, env);
    if (me) { await moveToGroup(env, me, code, pname); return json({ code, groupName: gname, player: { id: me.id, name: pname } }); }
    const p = await createPlayer(env, code, pname);
    return json({ code, groupName: gname, player: { id: p.id, name: pname }, token: p.token });
  }

  const gm = path.match(/^\/api\/groups\/([A-Za-z0-9]{6})$/);
  if (m === 'GET' && gm) {
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
    const taken = await env.DB.prepare('SELECT 1 FROM players WHERE group_code = ? AND lower(name) = lower(?) AND id != ?').bind(code, pname, me ? me.id : '').first();
    if (taken) return fail('Someone in this group already uses that name. If it’s you, sign in to your account instead.', 409);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM players WHERE group_code = ?').bind(code).first();
    if (n.n >= 200 && !(me && me.group_code === code)) return fail('This group is full.', 403);
    if (me) { await moveToGroup(env, me, code, pname); return json({ code, groupName: g.name, player: { id: me.id, name: pname } }); }
    const p = await createPlayer(env, code, pname);
    return json({ code, groupName: g.name, player: { id: p.id, name: pname }, token: p.token });
  }

  const acct = await publicAccountApi(req, env, path, { json, fail, body });
  if (acct) return acct;

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
        .bind(who, String(b.course || '').slice(0, 80), String(b.card || '').slice(0, 120), String(b.question).slice(0, 700), String(b.answer).slice(0, 700), String(b.response).slice(0, 1200), note, JSON.stringify(first).slice(0, 4000), Date.now()).run();
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
  const mine = await accountApi(req, env, path, me, { json, fail, body });
  if (mine) return mine;

  if (m === 'POST' && path === '/api/complete') {
    const b = await body(req);
    const xp = Math.max(0, Math.min(500, Math.round(+b.xp || 0)));
    const acc = Math.max(0, Math.min(100, Math.round(+b.acc || 0)));
    const lessonId = String(b.lessonId || '').slice(0, 90), title = cleanName(b.title, 60);
    if (!lessonId || !title || !DAY_RE.test(b.day || '')) return fail('Bad completion.');
    // At most one completion of the same lesson per minute, to blunt double-submits.
    const dup = await env.DB.prepare('SELECT 1 FROM completions WHERE player_id = ? AND lesson_id = ? AND created_at > ?').bind(me.id, lessonId, Date.now() - 60000).first();
    if (!dup) await env.DB.prepare('INSERT INTO completions (player_id, group_code, lesson_id, title, xp, acc, day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(me.id, me.group_code, lessonId, title, xp, acc, b.day, Date.now()).run();
    return json({ ok: true });
  }

  if (m === 'GET' && path === '/api/board') {
    const url = new URL(req.url);
    const today = DAY_RE.test(url.searchParams.get('today') || '') ? url.searchParams.get('today') : new Date().toISOString().slice(0, 10);
    const ws = weekStart();
    const g = me.group_code;
    const [players, totals, days, feed, states] = await env.DB.batch([
      env.DB.prepare('SELECT id, name FROM players WHERE group_code = ?').bind(g),
      env.DB.prepare('SELECT player_id, SUM(xp) AS total, SUM(CASE WHEN created_at >= ? THEN xp ELSE 0 END) AS week, COUNT(*) AS lessons FROM completions WHERE group_code = ? GROUP BY player_id').bind(ws, g),
      env.DB.prepare('SELECT DISTINCT player_id, day FROM completions WHERE group_code = ? AND day >= ?').bind(g, shiftDay(today, -400)),
      env.DB.prepare('SELECT c.player_id, p.name, c.lesson_id, c.title, c.acc, c.xp, c.created_at FROM completions c JOIN players p ON p.id = c.player_id WHERE c.group_code = ? ORDER BY c.created_at DESC LIMIT 12').bind(g),
      env.DB.prepare("SELECT s.player_id, json_extract(s.json, '$.activeDays') AS ad, json_extract(s.json, '$.settings') AS st FROM player_state s JOIN players p ON p.id = s.player_id WHERE p.group_code = ?").bind(g)
    ]);
    const synced = new Map(states.results.map(r => { let ad = null, st = null; try { ad = JSON.parse(r.ad); } catch {} try { st = JSON.parse(r.st); } catch {} return [r.player_id, { ad, st }]; }));
    const tot = new Map(totals.results.map(r => [r.player_id, r]));
    const dayMap = new Map();
    for (const r of days.results) { if (!dayMap.has(r.player_id)) dayMap.set(r.player_id, []); dayMap.get(r.player_id).push(r.day); }
    const rows = players.results.map(p => {
      const t = tot.get(p.id) || {};
      // Prefer the player's synced practice days and streak settings; fall back to days with posted results.
      const sy = synced.get(p.id) || {};
      const daysFor = Array.isArray(sy.ad) ? sy.ad.concat(dayMap.get(p.id) || []) : (dayMap.get(p.id) || []);
      const st = computeStreak(daysFor, sy.st, today);
      return { id: p.id, name: p.name, week: t.week || 0, total: t.total || 0, lessons: t.lessons || 0, streak: st.streak, atRisk: st.atRisk, freezes: st.freezes, offToday: st.offToday };
    });
    return json({ code: g, groupName: me.group_name, me: me.id, weekStart: ws, players: rows, feed: feed.results.map(f => ({ id: f.player_id, name: f.name, lessonId: f.lesson_id, title: f.title, acc: f.acc, xp: f.xp, at: f.created_at })) });
  }

  // ---- synced progress (review schedule, practice days, streak settings) ----
  if (m === 'GET' && path === '/api/state') {
    const r = await env.DB.prepare('SELECT json, updated_at FROM player_state WHERE player_id = ?').bind(me.id).first();
    return json({ state: r ? JSON.parse(r.json) : null, updatedAt: r ? r.updated_at : null });
  }
  if (m === 'POST' && path === '/api/state') {
    const text = await req.text();
    if (text.length > 800000) return fail('Progress is too large to sync.', 413);
    let st; try { st = JSON.parse(text).state; } catch { return fail('That isn’t valid JSON.'); }
    if (!st || typeof st !== 'object' || Array.isArray(st) || typeof st.srs !== 'object') return fail('Bad progress data.');
    await env.DB.prepare('INSERT INTO player_state (player_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at').bind(me.id, JSON.stringify(st), Date.now()).run();
    return json({ ok: true });
  }

  // ---- group-made courses ----
  if (m === 'GET' && path === '/api/courses') {
    const rows = await env.DB.prepare(`SELECT c.id, c.slug, c.title, c.json, c.version, c.author_id, p.name AS author, c.updated_at,
      (SELECT COUNT(*) FROM reports r WHERE r.course_id = c.id AND r.resolved = 0) AS open_reports
      FROM courses c JOIN players p ON p.id = c.author_id WHERE c.group_code = ? ORDER BY c.created_at`).bind(me.group_code).all();
    return json({ courses: rows.results.map(r => ({ slug: r.slug, title: r.title, version: r.version, authorId: r.author_id, author: r.author, updatedAt: r.updated_at, openReports: r.open_reports, course: JSON.parse(r.json) })) });
  }

  if (m === 'POST' && path === '/api/courses') {
    const text = await req.text();
    if (text.length > COURSE_LIMITS.bytes + 1000) return fail('That course file is too large.', 413);
    let raw; try { raw = JSON.parse(text).course; } catch { return fail('That isn’t valid JSON.'); }
    const v = validateCourse(raw);
    if (!v.ok) return json({ error: 'The course has problems.', errors: v.errors }, 422);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM courses WHERE group_code = ?').bind(me.group_code).first();
    const existing = await env.DB.prepare('SELECT id, author_id, version FROM courses WHERE group_code = ? AND slug = ?').bind(me.group_code, v.course.id).first();
    const body = JSON.stringify(v.course), now = Date.now();
    if (existing) {
      if (existing.author_id !== me.id) return fail('Someone else in this group already has a course with that id. Change "id" in your file.', 409);
      await env.DB.prepare('UPDATE courses SET title = ?, json = ?, version = version + 1, updated_at = ? WHERE id = ?').bind(v.course.title, body, now, existing.id).run();
      return json({ slug: v.course.id, version: existing.version + 1, updated: true });
    }
    if (n.n >= 50) return fail('This group already has 50 courses.', 403);
    await env.DB.prepare('INSERT INTO courses (group_code, slug, author_id, title, json, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').bind(me.group_code, v.course.id, me.id, v.course.title, body, now, now).run();
    return json({ slug: v.course.id, version: 1, updated: false });
  }

  const cm = path.match(/^\/api\/courses\/([a-z0-9-]{2,40})(\/reports|\/delete)?$/);
  if (cm) {
    const c = await env.DB.prepare('SELECT id, author_id, version FROM courses WHERE group_code = ? AND slug = ?').bind(me.group_code, cm[1]).first();
    if (!c) return fail('No course with that id in this group.', 404);
    if (m === 'POST' && cm[2] === '/reports') {
      const b = await body(req);
      const note = cleanName(b.note, 500), itemText = cleanName(b.itemText, 300), lessonId = String(b.lessonId || '').slice(0, 90);
      if (!note) return fail('Say what’s wrong.');
      const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM reports WHERE player_id = ? AND created_at > ?').bind(me.id, Date.now() - 3600000).first();
      if (recent.n >= 30) return fail('That’s a lot of reports this hour. Try again later.', 429);
      await env.DB.prepare('INSERT INTO reports (course_id, player_id, lesson_id, item_text, note, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(c.id, me.id, lessonId, itemText || '(no text)', note, c.version, Date.now()).run();
      return json({ ok: true });
    }
    if (c.author_id !== me.id) return fail('Only the course’s author can do that.', 403);
    if (m === 'GET' && cm[2] === '/reports') {
      const r = await env.DB.prepare('SELECT r.id, r.lesson_id, r.item_text, r.note, r.version, r.created_at, p.name FROM reports r JOIN players p ON p.id = r.player_id WHERE r.course_id = ? AND r.resolved = 0 ORDER BY r.created_at DESC').bind(c.id).all();
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
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      try { return await api(req, env, url.pathname); }
      catch (e) { return fail('Server error.', 500); }
    }
    return env.ASSETS.fetch(req);
  }
};
