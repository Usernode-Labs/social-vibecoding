import { getNativeBridgeInfo, hasNativeCapability, openNativeExternalUrl, type NativeBridgeInfo } from "@/lib/native-bridge"

export const EXTERNAL_LINK_FAILURE_EVENT = "usernode:external-link-failure"

export type ExternalLinkFailureReason =
  | "native-capability-unavailable"
  | "native-link-unsupported"
  | "native-open-failed"

export type ExternalLinkFailureDetail = {
  reason: ExternalLinkFailureReason
  retry?: () => Promise<boolean>
  url: string
}

let latestFailure: ExternalLinkFailureDetail | null = null

export function getExternalLinkFailure() {
  return latestFailure
}

export function clearExternalLinkFailure(documentRoot: Document = document) {
  latestFailure = null
  delete documentRoot.documentElement.dataset.externalLinkFailure
}

type ExternalLinkMode = "browser" | "native" | "probing" | "unavailable"

type NativeRuntimeWindow = Window & {
  Usernode?: { postMessage?: (message: string) => void }
  usernode?: { isNative?: boolean }
}

function isNativeRuntime() {
  const runtime = window as NativeRuntimeWindow
  return runtime.usernode?.isNative === true || typeof runtime.Usernode?.postMessage === "function"
}

type LinkClassification =
  | { kind: "internal"; url: URL }
  | { kind: "external"; url: URL }
  | { kind: "unsupported-native"; url: string }

function safeFailureUrl(url: URL) {
  if (url.protocol === "http:" || url.protocol === "https:") {
    return `${url.origin}${url.pathname}${url.search}${url.hash}`
  }
  return url.protocol
}

/**
 * Browser mode preserves authored anchor semantics. Native mode has a narrower
 * contract: same-origin navigation stays in the shell, ordinary external
 * HTTP(S) links use `openExternal`, and browsing-context/download/non-web
 * forms are rejected rather than being allowed to replace the trusted frame.
 */
function classifyLink(anchor: HTMLAnchorElement): LinkClassification {
  const target = anchor.target.trim().toLowerCase()
  try {
    const url = new URL(anchor.href, window.location.href)
    if (
      anchor.hasAttribute("download") ||
      (target && target !== "_self" && target !== "_blank") ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return { kind: "unsupported-native", url: safeFailureUrl(url) }
    }
    if (url.origin === window.location.origin) return { kind: "internal", url }
    return { kind: "external", url }
  } catch {
    return { kind: "unsupported-native", url: "" }
  }
}

/**
 * Delegates ordinary top-frame HTTP(S) links only when the synchronous bridge
 * bootstrap says this is a native WebView. Browser mode never prevents the
 * authored activation, so target/download/modifier semantics remain
 * browser-owned. Native and probing modes own primary, modified-primary, and
 * middle-click activation so none can replace or escape the trusted frame.
 *
 * Discovery may take up to the old-build probe timeout. The capture listener
 * is installed before that probe starts so an early native click cannot
 * navigate the trusted WebView. Failed native opens emit one recoverable event
 * instead of relying on an async `window.open`, which no longer has user
 * activation and is commonly blocked in embedded WebViews.
 */
export function installExternalLinkDelegation(documentRoot: Document = document) {
  let active = true
  let bridgeInfo: NativeBridgeInfo | null = null
  let mode: ExternalLinkMode = isNativeRuntime() ? "probing" : "browser"
  let discovery: Promise<NativeBridgeInfo | null> = Promise.resolve(null)

  const setMode = (nextMode: ExternalLinkMode) => {
    mode = nextMode
    documentRoot.documentElement.dataset.externalLinkMode = nextMode
  }

  const discover = async () => {
    const discovered = await getNativeBridgeInfo()
    if (!active) return null
    bridgeInfo = discovered
    setMode(hasNativeCapability(discovered, "openExternal") ? "native" : "unavailable")
    return discovered
  }

  const retry = async (url: URL) => {
    if (!active) return false
    const refreshed = await discover()
    if (!hasNativeCapability(refreshed, "openExternal")) return false
    const opened = await openNativeExternalUrl(refreshed, url.toString())
    if (opened && active) {
      clearExternalLinkFailure(documentRoot)
    }
    return opened
  }

  const reportFailure = (
    url: URL | string,
    reason: ExternalLinkFailureReason,
    retryAction?: () => Promise<boolean>
  ) => {
    if (!active) return
    documentRoot.documentElement.dataset.externalLinkFailure = reason
    latestFailure = {
      reason,
      retry: retryAction,
      url: url.toString(),
    }
    documentRoot.dispatchEvent(new CustomEvent<ExternalLinkFailureDetail>(
      EXTERNAL_LINK_FAILURE_EVENT,
      {
        detail: latestFailure,
      }
    ))
  }

  const openWithNative = async (url: URL, info: NativeBridgeInfo | null) => {
    const opened = await openNativeExternalUrl(info, url.toString())
    if (!active) return
    if (opened) {
      clearExternalLinkFailure(documentRoot)
      return
    }
    reportFailure(url, "native-open-failed", () => retry(url))
  }

  const handleActivation = (event: MouseEvent) => {
    const isPrimaryClick = event.type === "click" && event.button === 0
    const isMiddleClick = event.type === "auxclick" && event.button === 1
    if (event.defaultPrevented || (!isPrimaryClick && !isMiddleClick)) return
    const target = event.target
    const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null
    if (!anchor) return
    if (mode === "browser") return
    const link = classifyLink(anchor)
    if (link.kind === "internal") {
      const requestsAnotherContext = (
        anchor.target.trim().toLowerCase() === "_blank"
        || isMiddleClick
        || event.altKey
        || event.ctrlKey
        || event.metaKey
        || event.shiftKey
      )
      if (!requestsAnotherContext) return
      event.preventDefault()
      event.stopPropagation()
      // Flutter injects the privileged channel only into the trusted top
      // frame. Preserve same-origin navigation while refusing a modifier,
      // middle click, or `_blank` target the chance to create a second
      // browsing context outside that origin boundary.
      window.location.assign(link.url.href)
      return
    }
    if (link.kind === "unsupported-native") {
      event.preventDefault()
      event.stopPropagation()
      reportFailure(link.url, "native-link-unsupported")
      return
    }

    event.preventDefault()
    event.stopPropagation()
    if (mode === "probing") {
      void discovery.then((discovered) => {
        if (!active) return
        if (!hasNativeCapability(discovered, "openExternal")) {
          reportFailure(link.url, "native-capability-unavailable", () => retry(link.url))
          return
        }
        void openWithNative(link.url, discovered)
      })
      return
    }
    if (mode === "unavailable") {
      reportFailure(link.url, "native-capability-unavailable", () => retry(link.url))
      return
    }
    void openWithNative(link.url, bridgeInfo)
  }

  setMode(mode)
  documentRoot.addEventListener("click", handleActivation, true)
  documentRoot.addEventListener("auxclick", handleActivation, true)
  if (mode === "probing") discovery = discover()

  return () => {
    active = false
    bridgeInfo = null
    delete documentRoot.documentElement.dataset.externalLinkMode
    clearExternalLinkFailure(documentRoot)
    documentRoot.removeEventListener("click", handleActivation, true)
    documentRoot.removeEventListener("auxclick", handleActivation, true)
  }
}
