// Sketch Mobile service worker.
//
// Cache-first app shell: after the first load the app (HTML, manifest, icons
// and the JS/CSS assets) works offline. Navigations are network-first so the
// user gets a fresh shell when online, with the cached shell as the offline
// fallback. Provider / API calls are NEVER cached — they always go to the
// network (the agent needs a live provider, and API keys must never sit in a
// cache). Old caches are deleted on activate.

const CACHE_NAME = 'sketch-mobile-v1'

const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

function isApiRequest(request) {
  // Provider calls are cross-origin and/or hit a chat-completions endpoint.
  // Either way they must never be cached or served from cache.
  const url = new URL(request.url)
  return url.origin !== self.location.origin || url.pathname.includes('chat/completions')
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET' || isApiRequest(request)) return

  if (request.mode === 'navigate') {
    // Navigations: network first, cached app shell as the offline fallback.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy))
          return response
        })
        .catch(() => caches.match('/index.html')),
    )
    return
  }

  // Same-origin static assets: cache first, then network (and cache the result).
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
        }
        return response
      })
    }),
  )
})
