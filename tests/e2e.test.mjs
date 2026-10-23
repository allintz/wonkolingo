// Browser tests in headless Chrome against a LOCAL `wrangler dev` (they create accounts and groups, so never production).
// Run: node tests/e2e.test.mjs http://localhost:8799   (needs Google Chrome; set CHROME=/path/to/chrome otherwise)
// Covers: cold start on every route, sign-up and sign-in, a full session, every card rendered and answered in every
// style, saved states of every shape, phone layout, offline and slow networks, groups, and Me settings.
import { tidyChecks } from './tidy-checks.mjs';
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
  // Real Google traffic is blocked (it can take 30 s from here); the Google test registers its own stub, which takes precedence.
  await c.route('https://accounts.google.com/**', r => r.abort());
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

// Opens the sign-up or sign-in screen's password form. With Google sign-in on, the form sits behind a link.
async function openForm(p, sel) { await p.click(sel); if (await visible(p, '#gtPwOpen')) await p.click('#gtPwOpen'); }
async function signUp(p, { name = 'Tester ' + rnd(), username = 'u' + rnd(), password = 'correct horse ' + rnd() } = {}) {
  await p.goto(BASE + '/');
  await openForm(p, '#gtNew');
  await p.fill('#gtName', name); await p.fill('#gtUser', username); await p.fill('#gtPass', password);
  await p.click('#gtMake');
  await p.waitForSelector('#gate', { state: 'hidden', timeout: 15000 });
  return { name, username, password };
}
// Starts today's session; a course's key-terms list may come up first, and Done (everything added) continues.
async function clickGo(p, sel) { await p.click(sel); for(let n=0;n<10 && await visible(p,'#ktSheet');n++) await p.click('#ktDone'); }
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
      await openForm(p, '#gtHave'); ok(await visible(p, '#gtUser'), `${r || '/'}: sign-in form opens`);
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
  await p.goto(BASE + '/'); await openForm(p, '#gtNew');
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
  { const cx = await ctx(); const px = await page(cx); await px.goto(BASE + '/'); await openForm(px, '#gtNew'); await px.fill('#gtName', 'Dup'); await px.fill('#gtUser', who.username.toUpperCase()); await px.fill('#gtPass', 'another password');
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
  await p2.goto(BASE + '/'); await openForm(p2, '#gtHave');
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
    await p.goto(BASE + '/'); await openForm(p, '#gtNew');
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
    await p.goto(BASE + '/'); await openForm(p, '#gtNew');
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
    await p.click('#rmBtn'); await p.waitForTimeout(200);
    ok(await ev(p, `isRemoved(${JSON.stringify(card)})`), 'Remove this question removes the card in one tap', card);
    ok(await visible(p, '#rmUndo') && !await visible(p, '.chipbtn'), 'removing shows Undo and asks no reason');
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
  const c2 = await ctx(); const p2 = await page(c2); await p2.goto(BASE + '/'); await openForm(p2, '#gtHave');
  await p2.fill('#gtUser', who.username); await p2.fill('#gtPass', np); await p2.click('#gtPwGo');
  await p2.waitForSelector('#gate', { state: 'hidden', timeout: 10000 }).catch(() => {});
  ok(!await visible(p2, '#gate'), 'new password works on another device');
  await p2.waitForTimeout(1500);
  ok(await ev(p2, `isRemoved(${JSON.stringify(card)})`), 'removed question stays removed on the other device');
  ok(p.errors.length === 0 && p2.errors.length === 0, 'Me: no page errors', [...p.errors, ...p2.errors]);
  await c.close(); await c2.close();
};

// Tester mode: the switch in Me, ratings and a comment under an answer, and the end-of-session note, each accepted by the server.
tests.tester = async () => {
  const c = await ctx(); const p = await page(c);
  await signUp(p); await addToMix(p, 'policy');
  await ev(p, `go('me')`);
  ok(await visible(p, '#testerSw[aria-pressed="false"]'), 'Me shows Tester mode, off by default');
  await p.click('#testerSw'); ok(await ev(p, 'testerOn()') && await visible(p, '#testerSw[aria-pressed="true"]'), 'the switch turns tester mode on');
  await ev(p, `state.prefs.sessionSize = 5; save(); go('today')`); await clickGo(p, '#todayGo');
  ok(await visible(p, '#stage .tbox [data-tuseful="5"]') && await visible(p, '#stage .tbox [data-tlevel="3"]'), 'ratings show on the card before answering');
  const sent = path => p.waitForResponse(r => r.url().endsWith(path) && r.request().method() === 'POST', { timeout: 8000 }).then(r => r.status()).catch(() => 0);
  let st = sent('/api/rating'); await p.click('.tbox [data-tuseful="4"]');
  ok(await st === 200 && await visible(p, '.tbox [data-tuseful="4"][aria-pressed="true"]') && await ev(p, `run.phase`) === 'answer', 'a usefulness tap before answering is saved and leaves the card unanswered');
  await answerOne(p); if (await ev(p, 'run.phase') === 'selfgrade') await answerOne(p);
  ok(await ev(p, `[...document.querySelectorAll('.tbox')].filter(b => b.offsetParent).length`) === 1, 'after answering there is exactly one ratings box');
  st = sent('/api/rating'); await p.click('.tbox [data-tlevel="1"]'); ok(await st === 200, 'a level tap after answering is saved');
  await p.click('#tcBtn'); await p.fill('#tcNote', 'Test comment ' + rnd());
  st = sent('/api/rating'); await p.click('#tcSend'); ok(await st === 200 && /Comment sent/.test(await p.locator('.tcom').innerText()), 'a comment is sent');
  let n = 0; while (n++ < 30 && await ev(p, `!!run && $('#result').hidden`) && await answerOne(p)) {}
  await p.waitForTimeout(400);
  if (await visible(p, '#tnoteIn')) {
    await p.fill('#tnoteIn', 'Session note ' + rnd());
    st = sent('/api/rating/session'); await p.click('#tnoteSend');
    ok(await st === 200 && /Note sent/.test(await p.locator('#resultIn .tnote').innerText()), 'the end-of-session note is sent');
  } else ok(false, 'the result screen offers a tester note');
  ok(p.errors.length === 0, 'tester mode: no page errors', p.errors);
  await c.close();
};

// ---------- 9. Regression checks for the 10/21 client review
tests.fixes = async () => {
  { // Sign-up can always get in: a 429 or a 500 from the server offers "Continue offline".
    for (const status of [429, 500]) {
      const c = await ctx(); const p = await page(c);
      await p.route('**/api/account', r => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: 'Too many new accounts from this network today. Try again tomorrow.' }) }));
      await p.goto(BASE + '/'); await openForm(p, '#gtNew');
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
    ok(r.b <= r.a, 'adding Toolkit never adds duplicate Landscape questions', r);
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
  await p.goto(BASE + '/'); await openForm(p, '#gtNew');
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
  await openForm(p, '#gtHave'); await p.click('#gtEmailMode'); await p.fill('#gtEmailIn', email.toUpperCase());
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
    await ev(p, 'startSession(true)'); for(let n=0;n<10 && await visible(p,'#ktSheet');n++) await p.click('#ktDone');
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
    await ev(p, `go('course', 'tools')`); await ev(p, 'startLesson(0)'); if(await visible(p,'#ktSheet')) await p.click('#ktDone');
    await answerOne(p); if (await ev(p, 'run.phase') === 'selfgrade') await answerOne(p);
    const src = await ev(p, `[...document.querySelectorAll('#fb .srcs a')].map(a => ({ href: a.href, target: a.target, text: a.textContent }))`);
    ok(src.length > 0 && src.every(x => /^https?:/.test(x.href) && x.target === '_blank' && x.text && !x.text.includes('/')), 'feedback shows source links by site name', src);
    await ev(p, 'quitRun(true)');
  }
  { // Key terms: the course's first lesson, no list before sessions; "Know it" skips a term; the rest come first in sessions.
    await ev(p, `if (run) quitRun(true); delete state.keyTerms; setMix('policy', true); go('today')`);
    await clickGo(p, await visible(p, '#todayGo') ? '#todayGo' : '#todayMore');
    ok(!await visible(p, '#ktSheet') && await ev(p, '!!run'), 'a session starts with no key terms list first');
    ok(await ev(p, `run.queue.concat(run.cur).some(q => /#basic-/.test(q._card))`), 'shared Basics cards precede the key terms');
    await ev(p, `quitRun(true); go('course', 'policy')`);
    ok(/0 · Key terms/.test(await p.locator('.keyblock').innerText()), 'course page shows Key terms as unit 0 above the units');
    ok(await ev(p, `LESSONS.some(l=>l.id==='akey'&&l.items.length>10)&&LESSONS[0].unit===-2`), 'Basics precedes the key terms lesson');
    ok(!await visible(p, '[data-keyterms]') && !await visible(p, '[data-perday]') && await visible(p, '.switch[data-mix="policy"]'), 'course settings are hidden except the daily mix switch');
    await p.click('[data-cadv]'); ok(await visible(p, '[data-keyterms]') && await visible(p, '[data-perday="5"][aria-pressed="true"]'), 'Advanced options shows key terms and new cards a day (5 by default)');
    await p.click('[data-keyterms]'); ok(await visible(p, '#ktSheet'), 'course page opens the skip list');
    const n = await p.locator('#ktSheet [data-kt]').count();
    await p.locator('#ktSheet [data-kt]').nth(0).click(); await p.locator('#ktSheet [data-kt]').nth(1).click();
    ok(await p.locator('#ktSheet [data-kt][aria-pressed="true"]').count() === 2, 'Know it toggles on each term');
    await p.click('#ktDone');
    const r = await ev(p, `({ known: state.keyTerms.policy.known.length, cards: keyTermCards('policy').filter(it=>!isFamiliar(it.id)).length, lesson: LESSONS.find(l=>l.id==='akey').items.length })`);
    ok(r.known === 2 && r.cards === n - 2 && r.lesson === n - 2, 'known terms are skipped in the lesson and sessions', { n, ...r });
    ok(/2 of \d+ skipped/.test(await p.locator('[data-keyterms]').innerText()), 'course page shows how many terms were skipped');
    await ev(p, `delete state.keyTerms; buildLessons(); renderHome()`);
    await p.click('.keyblock .uhead'); ok(await visible(p, '#ktSheet') && !await ev(p, '!!run'), 'opening Key terms before answering the list shows the list first');
    await p.locator('#ktSheet [data-kt]').nth(0).click(); await p.locator('#ktSheet [data-kt]').nth(1).click(); await p.click('#ktDone');
    ok(await ev(p, `run && run.mode === 'lesson' && run.total === ${n - 2}`), 'after the list, the lesson starts without the known terms', await ev(p, 'run && run.total'));
    await ev(p, `quitRun(true); go('course', 'policy')`);
    await p.click('.keyblock .uhead'); ok(await ev(p, `run && run.mode === 'lesson' && /#key-/.test(run.cur._card)`), 'the Key terms lesson starts from the course page');
    ok(await ev(p, `(() => { const i = GLOSSARY.findIndex(g => g.term === 'preemption'); GL_SKIP = [i]; const a = gl('What does preemption mean?'); GL_SKIP = []; return !a.includes('class="gl"') && gl('preemption').includes('class="gl"'); })()`), 'a term card does not underline its own term');
    await ev(p, `quitRun(true); setMix('policy', false)`);
  }
  { // Remove this question before answering: the card leaves the round ungraded and the next one comes up.
    await ev(p, `if (run) quitRun(true); setMix('policy', true); go('today')`);
    await clickGo(p, await visible(p, '#todayGo') ? '#todayGo' : '#todayMore');
    const before = await ev(p, `({ id: run.cur._card, total: run.total })`);
    ok(await visible(p, '#rmPre'), 'an unanswered card shows Remove this question');
    await p.click('#rmPre');
    const after = await ev(p, `({ id: run && run.cur && run.cur._card, total: run && run.total })`);
    ok(!await visible(p, '#stage .chipbtn'), 'removing asks nothing and goes to the next card');
    ok(await ev(p, `!!state.removed[${JSON.stringify(before.id)}] && !state.srs[${JSON.stringify(before.id)}]`), 'removing before answering marks it removed without a grade');
    ok(before.total === 1 ? !after.id : (after.id !== before.id && after.total === before.total - 1), 'the next card comes up and the round is one shorter', { before, after });
    await ev(p, `restoreCard(${JSON.stringify(before.id)}); if (run) quitRun(true); setMix('policy', false)`);
  }
  { // Skip for now: the card leaves the round ungraded, isn't removed, and stays out of rounds until reload.
    await ev(p, `if (run) quitRun(true); setMix('policy', true); go('today')`);
    await clickGo(p, await visible(p, '#todayGo') ? '#todayGo' : '#todayMore');
    const before = await ev(p, `({ id: run.cur._card, total: run.total })`);
    ok(await visible(p, '#skipBtn'), 'an unanswered card shows Skip for now');
    await p.click('#skipBtn');
    const after = await ev(p, `({ id: run && run.cur && run.cur._card, total: run && run.total })`);
    ok(await ev(p, `!isRemoved(${JSON.stringify(before.id)}) && !state.srs[${JSON.stringify(before.id)}] && SKIPPED.has(${JSON.stringify(before.id)})`), 'skipping leaves the card unremoved and ungraded');
    ok(before.total === 1 ? !after.id : (after.id !== before.id && after.total === before.total - 1), 'skipping brings up the next card', { before, after });
    ok(await ev(p, `!newCardsAvailable('policy').some(c => c.id === ${JSON.stringify(before.id)})`), 'a skipped card stays out of new cards until reload');
    await ev(p, `SKIPPED.clear(); if (run) quitRun(true); setMix('policy', false)`);
    await ev(p, `go('course', 'proc')`);
    ok(await ev(p, `document.querySelector('#courseHead .clevel') && document.querySelector('#courseHead .clevel').innerText.includes('Beginner')`), 'the course page shows its level');
    await ev(p, `go('courses')`);
    ok(await ev(p, `document.querySelector('#coursesBody').innerText.includes('Advanced')`), 'the Courses list shows levels');
  }
  { // Sessions card in Me: Sounds switch, the rest under Advanced.
    await ev(p, `go('me')`);
    ok(!await visible(p, '#advBody') && await visible(p, '#soundSw'), 'Me shows Sounds, with Advanced closed');
    await p.click('#soundSw'); ok(await ev(p, 'state.prefs.sound === false && !soundOn()'), 'Sounds switch turns sounds off');
    await p.click('#soundSw'); ok(await ev(p, 'soundOn()'), 'and back on');
    await p.click('#advBtn'); ok(await visible(p, '#advBody') && await visible(p, '[data-size="5"]'), 'Advanced opens answer style and cards per round');
    ok(await ev(p, `sessionSize() === 5 || state.prefs.sessionSize !== undefined`), 'default round size is 5');
    ok(await ev(p, `(() => { sfx('good'); sfx('bad'); sfx('done'); return true; })()`) && p.errors.length === 0, 'sounds play without errors', p.errors);
    await ev(p, `go('course', 'policy')`);
    await ev(p, `cAdv.policy = false; renderHome()`);
    ok(!await visible(p, '[data-cstyle]') && await visible(p, '[data-cadv]'), 'course page hides answer style under Advanced options');
    await p.click('[data-cadv]'); ok(await visible(p, '[data-cstyle="short"]'), 'the link opens the course answer style');
  }
  { // Course content updates (the iPhone app path): newer content replaces built-in cards; older content is ignored.
    const r = await ev(p, `(() => { const C = COURSES.frontier, old = C.units[0].lessons[0].items[0].p, at = contentAt;
      const units = JSON.parse(JSON.stringify(C.units)); units[0].lessons[0].items[0].p = 'CHANGED?';
      const okNew = applyContent({ builtAt: at + 1000, courses: { frontier: { ...C, units } }, glossary: GLOSSARY.slice(), sources: {} });
      const changed = COURSES.frontier.units[0].lessons[0].items[0].p === 'CHANGED?';
      const okOld = applyContent({ builtAt: at, courses: {} });
      const bad = applyContent({ builtAt: at + 5000, courses: { frontier: { name: 'x', pre: 'f', units: 'nope' } } });
      const kept = COURSES.frontier.units[0].lessons[0].items[0].p === 'CHANGED?';
      COURSES.frontier.units[0].lessons[0].items[0].p = old; return { okNew, changed, okOld, kept, glre: !!GL_RE }; })()`);
    ok(r.okNew && r.changed && !r.okOld && r.kept && r.glre, 'applyContent takes newer content, skips older and malformed courses', r);
    const cj = await (await fetch(BASE + '/content.json')).json();
    ok(cj.builtAt > 0 && Object.keys(cj.courses).length >= 5 && cj.glossary.length > 50 && cj.courses.policy.units.length > 0, 'content.json is served with every built-in course', Object.keys(cj.courses));
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

// Play first: a new player picks a course on the welcome screen, does a short session with no account, then is asked to
// save their progress; the account they make keeps it. Admin endpoints refuse ordinary players.
tests.trial = async () => {
  const c = await ctx(), p = await page(c);
  await p.goto(BASE + '/');
  ok(await visible(p, '[data-try="policy"]') && await visible(p, '#gtHave'), 'welcome shows courses to try and a sign-in link');
  await p.click('[data-try="lingo"]');
  ok(!await visible(p, '#gate') && await ev(p, `!!run && run.mode === 'session' && !ACCT`), 'picking a course starts a session with no account');
  ok(await ev(p, `run.total <= 5`), 'the trial session is 5 cards or fewer', await ev(p, 'run.total'));
  let n = 0; while (n++ < 20 && await answerOne(p)) {}
  ok(await visible(p, '#result') && /Save my progress/.test(await p.locator('#rHome').innerText()), 'the result screen offers to save progress');
  ok(!await visible(p, '#rMore'), 'no next round before saving');
  const cards = await ev(p, 'Object.keys(state.srs).length');
  await p.click('#rHome');
  ok(await visible(p, '#gate') && /Save your progress/.test(await p.locator('#gateIn').innerText()), 'leaving the trial shows Save your progress');
  ok(!await visible(p, '#gtBack'), 'no back button on the save screen');
  await p.reload(); ok(await visible(p, '#gate') && /Save your progress/.test(await p.locator('#gateIn').innerText()), 'a reload still asks to save');
  if (await visible(p, '#gtPwOpen')) await p.click('#gtPwOpen');
  await p.fill('#gtName', 'Trial ' + rnd()); await p.fill('#gtUser', 't' + rnd()); await p.fill('#gtPass', 'trial password ' + rnd());
  await p.click('#gtMake'); await p.waitForSelector('#gate', { state: 'hidden', timeout: 15000 });
  ok(await ev(p, `!!ACCT && Object.keys(state.srs).length`) === cards && cards > 0, 'the new account keeps the trial progress', cards);
  const r = await ev(p, `fetch('/api/admin/summary', { headers: { Authorization: 'Bearer ' + ACCT.token } }).then(r => r.status)`);
  ok(r === 403, 'admin summary refuses a non-admin player', r);
  const r2 = await ev(p, `fetch('/api/admin/summary').then(r => r.status)`);
  ok(r2 === 403, 'admin summary refuses no sign-in', r2);
  // Quitting a trial session early also leads to the save screen (or the welcome if nothing was answered).
  const c2 = await ctx(), q = await page(c2);
  await q.goto(BASE + '/'); await q.click('[data-try="proc"]'); await ev(q, 'quitRun(true)');
  ok(await visible(q, '#gate') && /Welcome/.test(await q.locator('#gateIn').innerText()), 'quitting before answering returns to the welcome');
  ok(p.errors.length === 0 && q.errors.length === 0, 'trial: no page errors', p.errors.concat(q.errors));
  await c.close(); await c2.close();
};

// Sign in with Google (only on a server started with the test Google key; see tests/README.md). Google's script is
// replaced by a stub whose button hands the page a token signed with the test key.
tests.google = async () => {
  const cfg = await (await fetch(BASE + '/api/config')).json();
  if (!cfg.google) { console.log('google: skipped (server has no GOOGLE_CLIENT_ID)'); return; }
  const { createSign, createPrivateKey } = await import('node:crypto');
  const KEY = JSON.parse((await import('node:fs')).readFileSync(new URL('./idp-test-key.json', import.meta.url)));
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tok = claims => { const now = Math.floor(Date.now() / 1000), h = b64({ alg: 'RS256', kid: 'wl-test' }), b = b64({ iss: 'https://accounts.google.com', aud: cfg.google, iat: now, exp: now + 3600, ...claims });
    return h + '.' + b + '.' + createSign('RSA-SHA256').update(h + '.' + b).sign(createPrivateKey({ key: KEY.private, format: 'jwk' })).toString('base64url'); };
  // wrangler.toml sets a real Google client id, so every server reports Google on; only one started with the test key accepts our tokens.
  const probe = await fetch(BASE + '/api/google', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: tok({ sub: 'probe' + rnd() }) }) });
  if (!probe.ok) { console.log('google: skipped (server lacks the test key; start it as in tests/README.md)'); return; }
  const stub = c => c.route('https://accounts.google.com/gsi/client', r => r.fulfill({ contentType: 'text/javascript', body: `window.google = { accounts: { id: {
    initialize(o) { window.__gcb = o.callback; },
    renderButton(el) { const b = document.createElement('button'); b.className = 'fakeG'; b.textContent = 'Continue with Google'; b.onclick = () => window.__gcb({ credential: window.__gtok }); el.appendChild(b); } } } };` }));
  const sub = 'e2e' + rnd() + rnd();
  const c = await ctx(); await stub(c); const p = await page(c);
  await p.goto(BASE + '/'); await p.click('[data-try="lingo"]');
  let n = 0; while (n++ < 20 && await answerOne(p)) {}
  const cards = await ev(p, 'Object.keys(state.srs).length');
  await p.click('#rHome');
  await p.waitForSelector('#gateIn .fakeG', { timeout: 8000 });
  ok(!await visible(p, '#gtForm') && await visible(p, '#gtPwOpen'), 'save screen leads with Google; the password form is behind a link');
  await ev(p, `window.__gtok = ${JSON.stringify(tok({ sub, email: sub + '@example.com', email_verified: true, given_name: 'Greta' }))}`);
  await p.click('#gateIn .fakeG'); await p.waitForSelector('#gate', { state: 'hidden', timeout: 15000 });
  ok(await ev(p, `!!ACCT && ACCT.player.name === 'Greta' && ACCT.google === '${sub}@example.com'`), 'Google makes an account named from the profile');
  ok(await ev(p, 'Object.keys(state.srs).length') === cards && cards > 0, 'and keeps the trial progress', cards);
  await ev(p, `go('me')`); ok(/Google/.test(await p.locator('#acctCard').innerText()), 'Me shows the connected Google account');
  await ev(p, 'syncNow()'); await p.waitForTimeout(800);
  // Another device: sign-in screen leads with Google, other ways are tucked away.
  const c2 = await ctx(); await stub(c2); const q = await page(c2);
  await q.goto(BASE + '/'); await q.click('#gtHave'); await q.waitForSelector('#gateIn .fakeG', { timeout: 8000 });
  ok(!await visible(q, '#gtForm') && !await visible(q, '#gtCodeMode') && await visible(q, '#gtMore'), 'sign-in shows Google first, the rest behind links');
  await q.click('#gtMore'); ok(await visible(q, '#gtCodeMode') && await visible(q, '#gtRecMode'), 'Other ways shows codes');
  await q.click('#gtPwOpen'); ok(await visible(q, '#gtUser'), 'the password form opens');
  await ev(q, `window.__gtok = ${JSON.stringify(tok({ sub }))}`);
  await q.click('#gateIn .fakeG'); await q.waitForSelector('#gate', { state: 'hidden', timeout: 15000 });
  ok(await ev(q, 'ACCT && ACCT.player.name') === 'Greta', 'Google signs in to the same account on another device');
  await q.waitForTimeout(1500);
  ok(await ev(q, 'Object.keys(state.srs).length') === cards, 'with its progress', await ev(q, 'Object.keys(state.srs).length'));
  // A password account connects Google from Me.
  const c3 = await ctx(); await stub(c3); const r3 = await page(c3);
  await signUp(r3); await ev(r3, `go('me')`); await r3.click('#aG'); await r3.waitForSelector('#acctCard .fakeG', { timeout: 8000 });
  await ev(r3, `window.__gtok = ${JSON.stringify(tok({ sub: 'link' + rnd() + rnd(), email: 'linked@example.com', email_verified: true }))}`);
  await r3.click('#acctCard .fakeG'); await r3.waitForFunction(() => ACCT.google, null, { timeout: 8000 });
  ok(/linked@example\.com/.test(await r3.locator('#acctCard').innerText()), 'Me connects Google to a password account');
  const errs = p.errors.concat(q.errors, r3.errors); ok(errs.length === 0, 'google: no page errors', errs);
  await c.close(); await c2.close(); await c3.close();
};

// Regressions for the 10/21 bug hunt.
tests.regressions = async () => {
  const c = await ctx(), p = await page(c);
  // A trial closed on its result screen asks to save on the next launch instead of opening the app with no account.
  await p.goto(BASE + '/'); await p.click('[data-try="proc"]');
  let n = 0; while (n++ < 20 && await answerOne(p)) {}
  ok(await visible(p, '#result'), 'trial finished');
  await p.reload();
  ok(await visible(p, '#gate') && /Save your progress/.test(await p.locator('#gateIn').innerText()), 'reloading on the result screen asks to save progress');
  // Merging a trial device into an account adds the tried course to the account's mix; courses switched off stay off.
  const m = await ev(p, `(() => { const a = { ...blankState(), mix: { lingo: { on: true, perDay: 5 } }, mixAt: 200 }, b = { ...blankState(), mix: { proc: { on: true, perDay: 5 }, policy: { on: false, perDay: 5 } }, mixAt: 100 };
    const o = mergeStates(b, a); return { lingo: !!o.mix.lingo && o.mix.lingo.on, proc: !!o.mix.proc && o.mix.proc.on, policy: !!o.mix.policy && o.mix.policy.on }; })()`);
  ok(m.lingo && m.proc && !m.policy, 'merged mix keeps both sides\' courses, and off stays off', m);
  // Bad downloaded content is ignored rather than breaking the app.
  const r = await ev(p, `(() => { const before = JSON.stringify(COURSES.frontier.units).length, at = contentAt;
    const a = applyContent({ builtAt: at + 10, courses: { frontier: { name: 'X', pre: 'f', units: [{ title: 'u', lessons: [{ title: 'l' }] }] }, neu: { name: 'New', pre: 'n', units: [{ title: 'u', lessons: [{ title: 'l', items: [{ t: 'mc', p: 'Q?', o: ['a', 'b'], a: 0 }] }] }] } }, glossary: [{ term: 'x' }] });
    const kept = JSON.stringify(COURSES.frontier.units).length === before, neu = !!COURSES.neu && Array.isArray(COURSES.neu.caveat), gl = GLOSSARY.length > 50;
    delete COURSES.neu; go('course', 'frontier'); go('today'); return { kept, neu, gl }; })()`);
  ok(r.kept && r.neu && r.gl, 'malformed courses and glossary are skipped; a new course gets a caveat', r);
  // A key term marked known after it was learned keeps its review schedule.
  const k = await ev(p, `(() => { const id = 'au0l0#key-' + termSlug('alignment'); state.srs[id] = { s: 2, d: 5, last: dstr(new Date()), due: dstr(new Date()), reps: 1, lapses: 0, ok: 1, at: Date.now() };
    state.keyTerms = { policy: { at: Date.now(), known: ['alignment', 'antitrust'] } };
    const ids = courseCards('policy').map(c => c.id); return { learned: ids.includes(id)&&!isFamiliar(id), skipped: isFamiliar('au0l0#key-' + termSlug('antitrust')) }; })()`);
  ok(k.learned && k.skipped, 'known-but-learned term stays in reviews; known unlearned term is skipped', k);
  // One run counts one practice day.
  const d = await ev(p, `(() => { let calls = 0; const real = bumpStreak; bumpStreak = () => { calls++; }; run = newRun({ mode: 'session', total: 1, queue: [] });
    bumpRunDay(); bumpRunDay(); bumpRunDay(); run = null; bumpStreak = real; return calls; })()`);
  ok(d === 1, 'a run bumps the practice day once', d);
  // Order cards in a session show their label once.
  { const c2 = await ctx(), q = await page(c2); await q.goto(BASE + '/'); await q.click('[data-try="proc"]');
    for (let i = 0; i < 6 && await ev(q, `run && run.cur.t !== 'order'`); i++) await answerOne(q);
    if (await ev(q, `run && run.cur.t === 'order'`)) ok(await ev(q, `document.querySelectorAll('#stage .cardtag').length`) === 1, 'an order card shows its label once');
    await c2.close(); }
  ok(p.errors.length === 0, 'regressions: no page errors', p.errors);
  await c.close();
};

// Keyboard and screen readers: an open overlay takes focus, the page behind is inert, Escape closes sheets.
tests.a11y = async () => {
  const c = await ctx(), p = await page(c);
  await p.goto(BASE + '/'); await p.waitForTimeout(300);
  ok(await ev(p, `document.querySelector('.app').inert && $('#gateIn').contains(document.activeElement)`), 'sign-up screen: page behind is inert and focus is inside');
  await p.click('[data-try="lingo"]'); await p.waitForTimeout(300);
  ok(await ev(p, `document.querySelector('.app').inert && $('#lesson').contains(document.activeElement)`), 'lesson: focus moves into the lesson', await ev(p, 'document.activeElement.outerHTML.slice(0, 80)'));
  ok(await ev(p, `!!document.activeElement.closest('.prompt') || document.activeElement.matches('.prompt')`), 'lesson: the question has focus, so a screen reader reads it');
  await p.keyboard.press('Tab'); ok(await ev(p, `$('#lesson').contains(document.activeElement)`), 'Tab stays inside the lesson');
  await answerOne(p); await p.waitForTimeout(200);
  ok(await ev(p, `$('#lesson').contains(document.activeElement)`), 'next card keeps focus in the lesson');
  await ev(p, 'quitRun(true)'); await p.waitForTimeout(300);
  // Make an account so the app itself is reachable, then open and close a sheet with the keyboard.
  if (await visible(p, '#gtPwOpen')) await p.click('#gtPwOpen');
  await p.fill('#gtName', 'Key ' + rnd()); await p.fill('#gtUser', 'k' + rnd()); await p.fill('#gtPass', 'keyboard ' + rnd());
  await p.click('#gtMake'); await p.waitForSelector('#gate', { state: 'hidden', timeout: 15000 }); await p.waitForTimeout(200);
  ok(await ev(p, `!document.querySelector('.app').inert`), 'with no overlay open the app is not inert');
  await ev(p, `go('me')`); await p.focus('#streakSet'); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
  ok(await visible(p, '#streakSheet') && await ev(p, `$('#streakSheet').contains(document.activeElement)`), 'a sheet opened from the keyboard gets focus');
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  ok(!await visible(p, '#streakSheet') && await ev(p, `document.activeElement && document.activeElement.id === 'streakSet'`), 'Escape closes the sheet and focus returns to its button', await ev(p, 'document.activeElement.id'));
  ok(p.errors.length === 0, 'a11y: no page errors', p.errors);
  await c.close();
};

// ---------- Retention (10/21): sound packs, daily goal, freezes bought with XP, repair, friend streaks, nudges, notifications
tests.retention = async () => {
  const ca = await ctx(); const a = await page(ca); await signUp(a, { name: 'Rae ' + rnd() });
  // Sound packs: Me lists five, picking one saves it and plays without errors (headless audio is silent).
  await ev(a, `go('me')`);
  ok(await ev(a, `document.querySelectorAll('[data-spack]').length`) === 5, 'Me lists five sound packs');
  await a.click('[data-spack="marimba"]'); ok(await ev(a, `state.prefs.soundPack`) === 'marimba', 'sound pack saved');
  ok(await ev(a, `(() => { for (const k of SOUND_PACK_KEYS) for (const [e] of SOUND_EVENTS) sfx(e, k); return true; })()`), 'every sound in every pack plays');
  // Daily goal and buying a freeze with XP; spending doesn't lower the score.
  await ev(a, `state.activeDays = [addDays(dstr(new Date()), -1)]; state.xpBy[DEV] = 250; state.xp = xpTotal(state); save(); renderHome()`);
  await ev(a, `go('me')`);
  await a.click('[data-goal="50"]'); ok(await ev(a, `dailyGoal()`) === 50, 'daily goal set to 50');
  ok(await visible(a, '#buyFreeze'), 'freeze can be bought');
  const f0 = await ev(a, `streakInfo().freezes`);
  await a.click('#buyFreeze');
  ok(await ev(a, `streakInfo().freezes`) === f0 + 1 && await ev(a, `xpSpendable()`) === 150 && await ev(a, `state.xp`) === 250, 'freeze bought: one more freeze, 100 XP spent, total XP unchanged');
  // Earn-back: a 4-day streak that lapsed yesterday comes back when a round is finished today.
  await ev(a, `state.activeDays = [-5, -4, -3, -2].map(n => addDays(dstr(new Date()), n)); state.settings.bought = []; save(); renderHome(); go('today')`);
  ok(await visible(a, '#streakStrip') && /comes back/.test(await a.locator('#streakStrip .repair').innerText().catch(() => '')), 'Today shows the streak strip and the earn-back offer');
  // A finished session celebrates the streak and the daily goal.
  await ev(a, `state.prefs.goal = 20; save()`); await addToMix(a, 'policy'); await ev(a, `go('today')`);
  await clickGo(a, '#todayGo'); for (let i = 0; i < 40 && await answerOne(a); i++);
  await a.waitForSelector('#result', { timeout: 8000 });
  ok(await ev(a, `document.querySelectorAll('#resultIn .cele').length`) >= 1 && /5-day streak/.test(await a.locator('#resultIn').innerText()) && /earned your streak back/.test(await a.locator('#resultIn').innerText()), 'result screen celebrates the earned-back streak', await a.locator('#resultIn').innerText());
  ok(await ev(a, `xpToday()`) > 0, 'XP today is counted', await ev(a, 'state.xpDays'));
  await a.click('#rHome');
  // Group with a friend streak, a nudge and notifications.
  await ev(a, `go('group')`);
  const startBtn = await ev(a, `(() => { const b = [...document.querySelectorAll('#group button')].find(b => /start/i.test(b.textContent)); if (b) b.id = b.id || 'tStart'; return b ? '#' + b.id : null; })()`);
  if (startBtn) await a.click(startBtn);
  if (await visible(a, '#gGroup')) await a.fill('#gGroup', 'Streakers ' + rnd());
  await a.click('#gGo'); await a.waitForFunction(() => G && G.code, null, { timeout: 8000 }).catch(() => {});
  const code = await ev(a, 'G && G.code');
  const cb = await ctx(); const b = await page(cb); await signUp(b, { name: 'Sol ' + rnd() });
  await b.goto(BASE + '/?join=' + code); await b.waitForTimeout(500); await ev(b, `go('group')`);
  if (await visible(b, '#gCode')) { const v = await b.inputValue('#gCode'); if (!v) await b.fill('#gCode', code); }
  await b.click('#gGo'); await b.waitForFunction(() => G && G.code, null, { timeout: 8000 }).catch(() => {});
  await ev(a, 'refreshBoard()'); await a.waitForFunction(() => board && board.players.length === 2, null, { timeout: 8000 }).catch(() => {});
  ok(await visible(a, '.quest'), 'Group shows the weekly group goal');
  ok(await visible(a, '#bellBtn'), 'bell shows for players in a group');
  const bid = await ev(b, 'ACCT.player.id');
  await a.click(`li[data-pid="${bid}"]`); await a.click(`[data-fsreq="${bid}"]`);
  await a.waitForFunction(() => board && board.friends && board.friends.length === 1, null, { timeout: 8000 }).catch(() => {});
  ok(await ev(a, `board.friends[0].status`) === 'pending', 'friend streak requested');
  await ev(b, 'refreshBoard()'); await b.waitForFunction(() => board && board.unseen === 1, null, { timeout: 8000 }).catch(() => {});
  ok(await ev(b, `$('#bellN').textContent`) === '1', 'Sol’s bell shows one new notification', await ev(b, `$('#bellN').textContent`));
  await b.click('#bellBtn'); await b.waitForSelector('#inboxBody .notes', { timeout: 8000 }).catch(() => {});
  ok(/wants to start a friend streak/.test(await b.locator('#inboxBody').innerText()), 'notification lists the request');
  await b.click('#inboxBody [data-fsacc]'); await b.waitForFunction(() => board && board.friends[0] && board.friends[0].status === 'active', null, { timeout: 8000 }).catch(() => {});
  ok(await ev(b, `board.friends[0].status`) === 'active', 'friend streak accepted from the notification');
  await b.click('#inboxSheet [data-close]');
  await ev(b, `go('today')`); ok(/Rae/.test(await b.locator('#streakStrip').innerText()), 'Today lists the friend streak', await b.locator('#streakStrip').innerText());
  await ev(b, `go('today')`);
  const nudge = await ev(b, `!!document.querySelector('#streakStrip [data-nudge]')`);
  ok(!nudge, 'no nudge offered while Sol hasn’t practiced (Rae is done, so it’s Sol’s turn)');
  ok(/Your turn/.test(await b.locator('#streakStrip').innerText()), 'Today says it’s Sol’s turn');
  // Rae nudges Sol from the board.
  await ev(a, 'refreshBoard()'); await a.waitForTimeout(800); await ev(a, `gSel = null; go('group')`);
  await a.click(`li[data-pid="${bid}"]`); await a.click(`.lbact [data-nudge="${bid}"]`); await a.waitForTimeout(1200);
  ok(await ev(a, `nudgedToday('${bid}')`), 'nudge sent and remembered for today');
  await ev(b, 'refreshBoard()'); await b.waitForTimeout(1200);
  ok(await ev(b, 'board.unseen') === 1, 'Sol has the nudge', await ev(b, 'board.unseen'));
  for (const [x, nm] of [[a, 'Rae'], [b, 'Sol']]) { ok(!badText(await x.locator('#home').innerText()), `${nm}: retention text is clean`, badText(await x.locator('#home').innerText())); ok(x.errors.length === 0, `${nm}: retention: no page errors`, x.errors); }
  await ca.close(); await cb.close();
};

tests.tidy = async () => {
  const c = await ctx({storage:{'wl-account':JSON.stringify({token:'x.y',player:{id:'tidy',name:'Tidy'},passkeys:0})}});
  const p = await page(c); await p.goto(BASE + '/');
  for(const [v,name] of await tidyChecks(p)) ok(v, 'tidy: '+name);
  ok(!p.errors.length, 'tidy: no browser errors',p.errors); await c.close();
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
