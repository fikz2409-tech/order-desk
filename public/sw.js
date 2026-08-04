// Minimal service worker for Order Desk.
//
// This app's core value is showing *current* order data — a cached,
// possibly-stale order list is actively misleading for an operations
// tool (e.g. showing "Pending" for something already marked Paid).
// So this service worker intentionally does NOT cache API responses
// or the app shell for offline use. Its only job is to exist, which
// satisfies the installability requirement on Android/Chrome for
// "Add to Home Screen" to offer a real app-like install.
//
// If offline support is wanted later, add a cache-first strategy here
// for static assets (CSS/icons) only — never for /api/ requests.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Pass everything straight through to the network — no caching.
  event.respondWith(fetch(event.request));
});
