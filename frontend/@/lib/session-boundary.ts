export const SESSION_BOUNDARY_CACHE = "usernode-session-boundary-v1"
export const SESSION_BOUNDARY_PATH = "/__usernode/session-boundary"

function boundaryUrl(origin = window.location.origin) {
  return new URL(SESSION_BOUNDARY_PATH, origin).href
}

async function readStoredEpoch(storage: CacheStorage, origin?: string) {
  const boundary = await storage.open(SESSION_BOUNDARY_CACHE)
  const response = await boundary.match(boundaryUrl(origin))
  const value = Number(response && await response.text())
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/**
 * Advances the origin-wide session boundary before user-scoped cache
 * deletion. The legacy worker stamps API responses with the epoch observed
 * when their request began, so a delayed response from another tab cannot
 * repopulate a cache after logout.
 */
export async function advanceWebSessionEpoch(
  storage: CacheStorage = window.caches,
  origin?: string,
) {
  const boundary = await storage.open(SESSION_BOUNDARY_CACHE)
  const current = await readStoredEpoch(storage, origin)
  const next = Math.max(current + 1, Date.now())
  await boundary.put(
    boundaryUrl(origin),
    new Response(String(next), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain",
      },
    }),
  )
  return next
}
