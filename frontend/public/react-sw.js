// React shell service worker. It is deliberately scoped to /react/ while the
// legacy shell remains live at /. The two cache families must never overlap.
//
// This is a shell-only offline strategy: authenticated API responses, iframe
// credentials, event streams, and bridge traffic all remain network-only.
// That is conservative by design; it avoids replaying one user's data into a
// later session while still allowing a warmed React document and its compiled
// assets to recover from a short network interruption.

const SW_VERSION = "v1"
const BUILD_REVISION = "__USERNODE_REACT_SHELL_BUILD_REVISION__"
const BOOT_ASSETS = __USERNODE_REACT_SHELL_BOOT_ASSETS__
const CACHE_PREFIX = "usernode-react-shell-"
const SHELL_CACHE = `${CACHE_PREFIX}${SW_VERSION}-${BUILD_REVISION}`
let lastSessionClearAt = null

const scopeUrl = new URL(self.registration.scope)
const scopePath = scopeUrl.pathname.endsWith("/") ? scopeUrl.pathname : `${scopeUrl.pathname}/`
const shellUrl = scopePath

function isReactAsset(url) {
  return url.origin === self.location.origin
    && url.pathname.startsWith(scopePath)
    && /\.(?:css|js|mjs|map|woff2?|ttf|svg|png|webp|ico)$/i.test(url.pathname)
}

function isBootAsset(url) {
  return url.origin === self.location.origin
    && BOOT_ASSETS.includes(url.pathname)
}

async function networkFirst(request, fallbackKey) {
  const cache = await caches.open(SHELL_CACHE)
  try {
    const response = await fetch(request)
    if (response.ok) await cache.put(fallbackKey ?? request, response.clone())
    return response
  } catch (error) {
    const key = fallbackKey ?? request
    const cached = await cache.match(key, { ignoreSearch: true })
    if (cached) return cached
    // The newly active worker claims already-open tabs. Their next lazy chunk
    // may still carry the previous deployment's content hash, so consult the
    // one retained predecessor cache before reporting an offline failure.
    if (!fallbackKey) {
      const names = await caches.keys()
      const retained = names
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== SHELL_CACHE)
        .slice(-1)
      for (const name of retained) {
        const prior = await (await caches.open(name)).match(key, { ignoreSearch: true })
        if (prior) return prior
      }
    }
    throw error
  }
}

async function cacheFirstBootAsset(request) {
  const cache = await caches.open(SHELL_CACHE)
  const pathname = new URL(request.url).pathname
  const cached = await cache.match(pathname, { ignoreSearch: true })
  if (cached) return cached
  return networkFirst(request)
}

async function cacheBootAssets() {
  const cache = await caches.open(SHELL_CACHE)
  const requests = BOOT_ASSETS.map((asset) => new Request(asset, {
    cache: "reload",
    credentials: "same-origin",
  }))
  await cache.addAll(requests)
}

async function shellCacheStatus() {
  const cacheNames = await caches.keys()
  const cacheReady = cacheNames.includes(SHELL_CACHE)
  const cache = cacheReady ? await caches.open(SHELL_CACHE) : null
  const missingBootAssets = cache
    ? (await Promise.all(BOOT_ASSETS.map(async (asset) =>
        await cache.match(asset, { ignoreSearch: false }) ? null : asset)))
      .filter(Boolean)
    : BOOT_ASSETS.slice()
  return {
    cacheReady,
    missingBootAssets,
    retainedCaches: cacheNames
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== SHELL_CACHE)
      .slice(-1),
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    // Generated from the one completed Vite artifact. Readiness is withheld
    // unless every compiled JS/CSS/font plus required same-origin bootstrap
    // runtime is present in this exact revision's cache.
    await cacheBootAssets()
    await self.skipWaiting()
  })())
})

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    const prior = names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== SHELL_CACHE)
    const retained = new Set(prior.slice(-1))
    await Promise.all(prior
      .filter((name) => !retained.has(name))
      .map((name) => caches.delete(name)))
    await self.clients.claim()
  })())
})

function reply(event, payload) {
  const port = event.ports?.[0]
  if (port) port.postMessage(payload)
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "get-react-shell-status") {
    event.waitUntil((async () => {
      const cacheStatus = await shellCacheStatus()
      reply(event, {
        ok: true,
        version: SW_VERSION,
        buildRevision: BUILD_REVISION,
        scope: self.registration.scope,
        cacheName: SHELL_CACHE,
        cacheReady: cacheStatus.cacheReady,
        bootAssets: BOOT_ASSETS.slice(),
        bootAssetCount: BOOT_ASSETS.length,
        bootAssetsReady: cacheStatus.cacheReady
          && cacheStatus.missingBootAssets.length === 0,
        missingBootAssets: cacheStatus.missingBootAssets,
        retainedCaches: cacheStatus.retainedCaches,
        lastSessionClearAt,
      })
    })())
    return
  }

  if (event.data?.type !== "clear-react-session-cache") return
  event.waitUntil((async () => {
    // The React worker intentionally stores no authenticated API data. Keep
    // its content-hashed shell assets available after logout; the page clears
    // the legacy worker's per-user API families independently.
    lastSessionClearAt = Math.max(Date.now(), (lastSessionClearAt ?? 0) + 1)
    reply(event, {
      ok: true,
      type: "clear-react-session-cache",
      deleted: [],
      version: SW_VERSION,
      buildRevision: BUILD_REVISION,
      clearedAt: lastSessionClearAt,
    })
  })())
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

  if (isBootAsset(url)) {
    event.respondWith(cacheFirstBootAsset(request))
    return
  }

  if (isReactAsset(url)) {
    event.respondWith(networkFirst(request))
  }
})
