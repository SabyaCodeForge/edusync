/* ==========================================================================
   Tuition Manager — Service Worker
   Provides offline-first caching so the app works with no internet
   connection after the first successful load/install.
   ========================================================================== */

const CACHE_NAME = 'tuition-manager-cache-v2';

// Core app shell files (same-origin) — always cached on install.
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

/* ---------------------------------------------------------------------- */
/* INSTALL — pre-cache the app shell                                      */
/* ---------------------------------------------------------------------- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
    // NOTE: self.skipWaiting() is intentionally NOT called here.
    // A newly installed worker should stay "waiting" until the user taps
    // "Update App" in Settings, which sends a SKIP_WAITING message below.
    // This is what allows the in-app Update button to detect and apply
    // new repository files instead of the SW silently taking over.
  );
});

/* ---------------------------------------------------------------------- */
/* MESSAGE — let the page tell a waiting worker to activate now           */
/* ---------------------------------------------------------------------- */
self.addEventListener('message', (event) => {
  if(event.data && event.data.type === 'SKIP_WAITING'){
    self.skipWaiting();
  }
});

/* ---------------------------------------------------------------------- */
/* ACTIVATE — clean up old cache versions                                 */
/* ---------------------------------------------------------------------- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

/* ---------------------------------------------------------------------- */
/* FETCH — cache-first for app shell, network-first w/ fallback for rest  */
/* ---------------------------------------------------------------------- */
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;

  if (isSameOrigin) {
    // Cache-first strategy for our own app shell files.
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request)
          .then((response) => {
            // Save a copy of newly fetched same-origin assets.
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
            return response;
          })
          .catch(() => caches.match('./index.html'));
      })
    );
  } else {
    // Network-first for external resources (fonts/icons CDN), fall back to cache if offline.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
          return response;
        })
        .catch(() => caches.match(request))
    );
  }
});
