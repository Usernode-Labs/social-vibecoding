export type ThemeMode = "light" | "dark"

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

export function getStoredThemeMode(): ThemeMode | null {
  if (typeof window === "undefined") return null
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isThemeMode(value) ? value : null
  } catch {
    return null
  }
}

export function getSystemThemeMode(): ThemeMode {
  if (typeof window === "undefined") return "light"
  return window.matchMedia(darkQuery).matches ? "dark" : "light"
}

export function getThemeMode(): ThemeMode {
  return getStoredThemeMode() ?? getSystemThemeMode()
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
  applyThemeMode(mode)
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode)
  } catch {
    // The current document still changes even when persistence is unavailable.
  }
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { mode } }))
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
    const mode = isThemeMode(event.newValue) ? event.newValue : getSystemThemeMode()
    applyThemeMode(mode)
    listener(mode)
  }
  const onSystemChange = () => {
    if (getStoredThemeMode()) return
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
