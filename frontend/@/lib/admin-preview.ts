const ADMIN_PREVIEW_KEY = "viewAsNonAdmin"

export function isAdminPreviewEnabled() {
  try {
    return window.localStorage.getItem(ADMIN_PREVIEW_KEY) === "1"
  } catch {
    return false
  }
}

export function setAdminPreviewEnabled(enabled: boolean) {
  try {
    if (enabled) window.localStorage.setItem(ADMIN_PREVIEW_KEY, "1")
    else window.localStorage.removeItem(ADMIN_PREVIEW_KEY)
  } catch {
    // Storage can be unavailable in hardened WebViews. The subsequent reload
    // simply preserves the previous state, which is safer than masking only
    // part of the React tree in memory.
  }
}

export function maskAdminIdentity<T extends {
  isAdmin?: boolean
  canAdminWrite?: boolean
}>(user: T): T {
  if (!isAdminPreviewEnabled()) return user
  return { ...user, isAdmin: false, canAdminWrite: false }
}
