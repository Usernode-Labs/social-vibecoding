type DevHostWindow = Window & {
  resolveDevHost?: (url: string) => string
}

/**
 * Preserve the legacy LAN-development contract without making React depend on
 * a global implementation. The shared classic script remains authoritative
 * when present; the fallback makes Storybook and isolated route tests behave
 * the same way.
 */
export function resolveDevHost(rawUrl: string) {
  const resolver = (window as DevHostWindow).resolveDevHost
  if (resolver) return resolver(rawUrl)

  try {
    const url = new URL(rawUrl, window.location.origin)
    const localHosts = new Set(["localhost", "127.0.0.1", "::1"])
    if (!localHosts.has(url.hostname) || localHosts.has(window.location.hostname)) {
      return rawUrl
    }
    url.hostname = window.location.hostname
    return url.toString()
  } catch {
    return rawUrl
  }
}
