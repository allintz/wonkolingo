// The review page (/admin.html): disputed grades, removed questions, crash reports, reports on group courses and tester ratings, in one
// place instead of shell scripts. Only players listed in ADMIN_PLAYERS (wrangler.toml [vars], comma-separated ids) get in.
const isAdmin = (env, me) => !!me && String(env.ADMIN_PLAYERS || '').split(',').map(s => s.trim()).filter(Boolean).includes(me.id);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const KINDS = ['dispute', 'bug', 'removal', 'report', 'session'];

export async function adminApi(req, env, path, me, body) {
  if (!isAdmin(env, me)) return json({ error: 'Not allowed.' }, 403);
  const db = env.DB;
  if (req.method === 'GET' && path === '/api/admin/summary') {
    const [disputes, removals, bugs, reports, ratings, sessions] = await Promise.all([
      db.prepare(`SELECT id, created_at AS at, course, card, question, answer, response, note, outcome,
          json_extract(first_json, '$.percent') AS firstPct, json_extract(regrade_json, '$.percent') AS regradePct,
          json_extract(regrade_json, '$.reply') AS reply FROM disputes WHERE status = 'open' ORDER BY id DESC LIMIT 100`).all(),
      // Removals since the card was last marked reviewed, most-removed first.
      db.prepare(`SELECT f.course, f.card, MAX(f.question) AS question, SUM(f.reason != 'restored') AS removed, SUM(f.reason = 'restored') AS restored,
          group_concat(CASE WHEN f.reason != 'restored' THEN f.reason END) AS reasons, MAX(f.created_at) AS at
          FROM card_feedback f LEFT JOIN review_marks m ON m.kind = 'removal' AND m.ref = f.course || '|' || f.card
          WHERE m.at IS NULL OR f.created_at > m.at GROUP BY f.course, f.card HAVING removed > 0 ORDER BY removed DESC, at DESC LIMIT 100`).all(),
      db.prepare(`SELECT id, created_at AS at, build, app, place, message, substr(stack, 1, 600) AS stack, ua FROM bug_reports WHERE done = 0 ORDER BY id DESC LIMIT 100`).all(),
      db.prepare(`SELECT r.id, r.created_at AS at, r.item_text AS item, r.note, r.version, c.title, c.slug FROM reports r JOIN courses c ON c.id = r.course_id
          WHERE r.resolved = 0 ORDER BY r.id DESC LIMIT 100`).all(),
      // Tester ratings per card, furthest from the target (useful 5, level 3) first. A ranking, not an inbox: nothing to mark done.
      db.prepare(`SELECT course, card, MAX(question) AS question, COUNT(*) AS n, AVG(useful) AS useful, COUNT(useful) AS nUseful,
          AVG(level) AS level, COUNT(level) AS nLevel, SUM(level <= 2) AS basic, SUM(level >= 4) AS hard,
          group_concat(CASE WHEN comment != '' THEN comment END, ' || ') AS comments, MAX(updated_at) AS at
          FROM card_ratings GROUP BY course, card
          ORDER BY COALESCE(5 - AVG(useful), 0) + COALESCE(ABS(AVG(level) - 3), 0) DESC, n DESC LIMIT 200`).all(),
      db.prepare(`SELECT id, created_at AS at, courses, cards, comment FROM session_feedback WHERE done = 0 ORDER BY id DESC LIMIT 100`).all()
    ]);
    return json({ disputes: disputes.results, removals: removals.results, bugs: bugs.results, reports: reports.results, ratings: ratings.results, sessions: sessions.results });
  }
  if (req.method === 'POST' && path === '/api/admin/resolve') {
    // Disputes, bugs and reports by their numeric id; a removed question by "course|card".
    const kind = body.kind, ref = typeof body.id === 'string' || typeof body.id === 'number' ? String(body.id).trim().slice(0, 300) : '';
    const numeric = kind !== 'removal';
    if (!KINDS.includes(kind) || (numeric ? !/^[1-9]\d{0,12}$/.test(ref) : !/^[^|]+\|[^|]+$/.test(ref))) return json({ error: 'Unknown item.' }, 400);
    if (kind === 'dispute') await db.prepare(`UPDATE disputes SET status = 'done' WHERE id = ?`).bind(+ref).run();
    if (kind === 'bug') await db.prepare('UPDATE bug_reports SET done = 1 WHERE id = ?').bind(+ref).run();
    if (kind === 'session') await db.prepare('UPDATE session_feedback SET done = 1 WHERE id = ?').bind(+ref).run();
    if (kind === 'report') await db.prepare('UPDATE reports SET resolved = 1 WHERE id = ?').bind(+ref).run();
    if (kind === 'removal') await db.prepare('INSERT OR REPLACE INTO review_marks (kind, ref, at) VALUES (?, ?, ?)').bind('removal', ref, Date.now()).run();
    return json({ ok: true });
  }
  return json({ error: 'Not found.' }, 404);
}
