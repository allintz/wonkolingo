// Move browser-local state to the custom domain by HTTPS POST, never in a URL.
const OLD = 'https://wonkolingo.alex-l-lintz.workers.dev';
const SITE = 'https://wonkolingo.com';
export const MOVE_KEYS = ['hillspeak-v1', 'hillspeak-group', 'wl-account', 'wl-device', 'wl-fz-seen', 'wl-hi5', 'wl-nudged', 'wl-run', 'wl-trial'];
const MAX_BODY = 8 * 1024 * 1024;
const scriptJSON = v => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
function page(script, text = 'Opening WonkoLingo at its new address…') {
  const nonce = crypto.randomUUID();
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Opening WonkoLingo</title><style>body{font:17px/1.5 system-ui;background:#0e141b;color:#f5f0e6;max-width:38em;margin:12vh auto;padding:24px}a{color:#b4cf77}button{font:inherit;padding:10px 18px;margin:8px;border-radius:8px;cursor:pointer}</style></head><body><h1>WonkoLingo</h1><p id="message">${text}</p><div id="choices"></div><p><a href="${SITE}/">Continue to wonkolingo.com</a></p><script nonce="${nonce}">${script}</script></body></html>`, { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'strict-origin', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; form-action ${SITE}; base-uri 'none'; frame-ancestors 'none'`
  }});
}
export async function siteMove(req, env) {
  const url = new URL(req.url);
  if (url.origin === OLD && url.pathname === '/legacy-signin' && req.method === 'GET') {
    // Original-origin Google sign-in and existing passkeys remain available.
    const asset = new URL('/', OLD);
    return env.ASSETS.fetch(new Request(asset, req));
  }
  if (url.origin === SITE && url.pathname === '/site-move') {
    if (req.method !== 'POST') return Response.redirect(SITE + '/', 303);
    const origin = req.headers.get('Origin');
    let referrerOrigin = '';
    try { referrerOrigin = new URL(req.headers.get('Referer') || '').origin; } catch {}
    // Some browsers redact a navigation POST's Origin; require the exact prior-site referrer in that case.
    if (origin !== OLD && !(origin === 'null' && referrerOrigin === OLD)) return new Response('Origin not allowed', {status: 403});
    if (!/^application\/x-www-form-urlencoded\b/i.test(req.headers.get('Content-Type') || '')) return new Response('Send a form', {status: 415});
    if (Number(req.headers.get('Content-Length') || 0) > MAX_BODY) return new Response('Transfer too large', {status: 413});
    let data;
    try {
      const raw = await req.text();
      if (raw.length > MAX_BODY) return new Response('Transfer too large', {status: 413});
      data = JSON.parse(new URLSearchParams(raw).get('data') || '{}');
    } catch { return new Response('Invalid transfer', {status: 400}); }
    if (!data || !data.values || typeof data.values !== 'object') return new Response('Invalid transfer', {status: 400});
    const values = Object.fromEntries(MOVE_KEYS.filter(k => typeof data.values[k] === 'string').map(k => [k, data.values[k]]));
    const search = typeof data.search === 'string' && data.search.startsWith('?') && data.search.length <= 2048 ? data.search : '';
    const hash = typeof data.hash === 'string' && data.hash.startsWith('#') && data.hash.length <= 1024 ? data.hash : '';
    const destination = SITE + '/' + search + hash;
    return page(`(() => {
      const incoming = ${scriptJSON(values)};
      const destination = ${scriptJSON(destination)};
      const parse = raw => { try { return JSON.parse(raw || 'null'); } catch { return null; } };
      const id = account => account && (account.player && account.player.id || (account.token || '').split('.')[0]);
      try {
        const current = parse(localStorage.getItem('wl-account')) || parse(localStorage.getItem('hillspeak-group'));
        const previous = parse(incoming['wl-account']) || parse(incoming['hillspeak-group']);
        const conflict = id(current) && id(previous) && id(current) !== id(previous);
        const apply = replace => {
          const backup = {};
          Object.keys(incoming).forEach(k => { const v = localStorage.getItem(k); if (v !== null) backup[k] = v; });
          if (Object.keys(backup).length) localStorage.setItem('wl-before-site-move', JSON.stringify(backup));
          Object.entries(incoming).forEach(([k, v]) => {
            const existing = localStorage.getItem(k);
            if (!replace && existing !== null) {
              if (k === 'hillspeak-v1') localStorage.setItem('wl-site-move-state', v);
              return;
            }
            localStorage.setItem(k, v);
          });
          location.replace(destination);
        };
        if (!conflict) { apply(false); return; }
        document.getElementById('message').textContent = 'This address is already signed in to a different account. Which account should this browser use?';
        [['Keep the current account', () => location.replace(destination)], ['Move the previous account', () => apply(true)]].forEach(([text, action]) => {
          const button = document.createElement('button'); button.textContent = text; button.onclick = action;
          document.getElementById('choices').appendChild(button);
        });
      } catch {
        document.getElementById('message').textContent = 'Your browser could not save the transfer. Your original progress is still at the previous address. Enable site storage, then reload that address to try again.';
      }
    })();`);
  }
  if (env.REDIRECT_OLD_SITE === 'true' && url.origin === OLD && req.method === 'GET' && ['/privacy', '/privacy.html', '/admin.html', '/course-guide.md'].includes(url.pathname)) {
    return Response.redirect(SITE + url.pathname + url.search, 308);
  }
  if (env.REDIRECT_OLD_SITE === 'true' && url.origin === OLD && (url.pathname === '/' || url.pathname === '/index.html') && req.method === 'GET') {
    return page(`(() => {
      const data = { values: {}, search: location.search, hash: location.hash };
      ${scriptJSON(MOVE_KEYS)}.forEach(k => { try { const v = localStorage.getItem(k); if (v !== null) data.values[k] = v; } catch {} });
      if (!Object.keys(data.values).length) { location.replace(${scriptJSON(SITE)} + '/' + location.search + location.hash); return; }
      const form = document.createElement('form'); form.method = 'POST'; form.action = ${scriptJSON(SITE + '/site-move')};
      const input = document.createElement('input'); input.type = 'hidden'; input.name = 'data'; input.value = JSON.stringify(data);
      form.appendChild(input); document.body.appendChild(form); form.submit();
    })();`);
  }
  return null;
}
