// Retention run-throughs in headless Chrome against a LOCAL wrangler dev in email test mode (tests/README.md):
// several players over simulated days, playing real sessions and checking streaks, freezes, earn-back, the daily goal,
// friend streaks, nudges (and their emails), high-fives, notifications, celebrations, sounds and phone reminders.
// Run: node tests/runthrough.test.mjs http://localhost:8791
import { chromium } from 'playwright-core';
import { randomBytes } from 'node:crypto';

const BASE = (process.argv[2] || 'http://localhost:8791').replace(/\/$/, '');
if (/workers\.dev|github\.io/.test(BASE)) { console.error('Local server only.'); process.exit(2); }
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
let pass = 0, failN = 0; const fails = [];
const ok = (cond, name, extra) => { if (cond) pass++; else { failN++; fails.push(name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 500) : '')); } };
const rnd = () => randomBytes(4).toString('hex');
const PHONE = { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const contexts = [];
async function player(name, { dayShift = 0, tz, phone = true } = {}) {
  const c = await browser.newContext({ ...(phone ? PHONE : { viewport: { width: 1280, height: 900 } }), ...(tz ? { timezoneId: tz } : {}), extraHTTPHeaders: { 'CF-Connecting-IP': `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}` } });
  await c.route('https://accounts.google.com/**', r => r.abort());
  contexts.push(c);
  const p = await c.newPage();
  if (dayShift) await p.clock.install({ time: new Date(Date.now() + dayShift * 864e5) });
  p.errors = []; p.on('pageerror', e => p.errors.push(String(e.message || e)));
  p.who = name; p.ctx = c;
  await p.goto(BASE + '/');
  if (await vis(p, '#gtNew')) {
    await p.click('#gtNew'); if (await vis(p, '#gtPwOpen')) await p.click('#gtPwOpen');
    p.creds = { username: 'r' + rnd(), password: 'runthrough ' + rnd() };
    await p.fill('#gtName', name); await p.fill('#gtUser', p.creds.username); await p.fill('#gtPass', p.creds.password);
    await p.click('#gtMake'); await p.waitForSelector('#gate', { state: 'hidden', timeout: 15000 });
  }
  await spy(p);
  return p;
}
// Records every sound instead of playing it.
const spy = p => p.evaluate(() => { window.__snd = []; playSound = (ac, pack, kind) => window.__snd.push(pack + ':' + kind); });
// Event sounds only (the right/wrong/tap sounds during a round are left out).
const sounds = p => p.evaluate(() => window.__snd.filter(x => !/:(correct|wrong|tap)$/.test(x)));
const ev = (p, expr) => p.evaluate(expr);
const vis = (p, sel) => p.locator(sel).first().isVisible().catch(() => false);
const text = (p, sel) => p.locator(sel).first().innerText().catch(() => '');
const BAD_TEXT = /\bundefined\b|\bnull\b|\[object Object\]|NaN|&amp;|&lt;|&gt;|\$\{/;
const settle = p => p.waitForFunction(() => !run || performance.now() - (run.phaseAt || 0) >= 360, null, { timeout: 5000 }).catch(() => {});
async function answerOne(p, { wrong = false } = {}) {
  if (await vis(p, '#result')) return false;
  const s = await ev(p, `run && run.cur ? { phase: run.phase, mode: run.cur._mode, t: run.cur.t, mc: !!(run.cur._opts && document.querySelector('#stage .opt')) } : null`);
  if (!s) return false;
  if (s.phase === 'feedback') { await settle(p); await p.click('#checkBtn'); return true; }
  if (s.phase === 'selfgrade') { await p.click(`[data-self="${wrong ? 0 : 3}"]`); return true; }
  if (s.phase !== 'answer') { await p.waitForTimeout(200); return true; }
  if (s.mc) { const i = await ev(p, `run.cur._opts.findIndex(o => ${wrong ? '!' : ''}o.right)`); await p.click(`#stage .opt[data-i="${i}"]`); await p.click('#checkBtn'); return true; }
  if (s.mode === 'reveal') { await settle(p); await p.click('#checkBtn'); return true; }
  if (s.mode === 'typed') { await p.fill('#recallIn', 'a test answer'); await p.click('[data-conf="sure"]'); await p.waitForFunction(() => run && run.phase !== 'grading', null, { timeout: 15000 }); return true; }
  if (s.t === 'match') { const n = await ev(p, `run.cur.pairs.length`); for (let i = 0; i < n; i++) { await p.click(`.tile[data-s="l"][data-i="${i}"]`); await p.click(`.tile[data-s="r"][data-i="${i}"]`); } await p.waitForFunction(() => run && run.phase !== 'answer', null, { timeout: 3000 }); return true; }
  if (s.t === 'order') { const n = await ev(p, `run.cur.items.length`); for (let i = 0; i < n; i++) await p.click(`.chip[data-p="${i}"]`); await settle(p); await p.click('#checkBtn'); return true; }
  throw new Error('Unknown card state ' + JSON.stringify(s));
}
// Plays one round from Today and returns the result screen's text; leaves the result screen open.
async function playRound(p, { stopAfter } = {}) {
  await ev(p, `go('today')`);
  const sel = await vis(p, '#todayGo') ? '#todayGo' : '#todayMore';
  await p.click(sel); if (await vis(p, '#ktSheet')) await p.click('#ktDone');
  for (let i = 0; i < 60 && await answerOne(p); i++) if (stopAfter && i + 1 >= stopAfter) return null;
  await p.waitForSelector('#result', { timeout: 10000 });
  await p.waitForTimeout(2600); // the celebration sounds play after the "done" chime
  return text(p, '#resultIn');
}
const home = async p => { if (await vis(p, '#rHome')) await p.click('#rHome'); await p.waitForTimeout(150); };
const days = (p, list) => ev(p, `[${list.join(',')}].map(n => addDays(dstr(new Date()), n))`);
async function seed(p, { practice = [], settings = {}, xp } = {}) {
  await ev(p, `(async () => {
    state.activeDays = [${practice.join(',')}].map(n => addDays(dstr(new Date()), n));
    state.settings = { ...defaultStreakSettings(), ...${JSON.stringify(settings)} }; state.settingsAt = Date.now();
    ${xp !== undefined ? `state.xpBase = 0; state.xpBy = { [DEV]: ${xp} }; state.xp = xpTotal(state);` : ''}
    state.streak = streakInfo().streak; save(); await syncNow(); renderHome();
  })()`);
}
async function group(owner, members) {
  await ev(owner, `joinOrStart('start', { group: 'Run ${rnd()}', name: ACCT.player.name })`);
  const code = await ev(owner, 'G.code');
  for (const m of members) await ev(m, `joinOrStart('join', { code: '${code}', name: ACCT.player.name })`);
  for (const x of [owner, ...members]) await ev(x, 'refreshBoard()');
  return code;
}
const board = async p => { await ev(p, 'refreshBoard()'); return ev(p, 'board'); };
const clean = async (p, where) => { const t = await text(p, '#home'); const m = t.match(BAD_TEXT); ok(!m, `${p.who}: clean text on ${where}`, m && t.slice(Math.max(0, m.index - 60), m.index + 60)); };
const noErrors = (p, where) => ok(p.errors.length === 0, `${p.who}: no page errors (${where})`, p.errors);

const tests = {};

tests.soundsDefault = async () => {
  const p = await player('Zed');
  ok(await ev(p, 'soundPack()') === 'zen', 'a new player gets the Zen pack');
  await ev(p, `go('me')`);
  ok(await ev(p, `document.querySelector('[data-spack="zen"]').getAttribute('aria-pressed')`) === 'true', 'Me shows Zen selected');
  await p.click('[data-spack="capitol"]'); await p.waitForTimeout(900);
  const s = await ev(p, `__snd.slice()`);
  ok(s[0] === 'capitol:correct' && s[1] === 'capitol:streak', 'picking a pack plays a sample in that pack', s);
  await ev(p, `__snd.length = 0`); await p.click('#soundSw');
  ok(await ev(p, 'soundOn()') === false && !(await vis(p, '[data-spack]')), 'Sounds off hides the packs');
  await ev(p, `sfx('correct'); sfx('done')`); ok((await ev(p, '__snd.length')) === 0, 'no sounds play while Sounds is off');
  await p.click('#soundSw'); ok(await ev(p, 'soundPack()') === 'capitol', 'pack kept after toggling sounds');
  // every event in every pack synthesizes without errors on a real audio context
  const errs = await ev(p, `(async () => { const ac = new OfflineAudioContext(2, 44100 * 4, 44100); const bad = [];
    const real = window.__realPlay || null; for (const k of SOUND_PACK_KEYS) for (const [e] of SOUND_EVENTS) { try { const P = SOUND_PACKS[k]; if (!P.s[e] || !P.s[e].length) bad.push(k + ':' + e + ' missing'); } catch (x) { bad.push(k + ':' + e + ' ' + x.message); } } return bad; })()`);
  ok(errs.length === 0, 'every pack has all nine sounds', errs);
  noErrors(p, 'sounds');
};

tests.dayOneAndNextDay = async () => {
  const p = await player('Dee');
  await ev(p, `state.mix = { policy: { on: true, perDay: 10 } }; state.mixAt = Date.now(); save(); renderHome()`);
  let r = await playRound(p);
  ok(/1-day streak/.test(r) && /Day one/.test(r), 'first round: day-one streak celebration', r);
  ok(/Daily goal reached/.test(r), 'first round reaches the default 20 XP goal', r);
  let s = await sounds(p);
  ok(s.join() === 'zen:done,zen:streak,zen:goal', 'first round sounds: done, streak, goal (Zen)', s);
  await home(p);
  ok(/done today/.test(await text(p, '#streakStrip')) && /Daily goal reached/.test(await text(p, '#streakStrip')), 'Today strip: done today, goal reached', await text(p, '#streakStrip'));
  const xp1 = await ev(p, 'xpToday()');
  await ev(p, `__snd.length = 0`);
  r = await playRound(p);
  ok(!/streak/i.test((r || '').replace(/Streak\s*\n?\s*\d+d/i, '')) && !/Daily goal reached/.test(r), 'second round the same day: no repeat celebrations', r);
  ok((await sounds(p)).join() === 'zen:done', 'second round: only the done sound', await sounds(p));
  ok(await ev(p, 'xpToday()') > xp1, 'XP today keeps adding up', [xp1, await ev(p, 'xpToday()')]);
  await home(p); await clean(p, 'Today after two rounds'); noErrors(p, 'day one');
};

tests.tomorrow = async () => {
  // A player who practiced today, opening the app tomorrow (clock moved forward a day).
  const p = await player('Tom', { dayShift: 1 });
  await ev(p, `state.mix = { policy: { on: true, perDay: 10 } }; state.mixAt = Date.now(); save()`);
  await seed(p, { practice: [-1] });
  await ev(p, `go('today')`);
  ok(/practice today to keep it/.test(await text(p, '#streakStrip')), 'next day: strip asks to practice', await text(p, '#streakStrip'));
  ok(await ev(p, 'streakInfo().atRisk') === true, 'next day: streak at risk before practicing');
  const r = await playRound(p);
  ok(/2-day streak/.test(r) && /Extended for today/.test(r), 'next day: 2-day streak', r);
  noErrors(p, 'tomorrow');
};

tests.milestone = async () => {
  const p = await player('Mia');
  await ev(p, `state.mix = { policy: { on: true, perDay: 10 } }; state.mixAt = Date.now(); save()`);
  await seed(p, { practice: [-6, -5, -4, -3, -2, -1] });
  const r = await playRound(p);
  ok(/7-day streak!/.test(r) && /A full week/.test(r), '7th day: milestone celebration', r);
  ok((await sounds(p)).includes('zen:milestone') && !(await sounds(p)).includes('zen:streak'), '7th day: milestone sound instead of the streak sound', await sounds(p));
  noErrors(p, 'milestone');
};

tests.freezeUsed = async () => {
  const p = await player('Fay');
  // 5 practice days ending 2 days ago earn one freeze; yesterday was missed
  await seed(p, { practice: [-6, -5, -4, -3, -2] });
  const si = await ev(p, 'streakInfo()');
  ok(si.streak === 5 && si.frozen.length === 1 && si.freezes === 0, 'earned freeze covered yesterday', si);
  await ev(p, `go('today')`);
  ok(/freeze covered yesterday/.test(await text(p, '#streakStrip')), 'Today says a freeze covered yesterday', await text(p, '#streakStrip'));
  ok((await sounds(p)).filter(x => x.endsWith(':freeze')).length === 1, 'freeze sound once', await sounds(p));
  await p.reload(); await spy(p); await ev(p, `go('today')`);
  ok((await sounds(p)).length === 0, 'no freeze sound again after reload', await sounds(p));
  noErrors(p, 'freeze used');
};

tests.earnBack = async () => {
  const p = await player('Eve');
  await ev(p, `state.mix = { policy: { on: true, perDay: 10 } }; state.mixAt = Date.now(); save()`);
  await seed(p, { practice: [-5, -4, -3, -2] });
  let si = await ev(p, 'streakInfo()');
  ok(si.streak === 0 && si.repair && si.repair.lost === 4, 'lapsed 4-day streak offers earn-back', si);
  await ev(p, `go('today')`);
  ok(/lapsed yesterday\. Finish a round today and it comes back/.test(await text(p, '#streakStrip')), 'Today explains the earn-back', await text(p, '#streakStrip'));
  const r = await playRound(p);
  ok(/5-day streak/.test(r) && /earned your streak back/.test(r), 'round restores the streak: 5 days', r);
  si = await ev(p, 'streakInfo()');
  ok(si.streak === 5 && !si.repair && si.spent === 0, 'streak 5, nothing spent', si);
  await home(p);
  ok(!(await vis(p, '#streakStrip .repair')), 'earn-back line gone after restoring');
  // the server computes the same streak from the synced settings
  await ev(p, 'syncNow()');
  const o = await player('Eve’s friend');
  await group(p, [o]);
  const b = await board(o);
  ok(b.players.find(x => x.name === 'Eve').streak === 5, 'group board shows the restored 5-day streak', b.players);
  // three missed days: no earn-back
  const q = await player('Quin');
  await seed(q, { practice: [-6, -5, -4] });
  ok(!(await ev(q, 'streakInfo().repair')), 'no earn-back after 3 missed days', await ev(q, 'streakInfo()'));
  // quitting a round partway still earns it back, through the Today screen
  const z = await player('Zoe');
  await ev(z, `state.mix = { policy: { on: true, perDay: 10 } }; state.mixAt = Date.now(); save()`);
  await seed(z, { practice: [-4, -3, -2] });
  await playRound(z, { stopAfter: 2 });
  await p.waitForTimeout(300);
  await z.click('#quitBtn'); await z.waitForTimeout(200); await z.click('#quitBtn'); await z.waitForTimeout(400);
  if (await vis(z, '#result')) await home(z);
  await ev(z, `go('today')`); await z.waitForTimeout(300);
  ok(await ev(z, 'streakInfo().streak') === 4, 'quit mid-round: streak still earned back (3 + today)', await ev(z, 'streakInfo()'));
  for (const x of [p, o, q, z]) noErrors(x, 'earn-back');
};

tests.buyFreezes = async () => {
  const p = await player('Bo');
  await seed(p, { practice: [-2, -1], xp: 50 });
  await ev(p, `go('me')`);
  ok(await ev(p, `$('#buyFreeze').disabled`) === true, 'with 50 XP the freeze button is disabled');
  await seed(p, { practice: [-2, -1], xp: 350 });
  await ev(p, `go('me')`);
  for (let i = 0; i < 3; i++) if (await vis(p, '#buyFreeze') && !await ev(p, `$('#buyFreeze').disabled`)) await p.click('#buyFreeze');
  const si = await ev(p, 'streakInfo()');
  ok(si.freezes === 3 && si.spent === 300, 'bought three freezes for 300 XP', si);
  ok(!(await vis(p, '#buyFreeze')), 'button gone with freezes full');
  ok(await ev(p, 'xpSpendable()') === 50 && await ev(p, 'state.xp') === 350, 'spendable 50, total XP still 350', [await ev(p, 'xpSpendable()'), await ev(p, 'state.xp')]);
  ok(/Freezes full/.test(await text(p, '#streakCard')), 'Me says freezes are full');
  await ev(p, 'syncNow()');
  // the same account on a second device
  const d2 = await player('Bo second device');
  await ev(d2, `(async () => { const r = await apiCall('/api/password/login', { username: '${p.creds.username}', password: '${p.creds.password}' }); return r; })()`).then(async r => {
    await ev(d2, `(async r => { ACCT = { token: r.token, player: r.player, passkeys: 0 }; saveA(); state.owner = null; await syncNow(); renderHome(); })(${JSON.stringify(r)})`);
  }).catch(e => ok(false, 'second device sign-in', String(e)));
  ok(await ev(d2, 'streakInfo().freezes') === 3 && await ev(d2, 'xpSpendable()') === 50, 'second device sees 3 freezes and 50 XP to spend', [await ev(d2, 'streakInfo().freezes'), await ev(d2, 'xpSpendable()')]);
  noErrors(p, 'buy freezes'); noErrors(d2, 'second device');
};

tests.dailyGoal = async () => {
  const p = await player('Gil');
  await ev(p, `state.mix = { policy: { on: true, perDay: 20 } }; state.mixAt = Date.now(); save()`);
  await ev(p, `go('me')`); await p.click('[data-goal="0"]');
  await ev(p, `go('today')`);
  ok(!(await vis(p, '#streakStrip .goal')), 'goal Off: no goal bar');
  await ev(p, `go('me')`); await p.click('[data-goal="100"]');
  let r = await playRound(p);
  ok(!/Daily goal reached/.test(r), '100 XP goal not reached by one 5-card round', [r, await ev(p, 'xpToday()')]);
  await home(p);
  const t = await text(p, '#streakStrip .goal');
  ok(new RegExp(`${await ev(p, 'xpToday()')} / 100 XP`).test(t), 'goal bar shows XP so far out of 100', t);
  noErrors(p, 'daily goal');
};

tests.friends = async () => {
  const a = await player('Ana'), b = await player('Ben'), c = await player('Cy');
  await group(a, [b, c]);
  const bid = await ev(b, 'ACCT.player.id'), cid = await ev(c, 'ACCT.player.id'), aid = await ev(a, 'ACCT.player.id');
  // no friend streaks yet: Group explains how to start one; Today shows nothing about friends
  await ev(a, `go('group')`);
  ok(/Tap a name on the board to start one/.test(await text(a, '#group')), 'Group explains friend streaks when there are none');
  // Ana asks Ben from the board; Ben declines from Today
  await a.click(`li[data-pid="${bid}"]`); await a.click(`[data-fsreq="${bid}"]`); await a.waitForTimeout(800);
  ok(/Asked\s+Ben/.test(await text(a, '#group')), 'Ana sees her pending request with Cancel', await text(a, '#group'));
  await board(b); await ev(b, `go('today')`);
  ok(/Ana wants a friend streak with you/.test(await text(b, '#streakStrip')), 'Ben sees the request on Today', await text(b, '#streakStrip'));
  await b.click(`#streakStrip [data-fsend="${aid}"]`); await b.waitForTimeout(800);
  ok((await ev(b, 'board.friends')).length === 0, 'No thanks removes it');
  // Ana asks Cy, then cancels from Group
  await ev(a, `gSel = null; refreshBoard()`); await a.waitForTimeout(500);
  await a.click(`li[data-pid="${cid}"]`); await a.click(`[data-fsreq="${cid}"]`); await a.waitForTimeout(800);
  await a.click(`#group [data-fsend="${cid}"]`); await a.waitForTimeout(800);
  ok((await ev(a, 'board.friends')).length === 0, 'Cancel withdraws the request');
  // Cy asks Ana; Ana tries to ask Cy back at the same time and is told to accept instead
  await ev(c, `socialCall('/api/friend/request', '${aid}')`);
  await ev(a, `gSel = null; refreshBoard()`); await a.waitForTimeout(500);
  const r = await ev(a, `apiCall('/api/friend/request', { to: '${cid}', today: dstr(new Date()) }).then(() => 'ok', e => e.message)`);
  ok(/already asked you/.test(r), 'asking someone who already asked you says to accept', r);
  await ev(a, `go('today')`);
  await a.click(`#streakStrip [data-fsacc="${cid}"]`); await a.waitForTimeout(1000);
  let f = (await ev(a, 'board.friends')).find(x => x.id === cid);
  ok(f && f.status === 'active' && f.count === 0, 'accepted from Today: active at 0', f);
  ok((await sounds(a)).includes('zen:streak'), 'accepting plays the streak sound', await sounds(a));
  ok(/Cy: neither of you yet today|Cy: starts the first day you both practice/.test(await text(a, '#streakStrip')), 'Today: starts when you both practice', await text(a, '#streakStrip'));
  // Ana practices: waiting on Cy, with a Nudge button
  await ev(a, `state.mix = { policy: { on: true, perDay: 10 } }; state.mixAt = Date.now(); save()`);
  await playRound(a); await home(a); await ev(a, 'syncNow()'); await board(a); await ev(a, `go('today')`);
  ok(/Cy: you’re done, waiting on them/.test(await text(a, '#streakStrip')), 'after practicing: waiting on Cy', await text(a, '#streakStrip'));
  ok(await vis(a, `#streakStrip [data-nudge="${cid}"]`), 'Nudge button on the waiting friend streak');
  // Cy sees it's their turn, practices, both see 1 and the celebration names Ana
  await board(c); await ev(c, `go('today')`);
  ok(/Ana: they’re done\. Your turn/.test(await text(c, '#streakStrip')), 'Cy: Ana is done, your turn', await text(c, '#streakStrip'));
  await ev(c, `state.mix = { policy: { on: true, perDay: 10 } }; state.mixAt = Date.now(); save()`);
  const rc = await playRound(c);
  ok(/You and Ana kept your friend streak: 1 day/.test(rc), 'Cy’s result names the kept friend streak', rc);
  await home(c); await ev(c, 'syncNow()');
  f = (await board(a)).friends.find(x => x.id === cid);
  ok(f.count === 1 && f.meDone && f.themDone, 'both practiced: friend streak 1', f);
  // ending needs two taps
  await ev(a, `go('group')`); await a.click(`#group [data-fsend="${cid}"]`);
  ok(/Tap again to end/.test(await text(a, '#group')) && (await ev(a, 'board.friends')).length === 1, 'first tap on End only arms it');
  await a.click(`#group [data-fsend="${cid}"]`); await a.waitForTimeout(800);
  ok((await ev(a, 'board.friends')).length === 0, 'second tap ends it');
  for (const x of [a, b, c]) { await clean(x, 'friends'); noErrors(x, 'friends'); }
};

tests.limits = async () => {
  const a = await player('Lim');
  const code = await (async () => { await ev(a, `joinOrStart('start', { group: 'Lim ${rnd()}', name: 'Lim' })`); return ev(a, 'G.code'); })();
  const others = [];
  for (let i = 0; i < 6; i++) others.push(await ev(a, `fetch('/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.9.${i}.1' }, body: JSON.stringify({ code: '${code}', name: 'Pal${i}' }) }).then(r => r.json())`));
  const results = [];
  for (const o of others) results.push(await ev(a, `apiCall('/api/friend/request', { to: '${o.player.id}', today: dstr(new Date()) }).then(() => 'ok', e => e.message)`));
  ok(results.slice(0, 5).every(x => x === 'ok') && /up to 5/.test(results[5]), 'sixth friend streak request refused', results);
  await ev(a, 'refreshBoard()'); await ev(a, `go('group')`);
  ok((await ev(a, 'board.friends')).length === 5, 'five pending shown');
  noErrors(a, 'limits');
};

tests.nudgesAndInbox = async () => {
  const a = await player('Nia'), b = await player('Oli');
  await group(a, [b]);
  const bid = await ev(b, 'ACCT.player.id');
  // Oli confirms an email so nudges reach him by email too
  const add = await ev(b, `apiCall('/api/email', { email: 'oli-${rnd()}@example.com' })`);
  ok(add.devCode, 'test server returns the email code', add);
  await ev(b, `apiCall('/api/email/verify', { code: '${add.devCode}' })`);
  await ev(b, `__snd.length = 0; lastUnseen = null; refreshBoard()`); await b.waitForTimeout(400);
  // Nia nudges Oli from the board (Oli hasn't practiced; his streak is 0 so the inline button isn't shown)
  await ev(a, `refreshBoard().then(() => go('group'))`); await a.waitForTimeout(500);
  await a.click(`li[data-pid="${bid}"]`);
  ok(await vis(a, `.lbact [data-nudge="${bid}"]`), 'Nudge offered for someone who hasn’t practiced');
  const resp = a.waitForResponse(r => r.url().includes('/api/nudge'));
  await a.click(`.lbact [data-nudge="${bid}"]`);
  const nr = await (await resp).json();
  ok(nr.ok && nr.emailed === true, 'nudge sent, and by email', nr);
  await a.waitForTimeout(800);
  ok(await ev(a, `nudgedToday('${bid}')`) && /Nudged/.test(await text(a, '#group')), 'Nudge shows as done');
  const again = await ev(a, `apiCall('/api/nudge', { to: '${bid}' }).then(() => 'ok', e => e.message)`);
  ok(/already nudged/.test(again), 'second nudge the same day refused', again);
  // Oli, with the app open, gets the sound and the badge on the next refresh
  await ev(b, 'refreshBoard()'); await b.waitForTimeout(400);
  ok((await sounds(b)).includes('zen:nudge'), 'open app plays the nudge sound', await sounds(b));
  ok(await ev(b, `$('#bellN').textContent`) === '1' && await vis(b, '#bellN'), 'bell badge shows 1');
  await ev(b, `state.mix = { policy: { on: true, perDay: 10 } }; state.mixAt = Date.now(); save()`);
  await b.click('#bellBtn'); await b.waitForSelector('#inboxBody .notes', { timeout: 8000 }).catch(() => {});
  ok(/Nia nudged you/.test(await text(b, '#inboxBody')), 'inbox lists the nudge', await text(b, '#inboxBody'));
  await b.waitForTimeout(500);
  ok(!(await vis(b, '#bellN')), 'badge clears after opening');
  await b.click('#inboxBody [data-start]'); await b.waitForTimeout(800);
  ok(await vis(b, '#lesson') || await vis(b, '#ktSheet'), '"Start a round" from the nudge opens a session');
  if (await vis(b, '#ktSheet')) await b.click('#ktDone');
  for (let i = 0; i < 60 && await answerOne(b); i++);
  await b.waitForSelector('#result', { timeout: 10000 }); await home(b); await ev(b, 'syncNow()');
  // Nia high-fives Oli's session; the button stays done after a reload
  await ev(a, `refreshBoard().then(() => go('group'))`); await a.waitForTimeout(600);
  ok(await vis(a, `.feed [data-kudos="${bid}"]`), 'High five button on Oli’s feed item');
  await a.click(`.feed [data-kudos="${bid}"]`); await a.waitForTimeout(600);
  await a.reload(); await spy(a); await ev(a, `go('group')`); await a.waitForTimeout(800);
  ok(await ev(a, `document.querySelector('.feed [data-kudos="${bid}"]').disabled`) === true, 'high-five stays done after reload');
  await ev(b, 'refreshBoard()'); await b.waitForTimeout(300); await b.click('#bellBtn'); await b.waitForTimeout(800);
  ok(/Nia high-fived your review session/.test(await text(b, '#inboxBody')), 'Oli sees the high-five', await text(b, '#inboxBody'));
  await b.click('#inboxSheet [data-close]');
  // Oli turns nudge emails off; the next nudge (from someone else) is in-app only
  await ev(b, `refreshAccount ? refreshAccount() : null`); await b.waitForTimeout(500); await ev(b, `go('me')`);
  ok(await vis(b, '#mailNudgeSw'), 'Me has the nudge email switch');
  await b.click('#mailNudgeSw'); await ev(b, 'syncNow()');
  const c = await player('Pip'); const code = await ev(a, 'G.code'); await ev(c, `joinOrStart('join', { code: '${code}', name: 'Pip' })`);
  const n2 = await ev(c, `apiCall('/api/nudge', { to: '${bid}' })`);
  ok(n2.ok && n2.emailed === false, 'nudge emails off: in-app only', n2);
  for (const x of [a, b, c]) { await clean(x, 'nudges'); noErrors(x, 'nudges'); }
};

tests.reminders = async () => {
  const a = await player('Rhi'), b = await player('Sid');
  await group(a, [b]);
  const aid = await ev(a, 'ACCT.player.id'), bid = await ev(b, 'ACCT.player.id');
  // a 4-day friend streak, Sid already practiced today, Rhi hasn't
  for (const [x, d] of [[a, [-4, -3, -2, -1]], [b, [-4, -3, -2, -1, 0]]]) await seed(x, { practice: d });
  await ev(a, `socialCall('/api/friend/request', '${bid}')`); await ev(b, `socialCall('/api/friend/accept', '${aid}')`);
  // start the friend streak 4 days ago, as if it had been running
  await ev(a, 'refreshBoard()');
  const f = (await ev(a, 'board.friends'))[0];
  ok(f && f.status === 'active', 'friend streak active', f);
  // Fake the phone: capture what would be scheduled.
  const sched = await ev(a, `(async () => {
    board.friends = board.friends.map(x => ({ ...x, count: 4, meDone: false, themDone: true }));
    Native = { notes: { getPending: async () => ({ notifications: [] }), cancel: async () => {}, schedule: async o => { window.__sched = o.notifications; } } };
    state.prefs = { ...(state.prefs || {}), rem: { on: true, dailyOn: false, riskOn: true, risk: '23:59', daily: '09:00' } };
    remSig = ''; await scheduleRemindersNow(); const out = window.__sched || []; Native = null; return out;
  })()`);
  const today = sched.find(n => n.id === 200);
  ok(today && /Your 4-day friend streak with Sid needs you today/.test(today.body), 'tonight’s reminder names the friend streak', sched.slice(0, 2));
  noErrors(a, 'reminders');
};

tests.timeZones = async () => {
  // Players far apart in time zones start a friend streak; each side sees a sensible state and no errors.
  const a = await player('Kiri', { tz: 'Pacific/Kiritimati' }), b = await player('Hono', { tz: 'Pacific/Honolulu' });
  await group(a, [b]);
  const aid = await ev(a, 'ACCT.player.id'), bid = await ev(b, 'ACCT.player.id');
  await ev(a, `socialCall('/api/friend/request', '${bid}')`); await ev(b, `socialCall('/api/friend/accept', '${aid}')`);
  const fa = (await board(a)).friends[0], fb = (await board(b)).friends[0];
  ok(fa && fb && fa.status === 'active' && fb.status === 'active', 'friend streak active in both time zones', [fa, fb]);
  ok(fb.started === await ev(b, 'dstr(new Date())'), 'starts on the accepting player’s own date', [fb.started, await ev(b, 'dstr(new Date())')]);
  for (const x of [a, b]) { await ev(x, `go('today')`); await clean(x, 'time zones'); noErrors(x, 'time zones'); }
};

tests.syncAndReset = async () => {
  const p = await player('Syd');
  const r = await ev(p, `(() => {
    const base = { ...blankState(), settingsAt: 1 };
    const phone = { ...base, settings: { ...defaultStreakSettings(), bought: ['2026-10-20'] }, settingsAt: 100, xpDays: { '2026-10-22': { ph: 30 } } };
    const laptop = { ...base, settings: { ...defaultStreakSettings(), bought: ['2026-10-21', '2026-10-21'], repaired: ['2026-10-19'], days: [false, true, true, true, true, true, false] }, settingsAt: 200, xpDays: { '2026-10-22': { lp: 40 }, '2026-10-21': 15 } };
    const m = mergeStates(phone, laptop), m2 = mergeStates(m, phone);
    return { bought: m.settings.bought, repaired: m.settings.repaired, days: m.settings.days, xp: dayXP(m.xpDays['2026-10-22']), old: dayXP(m.xpDays['2026-10-21']), again: dayXP(m2.xpDays['2026-10-22']), bought2: m2.settings.bought };
  })()`);
  ok(r.bought.join() === '2026-10-20,2026-10-21,2026-10-21' && r.repaired.join() === '2026-10-19', 'bought freezes and repaired days survive a merge', r);
  ok(r.days[0] === false, 'the newest copy still wins for the schedule', r.days);
  ok(r.xp === 70 && r.old === 15, 'XP per day adds up across devices (and reads the old format)', r);
  ok(r.again === 70 && r.bought2.length === 3, 'merging again doesn’t double anything', r);
  // reset clears bought freezes, repaired days and today's XP
  await seed(p, { practice: [-2, -1], xp: 300, settings: { bought: [] } });
  await ev(p, `go('me')`); await p.click('#buyFreeze');
  await ev(p, `noteDayXP(40)`);
  await ev(p, `(() => { const b = $('#resetBtn'); b.click(); b.click(); })()`);
  const after = await ev(p, `({ bought: state.settings.bought, xpToday: xpToday(), spent: streakInfo().spent })`);
  ok(after.bought.length === 0 && after.xpToday === 0 && after.spent === 0, 'reset clears bought freezes and the day’s XP', after);
  noErrors(p, 'sync and reset');
};

for (const [name, fn] of Object.entries(tests)) {
  if (ONLY && !ONLY.has(name)) continue;
  const t0 = Date.now(), f0 = failN;
  try { await fn(); } catch (e) { ok(false, `${name} crashed: ${String(e.message).split('\n')[0]}`); }
  console.log(`${name}: ${((Date.now() - t0) / 1000).toFixed(1)}s, ${failN - f0} failures`);
  while (contexts.length) await contexts.pop().close().catch(() => {});
}
await browser.close();
console.log(`PASS ${pass}  FAIL ${failN}`); fails.forEach(f => console.log('FAIL', f));
process.exit(failN ? 1 : 0);
