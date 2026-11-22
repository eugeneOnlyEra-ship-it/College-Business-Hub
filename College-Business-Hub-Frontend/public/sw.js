/*
 * Offline app shell for Stall mode.
 * The website itself (HTML, scripts, styles, logo) is cached so the app opens with no connection.
 * API calls are never cached here: Stall mode keeps its own copy of the owner's books in IndexedDB,
 * and every other page shows its normal "could not reach the server" message.
 */
const CACHE = 'cbc-shell-v1';
const SHELL = ['/', '/index.html', '/logo.png', '/favicon.png'];

// The page's scripts and styles have hashed names that change with every build, so read them from index.html.
async function cacheShell() {
  const cache = await caches.open(CACHE);
  await cache.addAll(SHELL);
  const html = await (await cache.match('/index.html')).text();
  const assets = [...new Set(html.match(/\/assets\/[^"'\s>]+/g) || [])];
  await cache.addAll(assets);
}

self.addEventListener('install', (event) => {
  event.waitUntil(cacheShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

const isStatic = (url) => url.pathname.startsWith('/assets/') || /\.(png|svg|ico|webp|woff2?)$/.test(url.pathname);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // Fresh page when online, the cached one when not.
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put('/index.html', res.clone()));
          return res;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  if (isStatic(url) && !url.pathname.startsWith('/uploads/')) {
    // Built files have a content hash in their name, so a cached copy is always the right one.
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
            return res;
          }),
      ),
    );
  }
});
