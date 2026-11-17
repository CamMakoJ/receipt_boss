// Offline support: app shell is cached; API reads fall back to the last good response.
const VERSION = 'v1';
const SHELL = `shell-${VERSION}`, DATA = `data-${VERSION}`;
const SHELL_FILES = ['/', '/app.js', '/style.css', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => ![SHELL, DATA].includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (/\/(export\.zip|report\.pdf|report\.csv)$/.test(url.pathname)) return; // downloads: network only

  if (url.pathname.startsWith('/api/')) {
    const isImage = url.pathname.endsWith('/image');
    e.respondWith(isImage ? cacheFirst(req, DATA) : networkFirst(req, DATA));
    return;
  }
  e.respondWith(networkFirst(req, SHELL, '/'));
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
