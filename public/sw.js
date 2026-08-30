// ParkPulse service worker: static assets cache-first, wait times
// network-first with cache fallback so the app still shows the last
// known waits on spotty park connectivity.
const CACHE = 'parkpulse-v127';
const TILES = 'pp-tiles-v1'; // OSM map tiles, capped, survives app-cache bumps
const STATIC_ASSETS = ['/', '/app', '/guide', '/icon.svg', '/manifest.json', '/chat-widget.js', '/i18n.js', '/vendor/leaflet.js', '/vendor/leaflet.css'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== TILES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('push', (e) => {
  let data = { title: 'ParkPulse', body: 'Wait time update' };
  try { data = e.data.json(); } catch {}
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: 'parkpulse-alert',
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const existing = wins.find((w) => new URL(w.url).pathname === '/app');
    return existing ? existing.focus() : clients.openWindow('/app');
  }));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Map tiles: cache-first with a soft cap so revisited park maps work on
  // flaky in-park connections without hoarding storage.
  if (url.hostname === 'tile.openstreetmap.org') {
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) {
        c.put(e.request, res.clone());
        c.keys().then((ks) => { if (ks.length > 400) c.delete(ks[0]); });
      }
      return res;
    }).catch(() => fetch(e.request)));
    return;
  }
  if (url.origin !== location.origin) return;

  if (url.pathname.startsWith('/api/waits/')) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  if (url.pathname.startsWith('/api/')) return; // config/subscribe always live

  // Dictionaries are network-first for the same reason HTML is: they are
  // versioned by deploy, not by URL, so the stale-while-revalidate branch
  // below hands back the previous release's copy and the strings added since
  // stay English for one more visit. The page mirrors the dictionary in
  // localStorage for its instant first paint, so nothing is waiting on this
  // fetch -- it only decides whether the page retexts now or next time.
  if (url.pathname.startsWith('/i18n/')) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // HTML is network-first. It used to fall through to the stale-while-
  // revalidate branch below, which answers from cache and only refreshes
  // afterwards -- so every visit rendered the PREVIOUS deploy's app shell and
  // a fix only appeared on the visit after the one that fetched it. Shipping
  // three fixes in a row that "did nothing" is what this looks like from the
  // outside. Cache is still the offline fallback.
  const wantsHtml = e.request.mode === 'navigate'
    || (e.request.headers.get('accept') || '').includes('text/html');
  if (wantsHtml) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request).then((c) => c || caches.match('/app')))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fresh = fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
