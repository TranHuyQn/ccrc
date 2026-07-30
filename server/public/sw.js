// CC Notify — service worker for Web Push
'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Trình duyệt chỉ coi trang là "cài đặt được" (PWA) khi service worker có
// handler fetch. Không cache gì — thông báo cũ không còn giá trị.
self.addEventListener('fetch', () => {});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  event.waitUntil(self.registration.showNotification(data.title || 'CC Notify', {
    body: data.body || '',
    tag: data.tag || undefined,
    renotify: true,
  }));
});

// There is nothing to open per notification: the app is a single screen. Focus
// it if it is already running, otherwise open it.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) await wins[0].focus();
    else await self.clients.openWindow('/');
  })());
});
