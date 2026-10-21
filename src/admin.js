// The review page (/admin.html): disputed grades, removed questions, crash reports, reports on group courses and tester ratings, in one
// place instead of shell scripts. Only players listed in ADMIN_PLAYERS (wrangler.toml [vars], comma-separated ids) get in.
const isAdmin = (env, me) => !!me && String(env.ADMIN_PLAYERS || '').split(',').map(s => s.trim()).filter(Boolean).includes(me.id);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const KINDS = ['dispute', 'bug', 'removal', 'report', 'session'];

// Tester ratings per card, each tester's own scores kept, furthest from the target (useful 5, level 3) first. A ranking, not an
// inbox: nothing to mark done. The page checks each rating's question text against the current card to flag changed cards.
function ratingsByCard(rows) {
  const cards = new Map(), avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  for (const r of rows) {
    const k = r.course + '|' + r.card;
    if (!cards.has(k)) cards.set(k, { course: r.course, card: r.card, question: r.question, at: r.at, rows: [] });
    cards.get(k).rows.push({ name: r.name, useful: r.useful, level: r.level, comment: r.comment, question: r.question, at: r.at });
  }
  const out = [...cards.values()].map(c => {
    const u = c.rows.map(r => r.useful).filter(v => v != null), l = c.rows.map(r => r.level).filter(v => v != null);
    return { ...c, n: c.rows.length, useful: avg(u), nUseful: u.length, level: avg(l), nLevel: l.length };
  });
  const off = c => (c.useful == null ? 0 : 5 - c.useful) + (c.level == null ? 0 : Math.abs(c.level - 3));
  return out.sort((a, b) => off(b) - off(a) || b.n - a.n).slice(0, 300);
}

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
      // Every tester rating with the tester's name; grouped per card below.
      db.prepare(`SELECT r.course, r.card, r.question, r.useful, r.level, r.comment, r.updated_at AS at, COALESCE(p.name, 'visitor') AS name
          FROM card_ratings r LEFT JOIN players p ON p.id = r.who ORDER BY r.updated_at DESC LIMIT 5000`).all(),
      db.prepare(`SELECT f.id, f.created_at AS at, f.courses, f.cards, f.comment, COALESCE(p.name, 'visitor') AS name FROM session_feedback f
          LEFT JOIN players p ON p.id = f.who WHERE f.done = 0 ORDER BY f.id DESC LIMIT 100`).all()
    ]);
    return json({ disputes: disputes.results, removals: removals.results, bugs: bugs.results, reports: reports.results, ratings: ratingsByCard(ratings.results), sessions: sessions.results });
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
