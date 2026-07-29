export type ThemeMode = "light" | "dark"
export type ThemePreference = ThemeMode | "system"

export const THEME_STORAGE_KEY = "theme"
export const THEME_CHANGE_EVENT = "usernode:theme-change"

const darkQuery = "(prefers-color-scheme: dark)"
const themeColors: Record<ThemeMode, string> = {
  light: "#ffffff",
  dark: "#0a0a0a",
}

function isThemeMode(value: string | null): value is ThemeMode {
  return value === "light" || value === "dark"
}

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || isThemeMode(value)
}

export function getStoredThemePreference(): ThemePreference | null {
  if (typeof window === "undefined") return null
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isThemePreference(value) ? value : null
  } catch {
    return null
  }
}

/** Compatibility alias for consumers that only care about an explicit mode. */
export function getStoredThemeMode(): ThemeMode | null {
  const preference = getStoredThemePreference()
  return isThemeMode(preference) ? preference : null
}

export function getSystemThemeMode(): ThemeMode {
  if (typeof window === "undefined") return "light"
  return window.matchMedia(darkQuery).matches ? "dark" : "light"
}

export function getThemeMode(): ThemeMode {
  return resolveThemePreference(getThemePreference())
}

export function getThemePreference(): ThemePreference {
  return getStoredThemePreference() ?? "system"
}

export function resolveThemePreference(preference: ThemePreference): ThemeMode {
  return preference === "system" ? getSystemThemeMode() : preference
}

export function applyThemeMode(mode: ThemeMode) {
  if (typeof document === "undefined") return
  const root = document.documentElement
  root.classList.remove("light", "dark")
  root.classList.add(mode)
  root.dataset.theme = mode
  root.style.colorScheme = mode
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColors[mode])
}

export function setThemeMode(mode: ThemeMode) {
  setThemePreference(mode)
}

export function setThemePreference(preference: ThemePreference) {
  const mode = resolveThemePreference(preference)
  applyThemeMode(mode)
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    // The current document still changes even when persistence is unavailable.
  }
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { mode, preference } }))
}

/**
 * Watches the stored intent as distinct from the resolved light/dark mode.
 * Older event producers that publish only `{ mode }` remain valid: their mode
 * is treated as an explicit preference for subscribers that need one.
 */
export function subscribeThemePreference(listener: (preference: ThemePreference) => void) {
  if (typeof window === "undefined") return () => undefined

  const onThemeChange = (event: Event) => {
    const detail = (event as CustomEvent<{ mode?: string; preference?: string }>).detail
    const preference = detail?.preference ?? null
    const mode = detail?.mode ?? null
    if (isThemePreference(preference)) {
      listener(preference)
      return
    }
    if (isThemeMode(mode)) {
      listener(mode)
      return
    }
    listener(getThemePreference())
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY) return
    listener(isThemePreference(event.newValue) ? event.newValue : "system")
  }

  window.addEventListener(THEME_CHANGE_EVENT, onThemeChange)
  window.addEventListener("storage", onStorage)

  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange)
    window.removeEventListener("storage", onStorage)
  }
}

export function subscribeThemeMode(listener: (mode: ThemeMode) => void) {
  if (typeof window === "undefined") return () => undefined

  const media = window.matchMedia(darkQuery)
  const onThemeChange = (event: Event) => {
    const mode = (event as CustomEvent<{ mode?: string }>).detail?.mode ?? null
    if (isThemeMode(mode)) listener(mode)
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY) return
    const mode = resolveThemePreference(isThemePreference(event.newValue) ? event.newValue : "system")
    applyThemeMode(mode)
    listener(mode)
  }
  const onSystemChange = () => {
    if (getThemePreference() !== "system") return
    const mode = getSystemThemeMode()
    applyThemeMode(mode)
    listener(mode)
  }

  window.addEventListener(THEME_CHANGE_EVENT, onThemeChange)
  window.addEventListener("storage", onStorage)
  media.addEventListener("change", onSystemChange)

  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange)
    window.removeEventListener("storage", onStorage)
    media.removeEventListener("change", onSystemChange)
  }
}
