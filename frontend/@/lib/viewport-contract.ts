const KEYBOARD_THRESHOLD_PX = 120
const UNZOOMED_SCALE_TOLERANCE = 0.01

function obscuredViewportHeight(viewport: VisualViewport | null) {
  if (!viewport) return 0
  if (!window.matchMedia("(pointer: coarse)").matches) return 0
  if (Math.abs(viewport.scale - 1) > UNZOOMED_SCALE_TOLERANCE) return 0
  const inset = window.innerHeight - viewport.height - viewport.offsetTop
  return inset >= KEYBOARD_THRESHOLD_PX ? Math.round(inset) : 0
}

/**
 * `interactive-widget=resizes-content` owns layout resizing. This small state
 * adapter only prevents a second bottom safe-area inset while a software
 * keyboard already occupies the visual viewport.
 */
export function installViewportContract() {
  const root = document.documentElement
  const viewport = window.visualViewport
  let orientationFrame = 0
  const sync = () => {
    const keyboardInset = obscuredViewportHeight(viewport)
    root.style.setProperty("--keyboard-inset-height", `${keyboardInset}px`)
    root.dataset.keyboardVisible = keyboardInset > 0 ? "true" : "false"
  }
  const settleOrientation = () => {
    sync()
    window.cancelAnimationFrame(orientationFrame)
    orientationFrame = window.requestAnimationFrame(sync)
  }

  sync()
  viewport?.addEventListener("resize", sync)
  viewport?.addEventListener("scroll", sync)
  window.addEventListener("resize", sync)
  window.addEventListener("orientationchange", settleOrientation)

  return () => {
    viewport?.removeEventListener("resize", sync)
    viewport?.removeEventListener("scroll", sync)
    window.removeEventListener("resize", sync)
    window.removeEventListener("orientationchange", settleOrientation)
    window.cancelAnimationFrame(orientationFrame)
    delete root.dataset.keyboardVisible
    root.style.removeProperty("--keyboard-inset-height")
  }
}
