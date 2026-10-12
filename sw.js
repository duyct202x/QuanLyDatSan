// SMASH PRO - Service Worker
// 1) Hiển thị thông báo do trang gửi (nhắc lịch khi ứng dụng đang mở)
// 2) Nhận THÔNG BÁO ĐẨY từ máy chủ (Firebase Cloud Messaging) và hiện kể cả khi đã đóng ứng dụng

const SW_VERSION = 'smash-pro-sw-v2';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function iconUrl() {
  return new URL('assets/icon-192.png', self.registration.scope).href;
}

// Nội dung tin đẩy: máy chủ gửi dạng dữ liệu {title, body, tag, url}; chấp nhận cả dạng bọc trong data/notification
function parsePush(event) {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch (e) {
    try { p = { body: event.data.text() }; } catch (e2) { p = {}; }
  }
  const d = (p && (p.data || p.notification)) || p || {};
  return {
    title: String(d.title || (p.notification && p.notification.title) || 'SMASH PRO').slice(0, 120),
    body: String(d.body || (p.notification && p.notification.body) || '').slice(0, 300),
    tag: String(d.tag || 'smash-pro-push').slice(0, 100),
    url: String(d.url || '')
  };
}

self.addEventListener('push', (event) => {
  const m = parsePush(event);
  event.waitUntil((async () => {
    // Báo cho các trang đang mở đồng bộ ngay (dữ liệu mới hiện liền)
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach((c) => c.postMessage({ type: 'PUSH_RECEIVED', payload: m }));
    // Luôn hiện thông báo (trình duyệt yêu cầu mỗi tin đẩy phải hiển thị)
    await self.registration.showNotification(m.title, {
      body: m.body, icon: iconUrl(), badge: iconUrl(), tag: m.tag, renotify: false,
      data: { url: m.url }, vibrate: [200, 100, 200]
    });
  })());
});

// Trang gửi lệnh hiển thị thông báo (nhắc lịch khi ứng dụng mở)
self.addEventListener('message', (event) => {
  const { type, payload } = event.data || {};

  if (type === 'SHOW_NOTIFICATION') {
    const { title, body, icon, tag, data } = payload || {};
    event.waitUntil(
      self.registration.showNotification(title || 'SMASH PRO', {
        body: body || '',
        icon: icon || iconUrl(),
        badge: icon || iconUrl(),
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

// Bấm thông báo -> mở/đưa ứng dụng lên trước
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const target = (event.notification.data && event.notification.data.url) || self.registration.scope;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
