// 알림 시험 서비스 워커. 알림을 표시하고, 열려 있는 화면에 표시 사실을 알린다.
// 화면이 닫혀 있었다면 다음에 열 때 getNotifications()로 실제 표시 여부를 확인한다.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const key = typeof data.key === 'string' ? data.key : 'unknown';
  event.waitUntil(
    (async () => {
      // tag = 중복 방지 키: 같은 키의 알림은 교체된다
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
  event.waitUntil(self.clients.openWindow('/push-test.html'));
});
