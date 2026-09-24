// Service Worker：把 App 本身快取起來，沒網路也能開
// 策略：先用快取秒開，同時在背景抓新版，下次打開就是新版
const CACHE = 'fooooood-v2';
const SHELL = [
  './',
  'index.html',
  'app.js',
  'config.js',
  'vendor/supabase.js',
  'style.css',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  const fromNetwork = caches.open(CACHE).then((cache) =>
    fetch(e.request).then((res) => {
      // 不快取帶參數的網址（例如 Google 登入跳回來的 ?code=...）
      if (res.ok && !new URL(e.request.url).search) cache.put(e.request, res.clone());
      return res;
    }),
  );
  e.waitUntil(fromNetwork.catch(() => {}));
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((cached) => cached || fromNetwork),
  );
});
