// Offline support: app shell is cached; API reads fall back to the last good response.
const VERSION = 'v7';
const SHELL = `shell-${VERSION}`, DATA = `data-${VERSION}`, VENDOR = 'vendor-v1'; // OCR engine (~15 MB) survives app updates
const SHELL_FILES = ['/', '/app.js', '/crop.js', '/warp.js', '/filters.js', '/vendor.js', '/ocr.js', '/ocr-parse.js', '/style.css', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => ![SHELL, DATA, VENDOR].includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // downloads and admin/backup traffic: never cached, always network
  if (/\/(export\.zip|report\.pdf|report\.csv|items\.csv)$/.test(url.pathname) || url.pathname.startsWith('/api/backup') || url.pathname.startsWith('/api/users') || url.pathname === '/api/ai') return;

  if (url.pathname.startsWith('/api/')) {
    const isPhoto = /\/photos\/\d+$/.test(url.pathname);            // ids are never reused, so these can be cached forever
    e.respondWith(isPhoto ? cacheFirst(req, DATA) : networkFirst(req, DATA));
    return;
  }
  e.respondWith(url.pathname.startsWith('/vendor/') ? cacheFirst(req, VENDOR) : networkFirst(req, SHELL, '/'));
});

async function networkFirst(req, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req)) || (fallbackUrl && (await cache.match(fallbackUrl))) ||
      new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'content-type': 'application/json' } });
  }
}
async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}
