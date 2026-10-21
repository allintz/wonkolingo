// Quick check before every deploy: the built page starts cleanly on every route in headless Chrome, with the network
// cut off, so a startup crash (like the 10/20 one that left the site unclickable) can't ship.
// Run: node tests/smoke.mjs [docs/index.html]
import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const page0 = pathToFileURL(resolve(process.argv[2] || 'docs/index.html')).href;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const fails = [];
const routes = ['', '#today', '#courses', '#group', '#me', '#course/lingo', '#course/proc', '#course/frontier', '#course/policy', '#course/tools', '#course/nope', '#junk'];
for (const signedIn of [false, true]) for (const r of routes) {
  const c = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  await c.route(u => !u.href.startsWith('file:'), route => route.abort());
  if (signedIn) await c.addInitScript(() => { localStorage.setItem('wl-account', JSON.stringify({ token: 'x.y', player: { id: 'x', name: 'Smoke' }, passkeys: 0 })); localStorage.setItem('hillspeak-v1', JSON.stringify({ done: { u0l0: true }, srs: {}, mix: { lingo: { on: true, perDay: 5 } }, activeDays: [] })); });
  const p = await c.newPage(); const errs = [];
  p.on('pageerror', e => errs.push(String(e.message)));
  await p.goto(page0 + r); await p.waitForTimeout(250);
  // A view must be showing, and a tab or the sign-up button must take a click.
  const okClick = await p.evaluate(() => { const el = document.querySelector('#gate:not([hidden]) #gtNew') || document.querySelector('#tabs [data-tab="me"]'); if (!el) return false; const b = el.getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!hit && (hit === el || el.contains(hit)); });
  if (errs.length) fails.push(`${signedIn ? 'signed in' : 'signed out'} ${r || '/'}: ${errs.join(' | ')}`);
  if (!okClick) fails.push(`${signedIn ? 'signed in' : 'signed out'} ${r || '/'}: main button can't be clicked`);
  await c.close();
}
await browser.close();
if (fails.length) { console.log('SMOKE FAIL\n  ' + fails.join('\n  ')); process.exit(1); }
console.log(`smoke ok: ${routes.length * 2} starts`);
