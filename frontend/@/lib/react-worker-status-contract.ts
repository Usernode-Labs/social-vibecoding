export const REACT_SHELL_WORKER_VERSION = "v1" as const
export const REACT_SHELL_CACHE_PREFIX = "usernode-react-shell-" as const

export type ReactShellWorkerStatus = {
  bootAssetCount: number
  bootAssets: string[]
  bootAssetsReady: boolean
  buildRevision: string
  cacheName: string
  cacheReady: boolean
  lastSessionClearAt: number | null
  missingBootAssets: string[]
  ok: true
  retainedCaches: string[]
  scope: string
  version: typeof REACT_SHELL_WORKER_VERSION
}

export type ExpectedReactShellWorker = {
  buildRevision: string
  scope: string
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

export function expectedReactShellCacheName(buildRevision: string) {
  return `${REACT_SHELL_CACHE_PREFIX}${REACT_SHELL_WORKER_VERSION}-${buildRevision}`
}

/**
 * Exact page ↔ worker deployment validation.
 *
 * This intentionally checks the worker's cache inventory, not just whether a
 * cache with the expected name exists. Auth/logout can reuse the same
 * validator when it needs to prove it is talking to the active shell worker.
 */
export function isExpectedReactShellWorkerStatus(
  value: unknown,
  expected: ExpectedReactShellWorker,
): value is ReactShellWorkerStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const status = value as Partial<ReactShellWorkerStatus>
  const expectedCache = expectedReactShellCacheName(expected.buildRevision)
  if (
    status.ok !== true
    || status.version !== REACT_SHELL_WORKER_VERSION
    || status.buildRevision !== expected.buildRevision
    || status.scope !== expected.scope
    || status.cacheName !== expectedCache
    || status.cacheReady !== true
    || status.bootAssetsReady !== true
    || !Number.isInteger(status.bootAssetCount)
    || (status.bootAssetCount ?? 0) <= 0
    || !isStringArray(status.bootAssets)
    || status.bootAssets.length !== status.bootAssetCount
    || new Set(status.bootAssets).size !== status.bootAssets.length
    || !isStringArray(status.missingBootAssets)
    || status.missingBootAssets.length !== 0
    || !isStringArray(status.retainedCaches)
    || status.retainedCaches.length > 1
    || status.retainedCaches.some((name) =>
      !name.startsWith(REACT_SHELL_CACHE_PREFIX) || name === expectedCache)
  ) return false

  const scopePath = new URL(expected.scope).pathname
  return status.bootAssets.includes(scopePath)
}

