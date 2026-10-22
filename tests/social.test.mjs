// Friend streaks, nudges, high-fives and notifications against a LOCAL wrangler dev. Run: node tests/social.test.mjs http://127.0.0.1:8799
// Nudge emails need a server in email test mode (--var EMAIL_TEST_MODE:1); without it the email checks are skipped.
const BASE = process.argv[2] || 'http://127.0.0.1:8799';
let pass = 0, failN = 0; const fails = [];
const ok = (cond, name, extra) => { if (cond) pass++; else { failN++; fails.push(name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 300) : '')); } };
async function call(path, { body, token } = {}) {
  const h = {}; if (body !== undefined) h['Content-Type'] = 'application/json'; if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method: body !== undefined ? 'POST' : 'GET', headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  let d = null; const t = await r.text(); try { d = JSON.parse(t); } catch { d = t; }
  return { s: r.status, d };
}
const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const tag = Math.random().toString(36).slice(2, 6);
let r = await call('/api/groups', { body: { groupName: 'Social ' + tag, name: 'Ann' + tag } }); ok(r.s === 200, 'group made', r);
const A = r.d, code = A.code;
r = await call('/api/join', { body: { code, name: 'Ben' + tag } }); const B = r.d; ok(r.s === 200, 'Ben joins', r);
r = await call('/api/join', { body: { code, name: 'Cat' + tag } }); const C = r.d; ok(r.s === 200, 'Cat joins', r);
r = await call('/api/groups', { body: { groupName: 'Other ' + tag, name: 'Dan' + tag } }); const D = r.d; ok(r.s === 200, 'outsider made', r);

// practice history: both practiced the last 3 days
const st = days => ({ state: { srs: {}, activeDays: days, settings: { days: [true, true, true, true, true, true, true], pauses: [] } } });
await call('/api/state', { token: A.token, body: st([day(-2), day(-1), day(0)]) });
await call('/api/state', { token: B.token, body: st([day(-2), day(-1)]) });

// friend streak request and accept
r = await call('/api/friend/request', { token: A.token, body: { to: D.player.id } }); ok(r.s === 400, 'no friend streak with someone outside the group', r);
r = await call('/api/friend/request', { token: A.token, body: { to: A.player.id } }); ok(r.s === 400, 'no friend streak with yourself', r);
r = await call('/api/friend/request', { token: A.token, body: { to: B.player.id } }); ok(r.s === 200 && r.d.status === 'pending', 'request sent', r);
r = await call('/api/friend/request', { token: A.token, body: { to: B.player.id } }); ok(r.s === 200, 'repeat request is harmless', r);
r = await call('/api/friend/accept', { token: A.token, body: { to: B.player.id } }); ok(r.s === 400, 'requester cannot accept their own request', r);
r = await call('/api/board?today=' + day(0), { token: B.token }); ok(r.d.unseen === 1 && r.d.friends.length === 1 && r.d.friends[0].status === 'pending' && !r.d.friends[0].mine, 'Ben sees the request and a new note', r.d);
r = await call('/api/inbox', { token: B.token }); ok(r.d.notes.length === 1 && r.d.notes[0].kind === 'fs_request' && r.d.notes[0].name === 'Ann' + tag, 'inbox lists the request', r.d);
r = await call('/api/friend/accept', { token: B.token, body: { to: A.player.id } }); ok(r.s === 200 && r.d.status === 'active', 'Ben accepts', r);
r = await call('/api/board?today=' + day(0), { token: A.token });
let f = (r.d.friends || [])[0];
ok(f && f.status === 'active' && f.count === 0 && f.meDone === true && f.themDone === false, 'new friend streak waits on Ben today', f);
ok(r.d.unseen === 1, 'Ann has the accept note', r.d.unseen);
ok(r.d.players.find(p => p.id === B.player.id).doneToday === false, 'board says Ben has not practiced today', r.d.players);
await call('/api/state', { token: B.token, body: st([day(-2), day(-1), day(0)]) });
r = await call('/api/board?today=' + day(0), { token: A.token }); f = r.d.friends[0];
ok(f.count === 1 && f.meDone && f.themDone, 'both practiced: friend streak 1', f);

// nudges
r = await call('/api/nudge', { token: C.token, body: { to: A.player.id } }); ok(r.s === 200, 'Cat nudges Ann', r);
r = await call('/api/nudge', { token: C.token, body: { to: A.player.id } }); ok(r.s === 429, 'one nudge per person per day', r);
r = await call('/api/nudge', { token: D.token, body: { to: A.player.id } }); ok(r.s === 400, 'outsiders cannot nudge', r);
r = await call('/api/inbox', { token: A.token }); ok(r.d.notes.some(n => n.kind === 'nudge' && n.from === C.player.id), 'nudge in Ann’s inbox', r.d);
r = await call('/api/inbox/seen', { token: A.token, body: {} }); ok(r.s === 200, 'mark seen');
r = await call('/api/board?today=' + day(0), { token: A.token }); ok(r.d.unseen === 0, 'unseen cleared', r.d.unseen);

// high-fives
r = await call('/api/kudos', { token: B.token, body: { to: A.player.id, ref: 'review-123' } }); ok(r.s === 200, 'high-five', r);
r = await call('/api/kudos', { token: B.token, body: { to: A.player.id, ref: 'review-123' } }); ok(r.s === 200, 'repeat high-five ok');
r = await call('/api/kudos', { token: B.token, body: { to: A.player.id, ref: '<script>' } }); ok(r.s === 400, 'bad high-five ref refused', r);
r = await call('/api/inbox', { token: A.token }); ok(r.d.notes.filter(n => n.kind === 'kudos').length === 1, 'one high-five note per item', r.d);

// blocking hides notes and the friend streak, and stops nudges
r = await call('/api/block', { token: A.token, body: { playerId: B.player.id } }); ok(r.s === 200, 'Ann blocks Ben', r);
r = await call('/api/board?today=' + day(0), { token: A.token }); ok(r.d.friends.length === 0, 'blocked friend streak hidden', r.d.friends);
r = await call('/api/inbox', { token: A.token }); ok(!r.d.notes.some(n => n.from === B.player.id), 'blocked player’s notes hidden', r.d);
r = await call('/api/nudge', { token: B.token, body: { to: A.player.id } }); ok(r.s === 400, 'blocked player cannot nudge', r);
await call('/api/unblock', { token: A.token, body: { playerId: B.player.id } });

// limit and end
r = await call('/api/friend/end', { token: B.token, body: { to: A.player.id } }); ok(r.s === 200, 'end friend streak', r);
r = await call('/api/board?today=' + day(0), { token: A.token }); ok(r.d.friends.length === 0, 'ended friend streak gone', r.d.friends);

// bought freezes and repairs survive sync with junk removed
r = await call('/api/state', { token: C.token, body: { state: { srs: {}, activeDays: [day(-1)], settings: { days: [true, true, true, true, true, true, true], pauses: [], bought: [day(-1), 'junk', '2099-01-01'], repaired: [day(-3), 5] } } } });
r = await call('/api/state', { token: C.token }); ok(r.d.state.settings.bought.join() === day(-1) && r.d.state.settings.repaired.join() === day(-3), 'bought and repaired cleaned on sync', r.d.state.settings);

// deleting an account removes its notes and friend streaks
await call('/api/friend/request', { token: C.token, body: { to: A.player.id } });
r = await call('/api/account/delete', { token: C.token, body: {} }); ok(r.s === 200, 'Cat deletes account', r);
r = await call('/api/board?today=' + day(0), { token: A.token }); ok(!r.d.friends.some(x => x.id === C.player.id), 'deleted player’s friend streak gone', r.d.friends);
r = await call('/api/inbox', { token: A.token }); ok(!r.d.notes.some(n => n.from === C.player.id), 'deleted player’s notes gone', r.d.notes);

console.log(`${pass} pass, ${failN} fail`); fails.forEach(x => console.log('FAIL', x));
process.exit(failN ? 1 : 0);
