// WonkoLingo group play API. Static files come from ./docs; only /api/* reaches this code.
// Identity is a random token per player (no passwords). The token doubles as a recovery code.

import { validateCourse, COURSE_LIMITS, computeStreak } from './course-format.js';
import Anthropic from '@anthropic-ai/sdk';
import { gradeAnswer, takeGradeQuota, hintFor } from './grade.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const fail = (msg, status = 400) => json({ error: msg }, status);

function randomString(n, alphabet) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}
async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}
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
  const p = await env.DB.prepare('SELECT p.id, p.name, p.group_code, p.key_hash, g.name AS group_name FROM players p JOIN groups g ON g.code = p.group_code WHERE p.id = ?').bind(id).first();
  if (!p || p.key_hash !== await sha256(secret)) return null;
  return p;
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
    const g = await env.DB.prepare('SELECT name FROM groups WHERE code = ?').bind(code).first();
    if (!g) return fail('No group with that code.', 404);
    const taken = await env.DB.prepare('SELECT 1 FROM players WHERE group_code = ? AND lower(name) = lower(?)').bind(code, pname).first();
    if (taken) return fail('Someone in this group already uses that name. If it’s you, use your recovery code.', 409);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM players WHERE group_code = ?').bind(code).first();
    if (n.n >= 200) return fail('This group is full.', 403);
    const p = await createPlayer(env, code, pname);
    return json({ code, groupName: g.name, player: { id: p.id, name: pname }, token: p.token });
  }

  // Grading and hints work without a group: visitors are counted by a hash of their IP for the daily cap.
  if (m === 'POST' && (path === '/api/grade' || path === '/api/hint')) {
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
  if (!me) return fail('Not signed in to a group.', 401);

  if (m === 'GET' && path === '/api/me') return json({ code: me.group_code, groupName: me.group_name, player: { id: me.id, name: me.name } });

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
