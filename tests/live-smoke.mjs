// Read-only check of the live site right after a deploy: pages load signed out without errors, and the API, privacy
// page and Apple association file answer. Creates nothing.
// Run: node tests/live-smoke.mjs [https://wonkolingo.alex-l-lintz.workers.dev]
import { chromium } from 'playwright-core';
const SITE = (process.argv[2] || 'https://wonkolingo.alex-l-lintz.workers.dev').replace(/\/$/, '');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const fails = [];
const get = async (path, want) => { const r = await fetch(SITE + path); if (r.status !== 200) fails.push(`${path}: ${r.status}`); const t = await r.text(); if (want && !want.test(t)) fails.push(`${path}: unexpected body`); return t; };
await get('/api/config', /"email"/);
await get('/privacy', /Privacy/);
await get('/.well-known/apple-app-site-association', /webcredentials/);
await get('/course-guide.md', /course/i);
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
for (const r of ['', '#courses', '#me', '#course/policy']) {
  const c = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const p = await c.newPage(); const errs = [];
  p.on('pageerror', e => errs.push(String(e.message)));
  await p.goto(SITE + '/' + r, { waitUntil: 'networkidle' });
  if (errs.length) fails.push(`${r || '/'}: ${errs.join(' | ')}`);
  if (!await p.locator('#gtNew').isVisible()) fails.push(`${r || '/'}: sign-up screen missing`);
  await c.close();
}
await browser.close();
if (fails.length) { console.log('LIVE CHECK FAIL\n  ' + fails.join('\n  ')); process.exit(1); }
console.log('live check ok');
