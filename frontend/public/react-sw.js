// React shell service worker. It is deliberately scoped to /react/ while the
// legacy shell remains live at /. The two cache families must never overlap.
//
// This is a shell-only offline strategy: authenticated API responses, iframe
// credentials, event streams, and bridge traffic all remain network-only.
// That is conservative by design; it avoids replaying one user's data into a
// later session while still allowing a warmed React document and its compiled
// assets to recover from a short network interruption.

const SW_VERSION = "v1"
const CACHE_PREFIX = "usernode-react-shell-"
const SHELL_CACHE = `${CACHE_PREFIX}${SW_VERSION}`

const scopeUrl = new URL(self.registration.scope)
const scopePath = scopeUrl.pathname.endsWith("/") ? scopeUrl.pathname : `${scopeUrl.pathname}/`
const shellUrl = scopePath

function isReactAsset(url) {
  return url.origin === self.location.origin
    && url.pathname.startsWith(scopePath)
    && /\.(?:css|js|mjs|map|woff2?|ttf|svg|png|webp|ico)$/i.test(url.pathname)
}

async function networkFirst(request, fallbackKey) {
  const cache = await caches.open(SHELL_CACHE)
  try {
    const response = await fetch(request)
    if (response.ok) await cache.put(fallbackKey ?? request, response.clone())
    return response
  } catch (error) {
    const cached = await cache.match(fallbackKey ?? request, { ignoreSearch: true })
    if (cached) return cached
    throw error
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    // `/react/` is Express's React history fallback and is intentionally the
    // only install-time entry. Vite's content-hashed assets warm on the first
    // successful render, avoiding a hand-maintained and stale asset manifest.
    const cache = await caches.open(SHELL_CACHE)
    await cache.add(shellUrl)
    await self.skipWaiting()
  })())
})

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== SHELL_CACHE)
      .map((name) => caches.delete(name)))
    await self.clients.claim()
  })())
})

self.addEventListener("message", (event) => {
  if (event.data?.type !== "clear-react-shell-cache") return
  event.waitUntil(caches.delete(SHELL_CACHE))
})

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return

  const url = new URL(request.url)
  if (request.mode === "navigate" && url.pathname.startsWith(scopePath)) {
    // Every React history URL resolves to the same document online; use the
    // canonical cache key so an offline deep link can still boot the shell.
    event.respondWith(networkFirst(request, shellUrl))
    return
  }

  if (isReactAsset(url)) event.respondWith(networkFirst(request))
})
