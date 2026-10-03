// SMASH PRO - Service Worker for Web Notifications
// Phien ban: 1.0.0
// Xu ly: Hien thi push notification khi tab bi an, click de focus app

const SW_VERSION = 'smash-pro-sw-v1';

// Cai dat Service Worker
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Kich hoat Service Worker
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Nhan message tu trang chinh de hien thi notification
self.addEventListener('message', (event) => {
  const { type, payload } = event.data || {};

  if (type === 'SHOW_NOTIFICATION') {
    const { title, body, icon, tag, data } = payload || {};
    event.waitUntil(
      self.registration.showNotification(title || 'SMASH PRO', {
        body: body || '',
        icon: icon || '/assets/favicon.png',
        badge: icon || '/assets/favicon.png',
        tag: tag || 'smash-pro-notify',
        data: data || {},
        requireInteraction: false,
        vibrate: [200, 100, 200],
        actions: [
          { action: 'open', title: 'Xem lich dat san' },
          { action: 'dismiss', title: 'Bo qua' }
        ]
      })
    );
  }
});

// Click vao notification -> focus tab hoac mo app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const action = event.action;
  if (action === 'dismiss') return;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('/');
      }
    })
  );
});