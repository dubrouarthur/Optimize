// Service worker — lets the app load and run with no network.
// Network-first for GETs (fresh when online), cache fallback when offline.
const CACHE = 'plan-de-table-v1';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // never cache mutations
  const url = new URL(req.url);
  if (url.pathname === '/api/events') return;        // don't intercept the SSE stream

  e.respondWith(
    fetch(req)
      .then((res) => {
        // Cache successful same-origin GETs (app shell + /api/state) for offline use
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((m) => m || (req.mode === 'navigate' ? caches.match('/') : undefined))
      )
  );
});
