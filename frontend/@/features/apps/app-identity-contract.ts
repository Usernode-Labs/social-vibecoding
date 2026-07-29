export type AppIdentityApp = {
  id: string
  slug: string
  name: string
  icon_url?: string | null
}

const identityNamespace = "usernode:app-identity:v1:"
const identitySlotCount = 8

function identityKey(app: AppIdentityApp) {
  const key = app.id.trim() || app.slug.trim()
  if (!key) throw new Error("AppIdentity requires a non-empty app id or legacy slug")
  return key
}

export function appMonogram(name: string) {
  const value = name.trim()
  if (!value) return "?"
  const segment = new Intl.Segmenter(undefined, { granularity: "grapheme" })
    .segment(value)[Symbol.iterator]().next().value?.segment
  return (segment || "?").toLocaleUpperCase()
}

/** Stable v1 mapping from an immutable app identity to one of eight slots. */
export function appIdentitySlot(app: AppIdentityApp) {
  let hash = 0x811c9dc5
  const bytes = new TextEncoder().encode(`${identityNamespace}${identityKey(app)}`)
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % identitySlotCount + 1
}
