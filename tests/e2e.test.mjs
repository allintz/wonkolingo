// Browser tests in headless Chrome against a LOCAL `wrangler dev` (they create accounts and groups, so never production).
// Run: node tests/e2e.test.mjs http://localhost:8799   (needs Google Chrome; set CHROME=/path/to/chrome otherwise)
// Covers: cold start on every route, sign-up and sign-in, a full session, every card rendered and answered in every
// style, saved states of every shape, phone layout, offline and slow networks, groups, and Me settings.
import { chromium } from 'playwright-core';
import { randomBytes } from 'node:crypto';

const BASE = (process.argv[2] || 'http://localhost:8799').replace(/\/$/, '');
if (/workers\.dev|github\.io/.test(BASE)) { console.error('Local server only: these tests create accounts.'); process.exit(2); }
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
let pass = 0, failN = 0; const fails = [];
const ok = (cond, name, extra) => { if (cond) pass++; else { failN++; fails.push(name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : '')); } };
const rnd = () => randomBytes(4).toString('hex');
const PHONE = { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
// Each context looks like its own network, so per-IP limits don't pile up across tests and runs.
async function ctx(opts = {}) {
  const c = await browser.newContext({ ...(opts.phone === false ? { viewport: { width: 1280, height: 900 } } : PHONE), extraHTTPHeaders: { 'CF-Connecting-IP': `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}` } });
  if (opts.storage) await c.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); Object.entries(s).forEach(([k, v]) => v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v)); } }, opts.storage);
  return c;
}
// A page that records uncaught errors and console errors (network failures we cause on purpose are filtered by callers).
async function page(c) {
  const p = await c.newPage();
  p.errors = []; p.consoleErrors = [];
  p.on('pageerror', e => p.errors.push(String(e.message || e)));
  p.on('console', m => { if (m.type() === 'error') p.consoleErrors.push(m.text()); });
  return p;
}
const ev = (p, expr) => p.evaluate(expr);
const visible = (p, sel) => p.locator(sel).first().isVisible().catch(() => false);
// Nothing invisible may sit on top of the tab bar or the main buttons: the 10/20 startup crash left the page unclickable.
async function clickable(p, sel) {
  return p.evaluate(s => {
    const el = document.querySelector(s); if (!el) return 'missing';
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) return 'zero-size';
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit && (hit === el || el.contains(hit)) ? true : 'covered by ' + (hit ? hit.tagName + '#' + hit.id + '.' + hit.className : 'nothing');
  }, sel);
}
// Text a player would see that means a template went wrong.
const BAD_TEXT = /\bundefined\b|\bnull\b|\[object Object\]|NaN|&amp;|&lt;|&gt;|&quot;|&#\d+;|\$\{/;
const badText = t => { const m = String(t).match(BAD_TEXT); return m ? m[0] + ' in: ' + String(t).slice(Math.max(0, m.index - 60), m.index + 60) : null; };

async function signUp(p, { name = 'Tester ' + rnd(), username = 'u' + rnd(), password = 'correct horse ' + rnd() } = {}) {
  await p.goto(BASE + '/');
  await p.click('#gtNew');
  await p.fill('#gtName', name); await p.fill('#gtUser', username); await p.fill('#gtPass', password);
  await p.click('#gtMake');
  await p.waitForSelector('#gate', { state: 'hidden', timeout: 15000 });
  return { name, username, password };
}
// Starts today's session; a course's key-terms list may come up first, and Done (everything added) continues.
async function clickGo(p, sel) { await p.click(sel); if (await visible(p, '#ktSheet')) await p.click('#ktDone'); }
async function addToMix(p, key) { await ev(p, `go('courses')`); await p.click(`.switch[data-mix="${key}"]`); }
// Answers whatever card is showing, correctly unless told otherwise; returns false once the session or lesson is over.
// The app ignores a tap on Check or Continue in the first moment after the screen changes (stray double taps), as a person would.
const settle = p => p.waitForFunction(() => !run || performance.now() - (run.phaseAt || 0) >= 360, null, { timeout: 5000 }).catch(() => {});
async function answerOne(p, { wrong = false } = {}) {
  if (await visible(p, '#result')) return false;
  const s = await ev(p, `run && run.cur ? { phase: run.phase, mode: run.cur._mode, t: run.cur.t, mc: !!(run.cur._opts && document.querySelector('#stage .opt')) } : null`);
  if (!s) return false;
  if (s.phase === 'feedback') { await settle(p); await p.click('#checkBtn'); return true; }
  if (s.phase === 'selfgrade') { await p.click(`[data-self="${wrong ? 0 : 3}"]`); return true; }
  if (s.phase !== 'answer') { await p.waitForTimeout(200); return true; }
  if (s.mc) {
    const i = await ev(p, `run.cur._opts.findIndex(o => ${wrong ? '!' : ''}o.right)`);
    await p.click(`#stage .opt[data-i="${i}"]`); await p.click('#checkBtn'); return true;
  }
  if (s.mode === 'reveal') { await settle(p); await p.click('#checkBtn'); return true; }
  if (s.mode === 'typed') { await p.fill('#recallIn', 'a test answer'); await p.click('[data-conf="sure"]'); await p.waitForFunction(() => run && run.phase !== 'grading', null, { timeout: 15000 }); return true; }
  if (s.t === 'match') {
    const n = await ev(p, `run.cur.pairs.length`);
    for (let i = 0; i < n; i++) { await p.click(`.tile[data-s="l"][data-i="${i}"]`); await p.click(`.tile[data-s="r"][data-i="${i}"]`); }
    await p.waitForFunction(() => run && run.phase !== 'answer', null, { timeout: 3000 }); return true;
  }
  if (s.t === 'order') {
    const n = await ev(p, `run.cur.items.length`);
    for (let i = 0; i < n; i++) await p.click(`.chip[data-p="${i}"]`);
    await settle(p); await p.click('#checkBtn'); return true;
  }
  throw new Error('Unknown card state ' + JSON.stringify(s));
}

const tests = {};

// ---------- 1. Cold start: every route, signed out, desktop and phone
tests.coldStart = async () => {
  const keys = await (async () => { const c = await ctx(); const p = await page(c); await p.goto(BASE + '/'); const k = await ev(p, 'Object.keys(COURSES)'); await c.close(); return k; })();
  const routes = ['', '#today', '#courses', '#group', '#me', ...keys.map(k => '#course/' + k), '#course/nope', '#course/', '#%E0%A4%A', '#<img src=x onerror=alert(1)>', '?join=ABC123', '?join=<b>x</b>#me'];
  for (const phone of [true, false]) for (const r of routes) {
    const c = await ctx({ phone }); const p = await page(c);
    await p.goto(BASE + '/' + r); await p.waitForTimeout(150);
    ok(p.errors.length === 0, `cold start ${r || '/'} (${phone ? 'phone' : 'desktop'}): no page errors`, p.errors);
    ok(await visible(p, '#gate'), `cold start ${r || '/'}: sign-up screen shows`);
    ok(await clickable(p, '#gtNew') === true, `cold start ${r || '/'}: Create an account is clickable`, await clickable(p, '#gtNew'));
    if (phone) {
      await p.click('#gtHave'); ok(await visible(p, '#gtUser'), `${r || '/'}: sign-in form opens`);
      ok(await clickable(p, '#gtBack') === true, `${r || '/'}: Back is clickable on sign-in`);
      await p.click('#gtBack'); ok(await visible(p, '#gtNew'), `${r || '/'}: Back returns to welcome`);
    }
    ok(!badText(await p.locator('#gate').innerText()), `cold start ${r || '/'}: no template junk on the sign-up screen`, badText(await p.locator('#gate').innerText()));
    await c.close();
  }
};

// ---------- 2. Sign-up validation, then a full session, then sign-in elsewhere sees the same progress
tests.accountAndSession = async () => {
  const c = await ctx(); const p = await page(c);
  await p.goto(BASE + '/'); await p.click('#gtNew');
  await p.click('#gtMake'); ok(/display name/i.test(await p.locator('.gerr').innerText().catch(() => '')), 'empty name is refused with a message');
  await p.fill('#gtName', 'Val'); await p.fill('#gtUser', 'ab'); await p.fill('#gtPass', 'longenough');
  await p.click('#gtMake'); ok(/3 characters/.test(await p.locator('.gerr').innerText().catch(() => '')), 'short username is refused');
  ok(await p.inputValue('#gtName') === 'Val', 'fields keep their values after an error');
  await p.fill('#gtUser', 'abc' + rnd()); await p.fill('#gtPass', 'short');
  await p.click('#gtMake'); await p.waitForTimeout(300);
  ok(/8 characters/.test(await p.locator('.gerr').innerText().catch(() => '')) || await ev(p, `document.querySelector('#gtPass').matches(':invalid')`), 'short password is refused');
  ok(await visible(p, '#gtName'), 'still on the create step after a short password');
  await c.close();

  const c1 = await ctx(); const p1 = await page(c1);
  const who = await signUp(p1);
  ok(p1.errors.length === 0, 'sign-up: no page errors', p1.errors);
  const acct = await ev(p1, `JSON.parse(localStorage.getItem('wl-account'))`);
  ok(acct && acct.token && acct.username === who.username, 'account saved on the device with its username', acct && { ...acct, token: !!acct.token });
  ok(await visible(p1, '.welcome'), 'new player sees the welcome card');
  ok(await clickable(p1, '#wBrowse') === true, 'Pick a course is clickable', await clickable(p1, '#wBrowse'));
  // Taken username on a second sign-up
  { const cx = await ctx(); const px = await page(cx); await px.goto(BASE + '/'); await px.click('#gtNew'); await px.fill('#gtName', 'Dup'); await px.fill('#gtUser', who.username.toUpperCase()); await px.fill('#gtPass', 'another password');
    await px.click('#gtMake'); await px.waitForSelector('.gerr', { timeout: 8000 }).catch(() => {}); ok(/taken/i.test(await px.locator('.gerr').innerText().catch(() => '')), 'taken username (other case) is refused'); await cx.close(); }

  await p1.click('#wBrowse'); ok(await ev(p1, 'VIEW') === 'courses', 'Pick a course opens Courses');
  await addToMix(p1, 'policy'); await addToMix(p1, 'lingo');
  ok(await ev(p1, `mixKeys().join()`) === 'policy,lingo', 'two courses in the mix', await ev(p1, `mixKeys()`));
  await ev(p1, `go('today')`);
  ok(await clickable(p1, '#todayGo') === true, 'Start is clickable on Today', await clickable(p1, '#todayGo'));
  const xp0 = await ev(p1, 'state.xp');
  await clickGo(p1, '#todayGo');
  let steps = 0, sawTypes = new Set();
  while (steps++ < 120) { const t = await ev(p1, `run && run.cur ? run.cur._mode + ':' + run.cur.t : ''`); if (t) sawTypes.add(t); if (!await answerOne(p1, { wrong: steps === 2 })) break; }
  ok(await visible(p1, '#result'), 'session reaches the result screen', { steps, types: [...sawTypes] });
  const runXp = await ev(p1, 'run && run.xp');
  ok(await ev(p1, 'state.xp') === xp0 + runXp && runXp > 0, 'session XP added exactly once', { xp0, runXp, now: await ev(p1, 'state.xp') });
  ok(!badText(await p1.locator('#result').innerText()), 'result screen text is clean', badText(await p1.locator('#result').innerText()));
  await p1.click('#rHome');
  ok(await ev(p1, `state.activeDays.includes(dstr(new Date()))`), 'today counts as a practice day');
  ok(await ev(p1, `state.xp`) === xp0 + runXp, 'XP unchanged after going home');
  await p1.waitForTimeout(2500);
  ok(p1.errors.length === 0, 'session: no page errors', p1.errors);
  const srsN = await ev(p1, 'Object.keys(state.srs).length');
  ok(srsN > 0, 'cards were scheduled', srsN);
  await ev(p1, 'syncNow()'); await p1.waitForFunction(() => typeof syncState === 'undefined' || syncState !== 'saving', null, { timeout: 10000 }).catch(() => {});
  await p1.waitForTimeout(1500);

  // Another device: sign in with the password, see the same progress.
  const c2 = await ctx(); const p2 = await page(c2);
  await p2.goto(BASE + '/'); await p2.click('#gtHave');
  await p2.fill('#gtUser', who.username); await p2.fill('#gtPass', 'wrong password');
  await p2.click('#gtPwGo'); await p2.waitForSelector('.gerr', { timeout: 8000 }).catch(() => {});
  ok(/password|match|wrong/i.test(await p2.locator('.gerr').innerText().catch(() => '')), 'wrong password shows an error', await p2.locator('.gerr').innerText().catch(() => ''));
  await p2.fill('#gtPass', who.password); await p2.press('#gtPass', 'Enter');
  await p2.waitForSelector('#gate', { state: 'hidden', timeout: 10000 }).catch(() => {});
  ok(!await visible(p2, '#gate'), 'Enter in the password field signs in');
  await p2.waitForFunction(n => Object.keys(state.srs).length >= n, srsN, { timeout: 10000 }).catch(() => {});
  ok(await ev(p2, 'Object.keys(state.srs).length') === srsN, 'progress follows the account to a new device', { srsN, got: await ev(p2, 'Object.keys(state.srs).length') });
  ok(await ev(p2, 'state.xp') === await ev(p1, 'state.xp'), 'XP matches on the new device', { a: await ev(p1, 'state.xp'), b: await ev(p2, 'state.xp') });
  ok(await ev(p2, 'mixKeys().join()') === 'policy,lingo', 'daily mix follows the account');
  ok(p2.errors.length === 0, 'second device: no page errors', p2.errors);

  // Sign out clears the device and shows the sign-up screen again.
  await ev(p2, `go('me')`);
  ok(await visible(p2, '#aOut'), 'Me shows Sign out');
  await p2.click('#aOut'); await p2.click('#aOut'); await p2.waitForTimeout(600);
  ok(await visible(p2, '#gate'), 'signing out shows the sign-up screen');
  ok(await ev(p2, `Object.keys(state.srs).length`) === 0 && await ev(p2, `!localStorage.getItem('wl-account')`), 'device progress and sign-in cleared after sign out', await ev(p2, `Object.keys(state.srs).length`));
  await c1.close(); await c2.close();
};

// ---------- 3. Every card in every course renders and can be answered, in each answer style
tests.everyCard = async () => {
  const c = await ctx(); const p = await page(c);
  await p.goto(BASE + '/');
  // No account: the functions still work, and nothing syncs, so this can scribble on state freely.
  const out = await p.evaluate(() => {
    const problems = [], counts = {};
    const BAD = /\bundefined\b|\bnull\b|\[object Object\]|NaN|&amp;|&lt;|&gt;|&quot;|&#\d+;|\$\{/;
    const look = (where, el, it) => { const t = el.innerText; const m = t.match(BAD); if (m && it && JSON.stringify(it).includes(m[0])) return; if (m) problems.push(where + ': "' + m[0] + '" in ' + t.slice(Math.max(0, m.index - 50), m.index + 50)); if (el.innerHTML.length < 40) problems.push(where + ': nearly empty'); };
    const keys = Object.keys(COURSES).filter(k => k !== 'terms');
    for (const style of ['mixed', 'reveal', 'typed', 'short']) {
      state.prefs = state.prefs || {}; state.prefs.style = style === 'reveal' ? 'mixed' : style; state.prefs.courseStyle = {};
      for (const k of keys) {
        state.course = k; buildLessons();
        for (let i = 0; i < LESSONS.length; i++) {
          if (style === 'reveal') LESSONS[i].items.forEach((it, j) => { state.srs[cardId(LESSONS[i].id, j, it)] = { due: '2999-01-01', ok: 5, reps: 5 }; });
          try { startLesson(i); } catch (e) { problems.push(`${style} ${k} lesson ${i}: start threw ${e.message}`); continue; }
          let guard = 0;
          while (run && guard++ < 200) {
            const it = run.cur, where = `${style} ${k} ${it._card} (${it._mode}/${it.t})`;
            counts[style + ':' + it._mode] = (counts[style + ':' + it._mode] || 0) + 1;
            try {
              look(where + ' question', document.querySelector('#stage'), it);
              if (it._mode === 'typed') { showTyped(it, 3, '', 'sure', 'self'); }
              else if (it._mode === 'reveal') { check(); look(where + ' reveal', document.querySelector('#fb'), it); showTyped(it, 3, '', 'sure', 'self'); }
              else if (it.t === 'mc' || it._asMC) { pickMC(it._opts.findIndex(o => o.right)); check(); }
              else if (it.t === 'match') grade(true, '');
              else if (it.t === 'order') { run.ans = it.items.map((_, x) => x); check(); }
              look(where + ' feedback', document.querySelector('#fb'), it);
              if (run.phase !== 'feedback') problems.push(where + ': not in feedback after answering, phase ' + run.phase);
            } catch (e) { problems.push(where + ': threw ' + e.message); }
            if (!run.queue.length) break;
            nextItem();
          }
          run = null; show(null);
        }
      }
      state.srs = {}; state.done = {};
    }
    return { problems, counts };
  });
  ok(out.problems.length === 0, `every card renders cleanly (${Object.values(out.counts).reduce((a, b) => a + b, 0)} renders)`, out.problems.slice(0, 15));
  if (out.problems.length) console.log('card problems (' + out.problems.length + '):\n  ' + out.problems.slice(0, 40).join('\n  '));
  ok(out.counts['mixed:choice'] > 0 && out.counts['reveal:reveal'] > 0 && out.counts['typed:typed'] > 0, 'all answer modes were exercised', out.counts);
  ok(p.errors.length === 0, 'every card: no page errors', p.errors.slice(0, 5));
  await c.close();
};

// ---------- 4. Saved states of every shape must not break startup
tests.stateMatrix = async () => {
  const day = d => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
  const acct = JSON.stringify({ token: 'zz.notreal', player: { id: 'zz', name: 'Ghost' }, passkeys: 0 });
  const states = {
    corrupt: { 'hillspeak-v1': '{not json' },
    emptyObject: { 'hillspeak-v1': '{}' },
    jsonNull: { 'hillspeak-v1': 'null' },
    jsonArray: { 'hillspeak-v1': '[1,2,3]' },
    v1LessonPath: { 'hillspeak-v1': JSON.stringify({ done: { u0l0: true, u0l1: true }, xp: 120, streak: 3, last: day(1) }) },
    nullFields: { 'hillspeak-v1': JSON.stringify({ done: null, xp: null, srs: null, activeDays: null, settings: null, mix: null, prefs: null, removed: null, myTerms: null, hints: null, newCounts: null, accepted: null, course: null }) },
    wrongTypes: { 'hillspeak-v1': JSON.stringify({ done: [], xp: '12', srs: [], activeDays: 'x', settings: 5, mix: [], prefs: 'a', removed: [], myTerms: {}, course: 42 }) },
    oddCards: { 'hillspeak-v1': JSON.stringify({ srs: { 'zzz#1': { due: day(3) }, 'au0l0#0': null, 'au0l0#1': { due: 'garbage', s: -1 }, 'c:gone:u0l0#0': { due: day(1), ok: 3 } }, mix: { policy: { on: true, perDay: 999 }, gone: { on: true } }, course: 'gone', activeDays: [day(0), day(1), 'bad'] }) },
    unknownCourse: { 'hillspeak-v1': JSON.stringify({ course: 'nope', mix: { nope: { on: true } } }) },
    badAccount: { 'wl-account': acct },
    accountNoState: { 'wl-account': acct, 'hillspeak-v1': null },
    badGroup: { 'wl-account': acct, 'hillspeak-group': JSON.stringify({ code: 'NOPE12', groupName: '<b>x</b>', player: { id: 'zz', name: 'G' }, token: 'zz.notreal' }) },
    groupJunk: { 'hillspeak-group': '{"code":' },
    accountJunk: { 'wl-account': '{"token":' },
  };
  for (const [name, storage] of Object.entries(states)) {
    for (const route of ['', '#courses', '#course/policy', '#me', '#group']) {
      const c = await ctx({ storage }); const p = await page(c);
      await p.goto(BASE + '/' + route); await p.waitForTimeout(400);
      ok(p.errors.length === 0, `state ${name} ${route || '/'}: no page errors`, p.errors);
      const gate = await visible(p, '#gate');
      if (!gate) for (const tab of ['today', 'courses', 'group', 'me']) {
        const sel = `#tabs [data-tab="${tab}"]`;
        const cl = await clickable(p, sel);
        ok(cl === true, `state ${name} ${route || '/'}: tab ${tab} clickable`, cl);
        if (cl === true) { await p.click(sel); await p.waitForTimeout(80); ok(await ev(p, 'VIEW') === tab, `state ${name}: tab ${tab} switches view`); }
      }
      ok(p.errors.length === 0, `state ${name} ${route || '/'}: no errors after clicking around`, p.errors);
      await c.close();
    }
  }
};

// ---------- 5. Phone layout: no sideways scrolling, nothing hidden under the tab bar
tests.phoneLayout = async () => {
  const c = await ctx(); const p = await page(c);
  await signUp(p); await addToMix(p, 'tools');
  for (const v of ['today', 'courses', 'group', 'me']) {
    await ev(p, `go('${v}')`); await p.waitForTimeout(150);
    const w = await ev(p, `({ sw: document.documentElement.scrollWidth, iw: innerWidth })`);
    ok(w.sw <= w.iw + 1, `phone ${v}: no sideways scroll`, w);
    const wide = await ev(p, `[...document.querySelectorAll('main *, #home *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed'; }).slice(0, 5).map(e => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right))`);
    ok(wide.length === 0, `phone ${v}: nothing sticks out past the screen edge`, wide);
  }
  await ev(p, `go('course', 'tools')`); await p.waitForTimeout(150);
  ok(await ev(p, `document.documentElement.scrollWidth <= innerWidth + 1`), 'phone course page: no sideways scroll');
  // Last element of Me must be reachable above the tab bar.
  await ev(p, `go('me')`); await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await p.waitForTimeout(150);
  const hidden = await ev(p, `(() => { const tabs = document.querySelector('#tabs'); const tb = tabs.getBoundingClientRect(); const items = [...document.querySelectorAll('#home button, #home a')].filter(b => b.offsetParent); const last = items[items.length - 1]; if (!last) return 'no buttons'; const r = last.getBoundingClientRect(); return r.bottom <= tb.top + 1 ? true : (last.id || last.textContent.trim().slice(0, 30)) + ' bottom ' + Math.round(r.bottom) + ' tabs top ' + Math.round(tb.top); })()`);
  ok(hidden === true, 'phone Me: last button is above the tab bar when scrolled down', hidden);
  // In a session the answer button must be on screen.
  await ev(p, `go('today')`); await clickGo(p, '#todayGo');
  ok(await clickable(p, '#checkBtn') === true || await visible(p, '#recallIn'), 'phone session: Check button reachable', await clickable(p, '#checkBtn'));
  ok(p.errors.length === 0, 'phone layout: no page errors', p.errors);
  await c.close();
};

// ---------- 6. Offline first launch and a dead or slow API
tests.network = async () => {
  { // Offline from the start: the sign-up screen must offer a way in.
    const c = await ctx(); const p = await page(c);
    await p.route('**/api/**', r => r.abort('internetdisconnected'));
    await p.goto(BASE + '/'); await p.click('#gtNew');
    await p.fill('#gtName', 'Offline'); await p.fill('#gtUser', 'off' + rnd()); await p.fill('#gtPass', 'password123');
    await p.click('#gtMake'); await p.waitForTimeout(800);
    ok(await visible(p, '.gerr'), 'offline sign-up shows an error');
    ok(!(await p.locator('#gtMake').isDisabled()), 'offline sign-up: button usable again after the error');
    ok(await visible(p, '#gtOffline'), 'offline sign-up offers Continue offline');
    if (await visible(p, '#gtOffline')) { await p.click('#gtOffline'); ok(!await visible(p, '#gate'), 'Continue offline closes the sign-up screen'); await ev(p, `go('courses')`); await p.click('.switch[data-mix="lingo"]'); await ev(p, `go('today')`); await clickGo(p, '#todayGo'); for (let i = 0; i < 4; i++) await answerOne(p); ok(p.errors.length === 0, 'offline: a session works', p.errors); }
    await c.close();
  }
  { // Signed in, then the API dies: sessions still work and the Saved chip says so.
    const c = await ctx(); const p = await page(c);
    await signUp(p); await addToMix(p, 'proc'); await ev(p, `go('today')`);
    await p.route('**/api/**', r => r.abort('internetdisconnected'));
    await clickGo(p, '#todayGo'); let n = 0; while (n++ < 60 && await answerOne(p)) {}
    ok(await visible(p, '#result'), 'API down: session still finishes');
    await p.click('#rHome'); await p.waitForTimeout(1500);
    const chip = await p.getAttribute('#saved', 'data-s').catch(() => '');
    ok(chip !== 'saved', 'API down: the Saved chip does not claim it saved', chip);
    ok(p.errors.length === 0, 'API down: no page errors', p.errors);
    await p.unroute('**/api/**'); await ev(p, 'syncNow()'); await p.waitForTimeout(2000);
    ok(await p.getAttribute('#saved', 'data-s').catch(() => '') === 'saved', 'API back: progress saves', await p.getAttribute('#saved', 'data-s').catch(() => ''));
    await c.close();
  }
  { // Slow API: no double accounts from double taps.
    const c = await ctx(); const p = await page(c);
    let posts = 0;
    await p.route('**/api/account', async r => { posts++; await new Promise(res => setTimeout(res, 1500)); await r.continue(); });
    await p.goto(BASE + '/'); await p.click('#gtNew');
    await p.fill('#gtName', 'Slow'); await p.fill('#gtUser', 'slow' + rnd()); await p.fill('#gtPass', 'password123');
    await p.click('#gtMake'); await p.click('#gtMake', { force: true, timeout: 500 }).catch(() => {}); await p.press('#gtPass', 'Enter').catch(() => {});
    await p.waitForSelector('#gate', { state: 'hidden', timeout: 10000 }).catch(() => {});
    ok(posts === 1, 'double tap on Create account sends one request', posts);
    ok(p.errors.length === 0, 'slow API: no page errors', p.errors);
    await c.close();
  }
};

// ---------- 7. Groups between two accounts
tests.groups = async () => {
  const ca = await ctx(); const a = await page(ca); await signUp(a, { name: 'Ann ' + rnd() });
  await ev(a, `go('group')`);
  ok(await visible(a, '#gName') || await visible(a, '#gGroup'), 'Group tab offers to start or join a group');
  const startBtn = await ev(a, `(() => { const b = [...document.querySelectorAll('#group button')].find(b => /start/i.test(b.textContent)); if (b) b.id = b.id || 'tStart'; return b ? '#' + b.id : null; })()`);
  if (startBtn) await a.click(startBtn);
  if (await visible(a, '#gGroup')) await a.fill('#gGroup', 'Test club ' + rnd());
  await a.click('#gGo'); await a.waitForFunction(() => G && G.code, null, { timeout: 8000 }).catch(() => {});
  const code = await ev(a, 'G && G.code');
  ok(code && code.length === 6, 'started a group with a 6-character code', code);
  const cb = await ctx(); const b = await page(cb); await signUp(b, { name: 'Bob ' + rnd() });
  await b.goto(BASE + '/?join=' + code); await b.waitForTimeout(500); await ev(b, `go('group')`);
  if (await visible(b, '#gCode')) { const v = await b.inputValue('#gCode'); if (!v) await b.fill('#gCode', code); }
  await b.click('#gGo'); await b.waitForFunction(() => G && G.code, null, { timeout: 8000 }).catch(() => {});
  ok(await ev(b, 'G && G.code') === code, 'second account joined with the code');
  await ev(a, 'refreshBoard && refreshBoard()'); await a.waitForTimeout(1500);
  const names = await ev(a, `board ? board.players.map(p => p.name) : []`);
  ok(names.length === 2, 'leaderboard shows both players', names);
  ok(!badText(await a.locator('#home').innerText()), 'group page text is clean', badText(await a.locator('#home').innerText()));
  ok(a.errors.length === 0 && b.errors.length === 0, 'groups: no page errors', [...a.errors, ...b.errors]);
  await ca.close(); await cb.close();
};

// ---------- 8. Me: settings, removed questions, password change
tests.me = async () => {
  const c = await ctx(); const p = await page(c);
  const who = await signUp(p); await addToMix(p, 'policy');
  await ev(p, `go('me')`);
  ok(!badText(await p.locator('#home').innerText()), 'Me text is clean', badText(await p.locator('#home').innerText()));
  // Remove a question mid-session, then restore it from Me.
  await ev(p, `go('today')`); await clickGo(p, '#todayGo');
  const card = await ev(p, 'run.cur._card');
  await answerOne(p); if (await ev(p, `run.phase`) === 'selfgrade') await answerOne(p);
  const rm = await visible(p, '#rmBtn');
  if (rm) {
    await p.click('#rmBtn'); await p.click('[data-rm="trivia"]'); await p.waitForTimeout(300);
    ok(await visible(p, '#rmUndo'), 'removing shows Undo');
    ok(await ev(p, `isRemoved(${JSON.stringify(card)})`), 'Remove this question marks the card removed', card);
  } else ok(false, 'Remove this question button visible after answering');
  await ev(p, 'quitRun(true)'); await ev(p, `go('me')`);
  ok(await ev(p, `document.querySelector('#home').innerText.includes('Removed') || document.querySelector('#home').innerText.includes('removed')`), 'Me lists removed questions');
  // Change the password, then sign in with the new one elsewhere.
  if (await visible(p, '#aPwEdit')) await p.click('#aPwEdit');
  ok(await visible(p, '#aPwPass'), 'Me offers a password field');
  const np = 'brand new password ' + rnd();
  ok(await visible(p, '#aPwCur'), 'changing a password asks for the current one');
  await p.fill('#aPwPass', np); await p.press('#aPwPass', 'Enter'); await p.waitForTimeout(800);
  ok(/current password/i.test(await p.locator('#acctCard .gerr').innerText().catch(() => '')), 'leaving the current password blank explains what to do');
  await p.fill('#aPwCur', 'not my password'); await p.fill('#aPwPass', np); await p.press('#aPwPass', 'Enter'); await p.waitForTimeout(1200);
  ok(/isn’t right/.test(await p.locator('#acctCard .gerr').innerText().catch(() => '')), 'a wrong current password is refused', await p.locator('#acctCard .gerr').innerText().catch(() => ''));
  await p.fill('#aPwCur', who.password); await p.fill('#aPwPass', np); await p.press('#aPwPass', 'Enter'); await p.waitForTimeout(1500);
  await ev(p, 'syncNow()'); await p.waitForTimeout(1500);
  const c2 = await ctx(); const p2 = await page(c2); await p2.goto(BASE + '/'); await p2.click('#gtHave');
  await p2.fill('#gtUser', who.username); await p2.fill('#gtPass', np); await p2.click('#gtPwGo');
  await p2.waitForSelector('#gate', { state: 'hidden', timeout: 10000 }).catch(() => {});
  ok(!await visible(p2, '#gate'), 'new password works on another device');
  await p2.waitForTimeout(1500);
  ok(await ev(p2, `isRemoved(${JSON.stringify(card)})`), 'removed question stays removed on the other device');
  ok(p.errors.length === 0 && p2.errors.length === 0, 'Me: no page errors', [...p.errors, ...p2.errors]);
  await c.close(); await c2.close();
};

// ---------- 9. Regression checks for the 10/21 client review
tests.fixes = async () => {
  { // Sign-up can always get in: a 429 or a 500 from the server offers "Continue offline".
    for (const status of [429, 500]) {
      const c = await ctx(); const p = await page(c);
      await p.route('**/api/account', r => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: 'Too many new accounts from this network today. Try again tomorrow.' }) }));
      await p.goto(BASE + '/'); await p.click('#gtNew');
      await p.fill('#gtName', 'Busy'); await p.fill('#gtUser', 'busy' + rnd()); await p.fill('#gtPass', 'password123'); await p.click('#gtMake');
      await p.waitForSelector('#gtOffline', { timeout: 5000 }).catch(() => {});
      ok(await visible(p, '#gtOffline'), `sign-up after a ${status} offers Continue offline`);
      if (await visible(p, '#gtOffline')) { await p.click('#gtOffline'); await ev(p, `go('courses')`); await p.click('.switch[data-mix="lingo"]'); await ev(p, `go('today')`); await clickGo(p, '#todayGo'); await answerOne(p); await ev(p, 'quitRun(true)');
        ok(await p.getAttribute('#saved', 'data-s') === 'local', 'without an account the chip says progress is on this device', await p.getAttribute('#saved', 'data-s')); }
      await c.close();
    }
  }
  const c = await ctx(); const p = await page(c);
  const who = await signUp(p); await addToMix(p, 'proc'); await ev(p, `go('today')`);
  { // Quit asks once mid-session; Back quits; answers already given count.
    await clickGo(p, '#todayGo'); await answerOne(p); if (await ev(p, 'run.phase') === 'feedback') await answerOne(p);
    await p.click('#quitBtn'); ok(await visible(p, '#lesson'), 'first tap on quit mid-session keeps the lesson open');
    await p.click('#quitBtn'); ok(!await visible(p, '#lesson'), 'second tap quits');
    ok(await ev(p, `state.activeDays.includes(dstr(new Date())) && state.xp > 0`), 'quitting keeps the practice day and XP', await ev(p, 'state.xp'));
    const xp1 = await ev(p, 'state.xp');
    await clickGo(p, '#todayGo'); await answerOne(p); if (await ev(p, 'run.phase') === 'feedback') await answerOne(p);
    await p.goBack(); await p.waitForTimeout(300);
    ok(!await visible(p, '#lesson') && await ev(p, 'run === null'), 'Back quits a lesson instead of leaving the app', p.url());
    ok(p.url().startsWith(BASE), 'still on the app after Back');
    ok(await ev(p, 'state.xp') > xp1, 'Back keeps the XP earned so far', { xp1, now: await ev(p, 'state.xp') });
    // Quitting and switching tabs at once: the app's own step back over the lesson entry must not undo the switch.
    await clickGo(p, '#todayGo'); await answerOne(p); await ev(p, `quitRun(true); go('courses')`); await p.waitForTimeout(800);
    ok(await ev(p, 'VIEW') === 'courses' && await visible(p, '#cSearch'), 'a tab change right after quitting sticks', await ev(p, 'VIEW'));
    await ev(p, `go('courses')`); await ev(p, `go('me')`); await p.goBack(); await p.waitForTimeout(200);
    ok(await ev(p, 'VIEW') === 'courses', 'Back returns to the previous tab', await ev(p, 'VIEW'));
  }
  { // Closing the page mid-session keeps the practice day and XP.
    const c2 = await ctx(); const p2 = await page(c2); await signUp(p2); await addToMix(p2, 'lingo'); await ev(p2, `go('today')`);
    await clickGo(p2, '#todayGo'); await answerOne(p2); if (await ev(p2, 'run.phase') === 'feedback') await answerOne(p2);
    const earned = await ev(p2, 'run.xp');
    await p2.goto(BASE + '/#me'); await p2.waitForTimeout(300);
    ok(await ev(p2, 'state.xp') === earned && earned > 0, 'closing the page mid-session banks the XP once', { earned, now: await ev(p2, 'state.xp') });
    ok(await ev(p2, 'state.activeDays.includes(dstr(new Date()))'), 'closing the page mid-session keeps the practice day');
    await c2.close();
  }
  { // Typed answers: Enter checks.
    await ev(p, `state.prefs = { ...(state.prefs || {}), style: 'typed' }; save();`); await ev(p, `go('today')`);
    await clickGo(p, await visible(p, '#todayGo') ? '#todayGo' : await visible(p, '#resumeBtn') ? '#resumeBtn' : '#todayMore');
    // Matching and ordering cards are never typed; answer those until a typed card comes up.
    for (let i = 0; i < 8 && !await visible(p, '#recallIn') && await ev(p, '!!run'); i++) await answerOne(p);
    if (await visible(p, '#recallIn')) { await p.fill('#recallIn', 'my answer'); await p.press('#recallIn', 'Enter'); await p.waitForFunction(() => run && run.phase !== 'answer', null, { timeout: 15000 }).catch(() => {});
      ok(await ev(p, 'run.phase') !== 'answer', 'Enter in a typed answer checks it'); }
    else ok(false, 'typed style shows a text box');
    await ev(p, 'quitRun(true)'); await ev(p, `state.prefs.style = 'mixed'; save();`);
  }
  { // My terms: a removal survives a sync.
    await ev(p, `toggleMyTerm('cloture'); syncNow()`); await p.waitForTimeout(1500);
    await ev(p, `toggleMyTerm('cloture'); syncNow()`); await p.waitForTimeout(1500);
    ok(await ev(p, `!hasTerm('cloture') && !COURSES.terms`), 'removed term stays removed after syncing', await ev(p, 'state.myTerms'));
  }
  { // Merging: the most recent change to a card wins, even with the same review count.
    const r = await ev(p, `(() => { const a = { srs: { x: { due: '2027-01-10', last: '2026-10-20', s: 9, d: 5, reps: 1, at: 2000 } } }, b = { srs: { x: { due: '2026-10-23', last: '2026-10-20', s: 2, d: 5, reps: 1, at: 1000 } } };
      return [mergeStates(a, b).srs.x.due, mergeStates(b, a).srs.x.due]; })()`);
    ok(r[0] === '2027-01-10' && r[1] === '2027-01-10', 'newest grade wins the merge either way round', r);
  }
  { // Two tabs: a save in one is folded into the other.
    const p3 = await page(c); await p3.goto(BASE + '/'); await p3.waitForTimeout(500);
    const before = await ev(p3, 'Object.keys(state.srs).length');
    await ev(p, `go('today')`); await clickGo(p, await visible(p, '#todayGo') ? '#todayGo' : '#todayMore'); await answerOne(p); if (await ev(p, 'run.phase') === 'feedback') await answerOne(p); await ev(p, 'quitRun(true)');
    await p3.waitForTimeout(500);
    ok(await ev(p3, 'Object.keys(state.srs).length') > before, 'the other tab picks up the new progress', { before, after: await ev(p3, 'Object.keys(state.srs).length') });
    await p3.close();
  }
  { // Landscape cards that duplicate a Toolkit card are skipped when both courses are in the mix.
    const r = await ev(p, `(() => { const dups = courseCards('policy').filter(c => c.item.dup).length; setMix('policy', true); setMix('tools', false); const a = newCardsAvailable('policy').length; setMix('tools', true); const b = newCardsAvailable('policy').length; setMix('policy', false); setMix('tools', false); return { dups, a, b }; })()`);
    ok(r.dups === 0 || r.a - r.b === r.dups, 'duplicate Landscape cards hidden only when Toolkit is in the mix', r);
  }
  { // Sign-out with unsynced progress while the server is down: a warning, then a second click signs out anyway.
    await p.route('**/api/**', r => r.abort('internetdisconnected'));
    await ev(p, `state.xpBy[DEV] = (state.xpBy[DEV] || 0) + 1; save();`); await ev(p, `go('me')`);
    await p.click('#aOut'); await p.click('#aOut'); await p.waitForTimeout(800);
    ok(await visible(p, '#acctCard .gerr') && !await visible(p, '#gate'), 'sign-out warns when progress hasn’t saved', await p.locator('#acctCard .gerr').innerText().catch(() => ''));
    await p.click('#aOut'); await p.waitForTimeout(400);
    ok(await visible(p, '#gate'), 'clicking again signs out anyway');
    await p.unroute('**/api/**');
  }
  ok(p.errors.length === 0, 'fixes: no page errors', p.errors);
  await c.close();
  { // Group feed shows lesson titles from the app's own course copy, not text the poster sent.
    const ca = await ctx(); const a = await page(ca); await signUp(a);
    await ev(a, `go('group')`); await a.click('[data-gmode="start"]'); await a.fill('#gGroup', 'Feed club'); await a.fill('#gName', 'Ann'); await a.click('#gGo');
    await a.waitForFunction(() => G && G.code, null, { timeout: 8000 });
    await ev(a, `apiCall('/api/complete', { lessonId: 'au0l0', title: 'Visit spam.example now', xp: 10, acc: 90, day: dstr(new Date()) })`); await ev(a, 'refreshBoard()'); await a.waitForTimeout(800);
    const txt = await a.locator('.feed').innerText().catch(() => '');
    ok(!/spam\.example/.test(txt) && txt.includes(await ev(a, `COURSES.policy.units[0].lessons[0].title`)), 'feed uses the course’s own lesson title', txt);
    await ca.close();
  }
};

// ---------- 10. Email: confirm at sign-up, then a forgotten password (needs a server in email test mode; skipped otherwise)
tests.email = async () => {
  const cfg = await (await fetch(BASE + '/api/config')).json().catch(() => ({}));
  if (!cfg.email) { console.log('  (email tests skipped: start wrangler dev with --var EMAIL_TEST_MODE:1)'); return; }
  const c = await ctx(); const p = await page(c);
  const tag = rnd(), email = `e2e.${tag}@example.com`, username = 'em' + tag;
  await p.goto(BASE + '/'); await p.click('#gtNew');
  await p.waitForSelector('#gtEmail', { timeout: 5000 }).catch(() => {});
  ok(await visible(p, '#gtEmail'), 'sign-up offers an optional email when the server can send mail');
  await p.fill('#gtName', 'Em'); await p.fill('#gtUser', username); await p.fill('#gtPass', 'first password 1'); await p.fill('#gtEmail', email);
  const sent = p.waitForResponse(r => r.url().endsWith('/api/email'));
  await p.click('#gtMake'); const code = (await (await sent).json()).devCode;
  await p.waitForSelector('#gtVCode', { timeout: 8000 }).catch(() => {});
  ok(await visible(p, '#gtVCode'), 'after sign-up with an email, the confirm-code step shows');
  await p.fill('#gtVCode', code); await p.press('#gtVCode', 'Enter');
  await p.waitForSelector('#gate', { state: 'hidden', timeout: 8000 }).catch(() => {});
  ok(!await visible(p, '#gate') && await ev(p, 'ACCT.email') === email, 'code confirms the email and opens the app', await ev(p, 'ACCT && ACCT.email'));
  await ev(p, `go('me')`); ok((await p.locator('#acctCard').innerText()).includes(email), 'Me shows the email');
  await p.click('#aOut'); await p.click('#aOut'); await p.waitForTimeout(500);
  // Forgot the password: sign in by email, then set a new one without the old.
  await p.click('#gtHave'); await p.click('#gtEmailMode'); await p.fill('#gtEmailIn', email.toUpperCase());
  const req = p.waitForResponse(r => r.url().endsWith('/api/email/signin-request'));
  await p.press('#gtEmailIn', 'Enter'); const code2 = (await (await req).json()).devCode;
  await p.waitForSelector('#gtECode', { timeout: 8000 }).catch(() => {});
  await p.fill('#gtECode', code2); await p.press('#gtECode', 'Enter');
  await p.waitForSelector('#gate', { state: 'hidden', timeout: 8000 }).catch(() => {});
  ok(!await visible(p, '#gate') && await ev(p, 'VIEW') === 'me', 'email code signs in and opens Me');
  ok(await visible(p, '#aPwPass') && !await visible(p, '#aPwCur'), 'a fresh email sign-in can set a new password without the old one');
  await p.fill('#aPwPass', 'second password 2'); await p.press('#aPwPass', 'Enter'); await p.waitForTimeout(1500);
  const r = await (await fetch(BASE + '/api/password/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.9.9.' + (Math.random() * 200 | 0) }, body: JSON.stringify({ username, password: 'second password 2' }) })).json();
  ok(!!r.token, 'the new password works', r);
  ok(p.errors.length === 0, 'email: no page errors', p.errors);
  await c.close();
};

// ---------- 10/21: disputing a grade re-grades it; closing the app mid-session resumes it
tests.disputeAndResume = async () => {
  const c = await ctx(); const p = await page(c);
  await p.route('**/api/grade', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ score: 0, percent: 10, feedback: 'Missed the point.', points: [], missed: [] }) }));
  await p.route('**/api/dispute', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ score: 3, percent: 100, feedback: 'Correct on review.', reply: 'You were right.', outcome: 'upheld', points: [], missed: [] }) }));
  await signUp(p); await addToMix(p, 'policy'); await ev(p, `state.prefs = state.prefs || {}; state.prefs.style = 'typed'; save()`); await ev(p, `go('today')`);
  await clickGo(p, '#todayGo');
  let typed = false;
  for (let i = 0; i < 15 && !typed; i++) { if (await ev(p, `run.phase === 'answer' && run.cur._mode === 'typed'`)) typed = true; else await answerOne(p); }
  ok(typed, 'a typed card comes up');
  if (typed) {
    const card = await ev(p, 'run.cur._card');
    await p.fill('#recallIn', 'my answer'); await p.click('[data-conf="sure"]');
    await p.waitForFunction(() => run.phase === 'feedback', null, { timeout: 8000 });
    await p.click('#dispute');
    ok(await p.locator('#checkBtn').innerText() === 'Get a second opinion', 'with the note box open, the main button sends the dispute', await p.locator('#checkBtn').innerText());
    await p.fill('#dispNote', 'My answer names a real proposal.'); await settle(p); await p.click('#checkBtn');
    await p.waitForFunction(() => run.phase === 'feedback', null, { timeout: 8000 }).catch(() => {});
    ok(await ev(p, 'run.cur._card') === card, 'still on the same card after the dispute');
    ok(/You were right/.test(await p.locator('#fb').innerText()) && await p.locator('#checkBtn').innerText() === 'Continue', 'the second grade replaces the first', await p.locator('#fb').innerText());
    ok(await ev(p, `state.srs[${JSON.stringify(card)}].ok`) >= 1, 'the upheld grade is what gets scheduled');
    // Cancel goes back to the first grade
    await answerOne(p);
    for (let i = 0; i < 15; i++) { if (await ev(p, `run && run.phase === 'answer' && run.cur._mode === 'typed'`)) break; if (!await answerOne(p)) break; }
    if (await ev(p, `run && run.phase === 'answer' && run.cur._mode === 'typed'`)) {
      await p.fill('#recallIn', 'x'); await p.click('[data-conf="sure"]'); await p.waitForFunction(() => run.phase === 'feedback', null, { timeout: 8000 });
      await p.click('#dispute'); await p.click('#dispCancel');
      ok(await ev(p, 'run.phase') === 'feedback' && await visible(p, '#dispute') && await p.locator('#checkBtn').innerText() === 'Continue', 'Cancel returns to the first grade');
    }
  }
  // Resume: reload mid-session, same card comes back, XP not doubled
  if (await ev(p, `run && run.phase === 'feedback'`)) await answerOne(p);
  const before = await ev(p, `run ? { card: run.cur._card, left: run.queue.length, graded: run.graded.size, xp: state.xp + run.xp - (run.bankedXp || 0) } : null`);
  ok(!!before, 'still mid-session before reload');
  if (before) {
    await p.reload(); await p.waitForTimeout(800);
    const after = await ev(p, `run ? { card: run.cur._card, left: run.queue.length, graded: run.graded.size, xp: state.xp + run.xp - (run.bankedXp || 0) } : null`);
    ok(after && await visible(p, '#lesson'), 'reloading mid-session reopens the session', after);
    ok(after && after.card === before.card && after.left === before.left && after.graded === before.graded, 'it resumes on the same card with the same queue', { before, after });
    ok(after && after.xp === before.xp, 'XP is not counted twice', { before, after });
    await ev(p, 'quitRun(true)'); await p.reload(); await p.waitForTimeout(800);
    ok(!await visible(p, '#lesson'), 'after quitting, a reload opens home');
    // An hour-old saved session is dropped
    await ev(p, 'startSession(true)');
    ok(await ev(p, `!!run && !!localStorage.getItem('wl-run')`), 'starting a session saves it for resuming', await ev(p, `({ run: !!run, due: dueCards(dstr(new Date())).length, fresh: newCardsAvailable('policy').length })`));
    await ev(p, `(() => { const s = JSON.parse(localStorage.getItem('wl-run')); s.at -= 3601e3; localStorage.setItem('wl-run', JSON.stringify(s)); history.replaceState(null, '', location.href); })()`);
    await p.evaluate(() => { window.saveRun = () => {}; });
    await p.goto(BASE + '/?' + Date.now()); await p.waitForTimeout(800);
    ok(!await visible(p, '#lesson') && !await ev(p, `localStorage.getItem('wl-run')`), 'a session older than an hour is not resumed');
  }
  // A reload right after a change keeps it (load() crashed on startup before 10/21 and fell back to a blank state).
  await ev(p, `setMix('proc', true)`); await p.reload(); await p.waitForTimeout(300);
  ok(await ev(p, `inMix('proc') && inMix('policy')`), 'a mix change survives an immediate reload', await ev(p, 'state.mix'));
  // An expanded unit stays expanded when the page re-renders.
  await ev(p, `go('course', 'policy')`); await p.waitForTimeout(200);
  const ui = await ev(p, `[...document.querySelectorAll('#path .uhead')].findIndex(b => b.getAttribute('aria-expanded') === 'false')`);
  if (ui >= 0) { await p.click(`#path .uhead[data-unit="${ui}"]`); await ev(p, 'renderHome()');
    ok(await p.getAttribute(`#path .uhead[data-unit="${ui}"]`, 'aria-expanded') === 'true', 'an opened unit stays open after a re-render'); }
  ok(p.errors.length === 0, 'disputeAndResume: no page errors', p.errors);
  await c.close();
};

// ---------- 11. Sources on cards, course dates, search, bug reports (10/21)
tests.extras = async () => {
  const c = await ctx(); const p = await page(c);
  await signUp(p);
  { // Sources: a small link under the explanation, opening in a new tab.
    await ev(p, `go('course', 'tools')`); await ev(p, 'startLesson(0)');
    await answerOne(p); if (await ev(p, 'run.phase') === 'selfgrade') await answerOne(p);
    const src = await ev(p, `[...document.querySelectorAll('#fb .srcs a')].map(a => ({ href: a.href, target: a.target, text: a.textContent }))`);
    ok(src.length > 0 && src.every(x => /^https?:/.test(x.href) && x.target === '_blank' && x.text && !x.text.includes('/')), 'feedback shows source links by site name', src);
    await ev(p, 'quitRun(true)');
  }
  { // Key terms: the list comes up before the first session with Landscape; "Know it" terms get no card, the rest come first.
    await ev(p, `if (run) quitRun(true); delete state.keyTerms; ktAsked.clear(); setMix('policy', true); go('today')`);
    await p.click(await visible(p, '#todayGo') ? '#todayGo' : '#todayMore');
    ok(await visible(p, '#ktSheet'), 'key terms list shows before the first session with the course');
    const n = await p.locator('#ktSheet [data-kt]').count();
    await p.locator('#ktSheet [data-kt]').nth(0).click(); await p.locator('#ktSheet [data-kt]').nth(1).click();
    ok(await p.locator('#ktSheet [data-kt][aria-pressed="true"]').count() === 2, 'Know it toggles on each term');
    await p.click('#ktDone');
    const r = await ev(p, `({ known: state.keyTerms.policy.known.length, cards: keyTermCards('policy').length, first: courseCards('policy')[0].id, run: !!run, sheet: !document.querySelector('#ktSheet').hidden })`);
    ok(n > 10 && r.known === 2 && r.cards === n - 2 && r.first.startsWith('au0l0#key-') && r.run && !r.sheet, 'known terms skipped, the rest come first, then the session starts', { n, ...r });
    ok(await ev(p, `(() => { const i = GLOSSARY.findIndex(g => g.term === 'preemption'); GL_SKIP = [i]; const a = gl('What does preemption mean?'); GL_SKIP = []; return !a.includes('class="gl"') && gl('preemption').includes('class="gl"'); })()`), 'a term card does not underline its own term');
    await ev(p, `quitRun(true); go('course', 'policy')`);
    ok(/\d+ of \d+ added/.test(await p.locator('[data-keyterms]').innerText()), 'course page shows how many key terms were added');
    await p.click('[data-keyterms]'); ok(await visible(p, '#ktSheet'), 'course page reopens the list');
    await p.click('#ktClose'); ok(!await visible(p, '#ktSheet'), 'closing the list hides it');
    await ev(p, `setMix('policy', false)`);
  }
  { // Order cards: drag a placed step to another spot (step 5 to spot 2), and drag from the pool into a spot.
    await ev(p, `if (run) quitRun(true); go('course', 'proc'); buildLessons(); startLesson(0)`);
    for (let i = 0; i < 10 && await ev(p, `run && run.cur.t !== 'order'`); i++) await answerOne(p);
    if (await ev(p, `run && run.cur.t === 'order'`)) {
      const drag = async (from, to) => {
        const a = await p.locator(from).first().boundingBox(), b = await p.locator(to).first().boundingBox();
        await p.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await p.mouse.down();
        await p.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 12, { steps: 3 });
        await p.mouse.move(b.x + 40, b.y + b.height / 2, { steps: 8 }); await p.mouse.up();
      };
      const pool0 = await ev(p, 'run.pool.slice()');
      await drag('#stage .pool [data-p]', '#stage .slots li:nth-child(1)');
      ok(await ev(p, 'run.ans.length') === 1 && await ev(p, 'run.ans[0]') === pool0[0], 'dragging from the pool places the step', await ev(p, 'run.ans'));
      for (let i = 0; i < 9 && await p.locator('#stage .pool [data-p]').count(); i++) { await p.waitForTimeout(450); await p.locator('#stage .pool [data-p]').first().click(); }
      const before = await ev(p, 'run.ans.slice()');
      await drag('#stage .slots li:nth-child(5) .chip', '#stage .slots li:nth-child(2)');
      const after = await ev(p, 'run.ans.slice()');
      const want = before.slice(); want.splice(1, 0, want.splice(4, 1)[0]);
      ok(JSON.stringify(after) === JSON.stringify(want), 'dragging step 5 to spot 2 moves it there', { before, after });
      ok(!await p.locator('.chip.ghost').count(), 'the dragged copy is gone after the drop');
    } else ok(false, 'found an order card in the first Procedure lesson');
    await ev(p, 'if (run) quitRun(true)');
  }
  { // Rounds: with 5 cards a session, Today shows the day as rounds and the result screen offers the next round.
    await ev(p, `state.prefs = { ...(state.prefs || {}), sessionSize: 5 }; setMix('lingo', true); setMix('proc', true); go('today')`);
    const txt = await p.locator('#todayWrap').innerText();
    ok(/rounds of up to 5/.test(txt), 'Today shows rounds of 5', txt.slice(0, 200));
    await clickGo(p, await visible(p, '#todayGo') ? '#todayGo' : '#todayMore');
    ok(await ev(p, 'run.total') <= 5, 'a round has at most 5 cards', await ev(p, 'run.total'));
    let n = 0; while (n++ < 30 && await answerOne(p)) {}
    ok(/^Next \d/.test(await p.locator('#rMore').innerText().catch(() => '')), 'result screen offers the next round', await p.locator('#rMore').innerText().catch(() => ''));
    await ev(p, `delete state.prefs.sessionSize; save(); goHome()`);
  }
  { // Course dates near the top of the course page.
    await ev(p, `go('course', 'policy')`);
    const d = await p.locator('.cdates').innerText().catch(() => '');
    ok(/^Made [A-Z][a-z]{2} \d{1,2}, 20\d\d · updated [A-Z][a-z]{2} \d{1,2}, 20\d\d$/.test(d) || /^Made [A-Z][a-z]{2} \d{1,2}, 20\d\d$/.test(d), 'course page shows when it was made and updated', d);
  }
  { // Search across cards and the glossary.
    await ev(p, `go('courses')`);
    await p.fill('#cSearch', 'export controls');
    const n = await p.locator('#cSearchOut .sres').count();
    ok(n > 3 && !await visible(p, '#cLists'), 'search finds cards and hides the course lists', n);
    await p.locator('#cSearchOut .sres:has(.sans) summary').first().click();
    ok(await p.locator('#cSearchOut .sres[open] .sans').first().isVisible(), 'tapping a result shows its answer');
    await p.fill('#cSearch', 'cloture'); ok((await p.locator('#cSearchOut').innerText()).includes('Terms'), 'search finds glossary terms');
    await p.fill('#cSearch', 'zzqx nothing here'); ok(/Nothing matches/.test(await p.locator('#cSearchOut').innerText()), 'no-match message');
    await p.fill('#cSearch', '<img src=x onerror=window.__pwned=1>'); await p.waitForTimeout(200);
    ok(await ev(p, 'window.__pwned === undefined'), 'search text is escaped');
    await p.fill('#cSearch', ''); ok(await visible(p, '#cLists'), 'clearing search brings the course lists back');
    await ev(p, `go('today')`); await ev(p, `go('courses')`); ok(await p.inputValue('#cSearch') === '', 'search box survives re-render');
  }
  { // Bug reports: an error shows the banner and is sent to the server once.
    const posted = p.waitForResponse(r => r.url().endsWith('/api/bug'), { timeout: 5000 }).catch(() => null);
    await ev(p, `setTimeout(() => { throw new Error('e2e test error ${rnd()}'); }, 0); null`);
    const r = await posted;
    ok(r && r.status() === 200, 'an uncaught error is reported to the server', r && r.status());
    ok(await p.locator('[role="alert"]').isVisible().catch(() => false), 'the crash banner shows with a Reload button');
  }
  const pageErrors = p.errors.filter(e => !/e2e test error/.test(e));
  ok(pageErrors.length === 0, 'extras: no page errors', pageErrors);
  await c.close();
};

for (const [name, fn] of Object.entries(tests)) {
  if (ONLY && !ONLY.has(name)) continue;
  const t0 = Date.now();
  try { await fn(); } catch (e) { ok(false, `${name} crashed: ${e.message.split('\n')[0]}`); }
  console.log(`${name}: ${((Date.now() - t0) / 1000).toFixed(1)}s, ${failN} failures so far`);
}
await browser.close();
console.log(`PASS ${pass}  FAIL ${failN}`); fails.forEach(f => console.log('FAIL', f));
process.exit(failN ? 1 : 0);
