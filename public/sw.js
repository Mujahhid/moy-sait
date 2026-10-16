/* Service worker: офлайн-режим. Книги (PDF) лежат в кэше pdf-v1 и отдаются с поддержкой Range. */
const STATIC = 'static-v1';
const API = 'api-v1';
const PDF = 'pdf-v1';
const KEEP = [STATIC, API, PDF];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(STATIC).then((c) => c.addAll(['/', '/style.css', '/app.js'])).catch(() => {}).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'clear-user') e.waitUntil(caches.delete(API));
});

async function networkFirst(req, cacheName, fallbackKey) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(fallbackKey || req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(fallbackKey || req);
    if (hit) return hit;
    throw err;
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

async function pdfResponse(req) {
  const cache = await caches.open(PDF);
  const hit = await cache.match(req.url);
  if (!hit) return fetch(req);
  const range = req.headers.get('range');
  const blob = await hit.blob();
  const size = blob.size;
  const headers = { 'Content-Type': 'application/pdf', 'Accept-Ranges': 'bytes' };
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m || (m[1] === '' && m[2] === '')) {
    return new Response(blob, { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
  }
  let start;
  let end = size - 1;
  if (m[1] === '') start = Math.max(0, size - Number(m[2]));
  else {
    start = Number(m[1]);
    if (m[2] !== '') end = Math.min(end, Number(m[2]));
  }
  if (start > end || start >= size) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const p = url.pathname;

  if (/^\/api\/books\/\d+\/pdf$/.test(p)) return e.respondWith(pdfResponse(req));
  if (/^\/api\/books\/\d+\/cover$/.test(p)) return e.respondWith(cacheFirst(req, API));
  if (/^\/api\/annotations\//.test(p)) return; // закладки всегда с сервера; офлайн используется копия на устройстве
  if (p.startsWith('/api/')) {
    if (p === '/healthz') return;
    return e.respondWith(networkFirst(req, API));
  }
  if (p.startsWith('/vendor/')) return e.respondWith(cacheFirst(req, STATIC));
  if (req.mode === 'navigate') return e.respondWith(networkFirst(req, STATIC, '/'));
  if (/\.(js|css|svg|png|ico|webmanifest)$/.test(p)) return e.respondWith(networkFirst(req, STATIC));
});
