// Mnesti Service Worker — offline shell cache
const CACHE = 'mnesti-v15';
const SHELL = [
  '/',
  '/index.html',
  '/app.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  // skipWaiting is called unconditionally so it's never blocked by
  // a failed cache.addAll (which would leave the old SW in control)
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

// Allow the page to trigger skipWaiting explicitly
self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept API calls (Anthropic, Supabase) or CDN resources
  if (
    url.hostname.includes('anthropic.com') ||
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('cdn.') ||
    url.hostname.includes('cdnjs.') ||
    url.hostname.includes('fonts.') ||
    url.hostname.includes('jsdelivr') ||
    url.hostname.includes('esm.sh')
  ) {
    return; // pass through, no caching
  }

  // Network-first for navigation — bypass HTTP disk cache so deploys show up immediately
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match('/app.html'))
    );
    return;
  }

  // app.html: network-first; no-store avoids stale shell from browser/CDN HTTP cache
  if (/app\.html$/i.test(url.pathname)) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request).then(m => m || caches.match('/app.html')))
    );
    return;
  }

  // Cache-first for static assets (icons, manifest)
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
