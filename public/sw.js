// Service Worker：把 App 本身快取起來，沒網路也能開
// 策略：先用快取秒開，同時在背景抓新版
// 抓檔案時一律跳過瀏覽器的 HTTP 快取（GitHub Pages 預設會快取 10 分鐘），才拿得到剛上傳的新版
const CACHE = 'fooooood-v9';
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
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  // 同網域（ciaojhen.github.io）還有 CutiCuti 等其他 App，只清掉 FooooooD 自己的舊快取
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('fooooood-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  const fromNetwork = caches.open(CACHE).then((cache) =>
    fetch(e.request.url, { cache: 'no-cache' }).then((res) => {
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
