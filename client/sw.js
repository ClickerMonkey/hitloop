// hitl's service worker: it only shows push notifications (the hub sends them, encrypted for this device) and opens
// the page where a tap should go. It caches nothing: the page always comes from the hub.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let m = {};
  try {
    m = e.data ? e.data.json() : {};
  } catch {
    m = { title: 'hitl', body: e.data ? e.data.text() : '' };
  }
  const scope = self.registration.scope;
  e.waitUntil(
    self.registration.showNotification(m.title || 'hitl', {
      body: m.body || '',
      tag: m.tag || undefined,
      renotify: !!m.tag,
      icon: scope + 'assets/icon-192.png',
      badge: scope + 'assets/badge-96.png',
      requireInteraction: !!m.urgent,
      timestamp: Date.now(),
      data: { hash: m.hash || '' },
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const hash = (e.notification.data && e.notification.data.hash) || '';
  const url = self.registration.scope + hash;
  e.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const page = open.find((c) => c.url.startsWith(self.registration.scope));
      if (page) {
        // the open page goes there itself (keeps its state, no reload)
        page.postMessage({ hitl: 'go', hash });
        return page.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
