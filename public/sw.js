// ParkPulse service worker: static assets cache-first, wait times
// network-first with cache fallback so the app still shows the last
// known waits on spotty park connectivity.
const CACHE = 'parkpulse-v22';
const STATIC_ASSETS = ['/', '/app', '/guide', '/icon.svg', '/manifest.json', '/chat-widget.js'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
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
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

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
