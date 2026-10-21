// WonkoLingo service worker: lets the installed app open offline. The page itself is fetched fresh when online
// (so updates show up right away); images and fonts are served from cache. API calls are never cached.
const CACHE = 'wonkolingo-v1';
const CORE = ['./', 'manifest.webmanifest', 'icons/apple-touch-icon.png', 'icons/icon-192.png',
  'mascot/wave.webp', 'mascot/read.webp', 'mascot/think.webp', 'mascot/cheer.webp', 'mascot/skeptic.webp'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(CORE.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.pathname.includes('/api/')) return;
  const isPage = url.origin === location.origin && /\/(index\.html)?$/.test(url.pathname);
  // Other pages (privacy, review) go straight to the network, so they never replace the app's cached copy.
  if (req.mode === 'navigate' && !isPage) return;
  if (isPage) {
    // Network first, so a new version shows up as soon as you're online; cached copy when offline.
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put('./', copy)); return r; })
      .catch(() => caches.match('./').then(r => r || caches.match(req))));
    return;
  }
  // Everything else (images, fonts, guide): cache first, refreshed in the background.
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(r => { if (r.ok || r.type === 'opaque') { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
