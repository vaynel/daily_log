// 푸시 알림 표시와 클릭 시 해당 기록으로 이동. 본문은 서버가 만든 문구만 쓴다.
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { /* 형식 오류는 기본 문구 */ }
  event.waitUntil(self.registration.showNotification(d.title || 'Daily Log', { body: d.body || '', tag: d.tag, data: { url: typeof d.url === 'string' && d.url.startsWith('/') ? d.url : '/' } }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url ? event.notification.data.url : '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('navigate' in c) { await c.navigate(url); return c.focus(); } }
    return self.clients.openWindow(url);
  })());
});
