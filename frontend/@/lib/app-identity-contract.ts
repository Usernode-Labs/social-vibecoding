export type AppIdentityInput = {
  id: string | number
  slug: string
  name: string
  icon_url?: string | null
}

export const APP_IDENTITY_CONTRACT = "usernode.app-identity" as const
export const APP_IDENTITY_CONTRACT_VERSION = 1 as const
export const APP_IDENTITY_HASH_ALGORITHM = "fnv1a64" as const

type PortableShortcutRuntime = {
  identityKey: (app: AppIdentityInput) => string
  identityHash: (app: AppIdentityInput) => string
  identitySlot: (app: AppIdentityInput) => number
  monogram: (name: string) => string
  serializeIdentity: (app: AppIdentityInput, options?: { origin?: string | URL }) => AppIdentityPayloadV1
}

declare global {
  var UsernodeAppShortcutContract: PortableShortcutRuntime | undefined
}

function runtime() {
  if (!globalThis.UsernodeAppShortcutContract) {
    throw new Error("The portable app shortcut contract runtime was not loaded")
  }
  return globalThis.UsernodeAppShortcutContract
}

export function appIdentityKey(app: AppIdentityInput) {
  return runtime().identityKey(app)
}

export function appMonogram(name: string) {
  return runtime().monogram(name)
}

/** Stable v1 identity hash. It does not change when display artwork or name changes. */
export function appIdentityHash(app: AppIdentityInput) {
  return runtime().identityHash(app)
}

/** Stable v1 mapping from an immutable app identity to one of eight design-system slots. */
export function appIdentitySlot(app: AppIdentityInput) {
  return runtime().identitySlot(app)
}

export type AppIdentityPayloadV1 = {
  contract: typeof APP_IDENTITY_CONTRACT
  contract_version: typeof APP_IDENTITY_CONTRACT_VERSION
  hash_algorithm: typeof APP_IDENTITY_HASH_ALGORITHM
  identity_key: string
  identity_hash: string
  appearance_hash: string
  slot: number
  display_name: string
  monogram: string
  artwork_ref: string | null
}

/**
 * Portable identity data for React and future Android/iOS consumers.
 *
 * `identity_hash` and `slot` remain stable across presentation changes.
 * `appearance_hash` changes when the name, monogram or artwork reference
 * changes, giving native icon stores an explicit cache-invalidation key.
 */
export function serializeAppIdentity(
  app: AppIdentityInput,
  options?: { origin?: string | URL }
): AppIdentityPayloadV1 {
  return runtime().serializeIdentity(app, options)
}
