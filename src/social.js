// Friend streaks, nudges, high-fives and the notification inbox.
// A friend streak is between two players in the same group. Each day counts when both practiced; a day either one kept
// their own streak on (off day, pause, freeze, repair) holds it without adding; a day either one simply missed resets it.
// Notes are short notifications for one player (nudge, high-five, friend-streak request or accept), kept 30 days.
import { takeRate } from './accounts.js';
import { pushTo } from './push.js';

export const SOCIAL_LIMITS = { friendStreaks: 5, notesKept: 40, nudgeEmailsPerDay: 2 };
const NOTE_KINDS = ['nudge', 'kudos', 'fs_request', 'fs_accept'];
const pairKey = (x, y) => x < y ? [x, y] : [y, x];
const next = d => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };

// One pair's streak from its start day. A and B: { practiced: Set, kept: Set } from computeStreak.
export function pairStreak(A, B, started, today) {
  let n = 0, best = 0;
  for (let d = started; d < today; d = next(d)) {
    if (A.kept.has(d) && B.kept.has(d)) { if (A.practiced.has(d) && B.practiced.has(d)) n++; }
    else n = 0;
    best = Math.max(best, n);
  }
  const aDone = A.practiced.has(today), bDone = B.practiced.has(today);
  if (aDone && bDone) { n++; best = Math.max(best, n); }
  return { count: n, best, aDone, bDone };
}

// Friend streak rows for the board. per: Map of player id -> { practiced, kept, name }.
export async function friendRows(env, me, per, today, hide) {
  const r = await env.DB.prepare('SELECT a, b, status, requested_by, started FROM friend_streaks WHERE a = ? OR b = ?').bind(me.id, me.id).all();
  return r.results.map(f => {
    const other = f.a === me.id ? f.b : f.a;
    if (hide.has(other) || !per.has(other)) return null; // blocked, or no longer in the group
    const row = { id: other, name: per.get(other).name, status: f.status, mine: f.requested_by === me.id };
    if (f.status !== 'active') return row;
    const s = pairStreak(per.get(me.id), per.get(other), f.started, today);
    return { ...row, count: s.count, best: s.best, meDone: s.aDone, themDone: s.bDone, started: f.started };
  }).filter(Boolean);
}

// What each notification says on the phone's lock screen.
const PUSH_TEXT = {
  nudge: n => `${n} nudged you. Time for a quick round?`,
  kudos: n => `${n} high-fived your session.`,
  fs_request: n => `${n} wants to start a friend streak with you.`,
  fs_accept: n => `${n} accepted. Your friend streak starts today.`
};
async function note(env, to, from, kind, ref) {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO notes (player_id, from_id, kind, ref, created_at, seen) VALUES (?, ?, ?, ?, ?, 0)').bind(to, from.id, kind, ref || '', Date.now()),
    env.DB.prepare('DELETE FROM notes WHERE player_id = ? AND created_at < ?').bind(to, Date.now() - 30 * 864e5)]);
  await pushTo(env, to, { title: 'WonkoLingo', body: PUSH_TEXT[kind](from.name), kind });
}
// After a player finishes a round: each friend-streak partner who hasn't practiced today gets one "your turn" push a day.
export async function friendTurnPushes(env, me, day) {
  try {
    const pals = (await env.DB.prepare(`SELECT CASE WHEN f.a = ? THEN f.b ELSE f.a END AS id FROM friend_streaks f
      WHERE (f.a = ? OR f.b = ?) AND f.status = 'active'`).bind(me.id, me.id, me.id).all()).results;
    for (const { id } of pals) {
      const p = await env.DB.prepare("SELECT p.group_code, s.json LIKE ? AS done FROM players p LEFT JOIN player_state s ON s.player_id = p.id WHERE p.id = ?").bind('%"' + day + '"%', id).first();
      if (!p || p.group_code !== me.group_code || p.done) continue;
      if (!await takeRate(env, 'turn:' + me.id + ':' + id, 1, 'day')) continue;
      await pushTo(env, id, { title: 'Your turn', body: `${me.name} practiced today. Keep your friend streak going.`, kind: 'turn' });
    }
  } catch (e) { console.log('turn push error', String(e && e.message)); }
}
// The other player must be in the same group and neither may have blocked the other.
async function peer(env, me, id) {
  if (typeof id !== 'string' || !id || id === me.id) return null;
  const p = await env.DB.prepare('SELECT id, name, group_code FROM players WHERE id = ?').bind(id).first();
  if (!p || p.group_code !== me.group_code) return null;
  const b = await env.DB.prepare('SELECT 1 FROM blocks WHERE (player_id = ? AND blocked_id = ?) OR (player_id = ? AND blocked_id = ?)').bind(me.id, id, id, me.id).first();
  return b ? null : p;
}

export async function socialApi(req, env, path, me, { json, fail, body, today, dayOk, sendNudgeEmail }) {
  const m = req.method;
  if (m === 'GET' && path === '/api/inbox') {
    const r = await env.DB.prepare(`SELECT n.id, n.kind, n.ref, n.created_at, n.seen, n.from_id, p.name FROM notes n LEFT JOIN players p ON p.id = n.from_id
      WHERE n.player_id = ? AND n.from_id NOT IN (SELECT blocked_id FROM blocks WHERE player_id = ?) ORDER BY n.created_at DESC LIMIT ?`).bind(me.id, me.id, SOCIAL_LIMITS.notesKept).all();
    return json({ notes: r.results.map(n => ({ id: n.id, kind: n.kind, ref: n.ref, at: n.created_at, seen: !!n.seen, from: n.from_id, name: n.name || 'Former player' })) });
  }
  if (m === 'POST' && path === '/api/inbox/seen') {
    await env.DB.prepare('UPDATE notes SET seen = 1 WHERE player_id = ? AND seen = 0').bind(me.id).run();
    return json({ ok: true });
  }
  if (m !== 'POST' || !/^\/api\/(nudge|kudos|friend\/(request|accept|end))$/.test(path)) return null;
  const b = await body(req);
  // A friend streak starts on the player's own date (sent by the app), if it's within a day of the server's.
  if (dayOk(b.today)) today = b.today;
  // Ending (or declining, or cancelling) needs no checks: removing your own pair is always allowed, even with someone
  // who has since left the group or been blocked.
  if (path === '/api/friend/end') {
    if (typeof b.to !== 'string' || !b.to) return fail('Pick a friend streak to end.');
    const [a, z] = pairKey(me.id, b.to);
    await env.DB.prepare('DELETE FROM friend_streaks WHERE a = ? AND b = ?').bind(a, z).run();
    return json({ ok: true });
  }
  const p = await peer(env, me, b.to);
  if (!p) return fail('That player isn’t in your group.');
  if (!await takeRate(env, 'social:' + me.id, 60, 'hour')) return fail('That’s a lot of notifications. Try again later.', 429);

  if (path === '/api/nudge') {
    const sent = await env.DB.prepare("SELECT 1 FROM notes WHERE player_id = ? AND from_id = ? AND kind = 'nudge' AND created_at > ?").bind(p.id, me.id, Date.now() - 20 * 3600e3).first();
    if (sent) return fail(`You already nudged ${p.name} today.`, 429);
    await note(env, p.id, me, 'nudge');
    let emailed = false;
    try { emailed = await sendNudgeEmail(p, me); } catch (e) { /* the in-app note still counts */ }
    return json({ ok: true, emailed });
  }
  if (path === '/api/kudos') {
    const ref = typeof b.ref === 'string' && /^[A-Za-z0-9:#._-]{1,90}$/.test(b.ref) ? b.ref : '';
    if (!ref) return fail('Bad high-five.');
    // Only for something they actually finished in this group.
    const real = await env.DB.prepare('SELECT 1 FROM completions WHERE player_id = ? AND lesson_id = ? AND group_code = ?').bind(p.id, ref, me.group_code).first();
    if (!real) return fail('That isn’t in the group feed.');
    const dup = await env.DB.prepare("SELECT 1 FROM notes WHERE player_id = ? AND from_id = ? AND kind = 'kudos' AND ref = ?").bind(p.id, me.id, ref).first();
    if (!dup) await note(env, p.id, me, 'kudos', ref);
    return json({ ok: true });
  }
  const [a, z] = pairKey(me.id, p.id);
  const row = await env.DB.prepare('SELECT status, requested_by FROM friend_streaks WHERE a = ? AND b = ?').bind(a, z).first();
  if (path === '/api/friend/request') {
    if (row) return row.status === 'active' ? fail(`You already have a friend streak with ${p.name}.`) : row.requested_by === me.id ? json({ ok: true, status: 'pending' }) : fail(`${p.name} already asked you. Accept it instead.`);
    // Active streaks plus requests you've sent count toward the 5; requests others sent you don't.
    if (await used(env, me.id) >= SOCIAL_LIMITS.friendStreaks) return fail(`You can have up to ${SOCIAL_LIMITS.friendStreaks} friend streaks.`);
    // Two players asking each other at the same moment: the second insert finds the row and is told what happened.
    const ins = await env.DB.prepare("INSERT OR IGNORE INTO friend_streaks (a, b, status, requested_by, started, created_at) VALUES (?, ?, 'pending', ?, ?, ?)").bind(a, z, me.id, today, Date.now()).run();
    if (!ins.meta || !ins.meta.changes) return fail(`${p.name} already asked you. Accept it instead.`);
    // One request note a day per pair, so asking and cancelling over and over can't flood their notifications.
    const sent = await env.DB.prepare("SELECT 1 FROM notes WHERE player_id = ? AND from_id = ? AND kind = 'fs_request' AND created_at > ?").bind(p.id, me.id, Date.now() - 864e5).first();
    if (!sent) await note(env, p.id, me, 'fs_request');
    return json({ ok: true, status: 'pending' });
  }
  if (path === '/api/friend/accept') {
    if (!row || row.status !== 'pending' || row.requested_by === me.id) return fail('There’s no request to accept.');
    if (await used(env, me.id) >= SOCIAL_LIMITS.friendStreaks) return fail(`You can have up to ${SOCIAL_LIMITS.friendStreaks} friend streaks.`);
    // The requester's own request is already counted on their side, so it can't take them past 5.
    const upd = await env.DB.prepare("UPDATE friend_streaks SET status = 'active', started = ? WHERE a = ? AND b = ? AND status = 'pending'").bind(today, a, z).run();
    if (!upd.meta || !upd.meta.changes) return fail('There’s no request to accept.');
    await note(env, p.id, me, 'fs_accept');
    return json({ ok: true, status: 'active' });
  }
}
// Friend streak places a player is using: active ones and requests they sent.
async function used(env, id) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM friend_streaks WHERE (a = ? OR b = ?) AND (status = 'active' OR requested_by = ?)").bind(id, id, id).first();
  return r ? r.n : 0;
}
export { NOTE_KINDS };
