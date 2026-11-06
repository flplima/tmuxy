/*
 * tmuxy's service worker: shows the web push notifications the server sends
 * when a pane comes to need the user (tmuxy-server/src/push.rs), and brings
 * the app forward when one is tapped. It intercepts no request — the app is
 * always the live one — and is registered by infra/pushNotifications.ts.
 *
 * Every push is shown: WebKit (Safari, and every iPhone browser) revokes a
 * subscription whose pushes are received and not shown.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let notice = {};
  try {
    notice = event.data ? event.data.json() : {};
  } catch {
    notice = { title: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(notice.title || 'tmuxy', {
      body: notice.body || '',
      // One per pane and state: a newer one replaces it, and still alerts.
      tag: notice.tag,
      renotify: Boolean(notice.tag),
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: notice.url || '/', paneId: notice.paneId || null },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url = '/', paneId = null } = event.notification.data || {};
  const target = new URL(url, self.location.origin);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // A window already on the pane's session takes it to the pane; any
      // other window of the app is moved to that session; none, one opens.
      const same = windows.find((w) => new URL(w.url).search === target.search);
      if (same) {
        await same.focus();
        same.postMessage({ type: 'tmuxy-focus-pane', paneId });
        return;
      }
      const any = windows[0];
      if (any) {
        await any.focus();
        if ('navigate' in any) {
          await any.navigate(target.href);
          return;
        }
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
