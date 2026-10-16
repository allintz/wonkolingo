// Hill Speak group play API. Static files come from ./docs; only /api/* reaches this code.
// Identity is a random token per player (no passwords). The token doubles as a recovery code.

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
// Consecutive days with a finished lesson, ending today or yesterday (in the viewer's calendar).
function streakOf(days, today) {
  const set = new Set(days);
  let start = set.has(today) ? today : set.has(shiftDay(today, -1)) ? shiftDay(today, -1) : null;
  if (!start) return { streak: 0, atRisk: false };
  let n = 0, d = start;
  while (set.has(d)) { n++; d = shiftDay(d, -1); }
  return { streak: n, atRisk: start !== today };
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

  const me = await auth(req, env);
  if (!me) return fail('Not signed in to a group.', 401);

  if (m === 'GET' && path === '/api/me') return json({ code: me.group_code, groupName: me.group_name, player: { id: me.id, name: me.name } });

  if (m === 'POST' && path === '/api/complete') {
    const b = await body(req);
    const xp = Math.max(0, Math.min(100, Math.round(+b.xp || 0)));
    const acc = Math.max(0, Math.min(100, Math.round(+b.acc || 0)));
    const lessonId = String(b.lessonId || '').slice(0, 20), title = cleanName(b.title, 60);
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
    const [players, totals, days, feed] = await env.DB.batch([
      env.DB.prepare('SELECT id, name FROM players WHERE group_code = ?').bind(g),
      env.DB.prepare('SELECT player_id, SUM(xp) AS total, SUM(CASE WHEN created_at >= ? THEN xp ELSE 0 END) AS week, COUNT(*) AS lessons FROM completions WHERE group_code = ? GROUP BY player_id').bind(ws, g),
      env.DB.prepare('SELECT DISTINCT player_id, day FROM completions WHERE group_code = ? AND day >= ?').bind(g, shiftDay(today, -400)),
      env.DB.prepare('SELECT c.player_id, p.name, c.lesson_id, c.title, c.acc, c.xp, c.created_at FROM completions c JOIN players p ON p.id = c.player_id WHERE c.group_code = ? ORDER BY c.created_at DESC LIMIT 12').bind(g)
    ]);
    const tot = new Map(totals.results.map(r => [r.player_id, r]));
    const dayMap = new Map();
    for (const r of days.results) { if (!dayMap.has(r.player_id)) dayMap.set(r.player_id, []); dayMap.get(r.player_id).push(r.day); }
    const rows = players.results.map(p => {
      const t = tot.get(p.id) || {};
      return { id: p.id, name: p.name, week: t.week || 0, total: t.total || 0, lessons: t.lessons || 0, ...streakOf(dayMap.get(p.id) || [], today) };
    });
    return json({ code: g, groupName: me.group_name, me: me.id, weekStart: ws, players: rows, feed: feed.results.map(f => ({ id: f.player_id, name: f.name, lessonId: f.lesson_id, title: f.title, acc: f.acc, xp: f.xp, at: f.created_at })) });
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
