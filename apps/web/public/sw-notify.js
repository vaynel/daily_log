// TASK-6 spike service worker. Shows the notification and reports display back to the page.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const key = data.key || 'unknown';
  event.waitUntil(
    (async () => {
      // tag = dedupe key: a second notification with the same key replaces the first
      await self.registration.showNotification(data.title || 'Daily Log', {
        body: data.body || '',
        tag: key,
        data: { key },
      });
      const clients = await self.clients.matchAll({ includeUncontrolled: true });
      clients.forEach((c) => c.postMessage({ type: 'displayed', key }));
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow('/notify-spike.html'));
});
