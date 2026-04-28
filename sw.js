// Mnesti Service Worker — offline shell cache
const CACHE = 'mnesti-v7';
const SHELL = [
  '/smart-student/',
  '/smart-student/index.html',
  '/smart-student/manifest.json',
  '/smart-student/icon-192.png',
  '/smart-student/icon-512.png',
  '/smart-student/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
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

  // Network-first for navigation (always get latest app shell)
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match('/smart-student/index.html'))
    );
    return;
  }

  // Cache-first for static assets (icons, manifest)
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
