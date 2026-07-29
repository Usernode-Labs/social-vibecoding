import type { Notification as PlatformNotification } from "@/lib/notifications-api"
import { appDevGitHubIssuePath, appDevSessionPath } from "@/lib/routes"

export type DevConsoleMode = "errors-only" | "always"

const DEV_CONSOLE_MODE_KEY = "usernode:devConsoleMode"
const DEV_ALERTS_KEY = "devchat_alerts_enabled"
export const DEV_CONSOLE_MODE_EVENT = "usernode:dev-console-mode-change"
export const DEV_ALERTS_EVENT = "usernode:dev-alerts-change"
export const DEV_ALERT_TEST_DELAY_MS = 3000
const TONE_DEDUP_MS = 1000

let audioContext: AudioContext | null = null
let lastToneAt = 0

export function readBrowserPreference(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeBrowserPreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function getDevConsoleMode(): DevConsoleMode {
  return readBrowserPreference(DEV_CONSOLE_MODE_KEY) === "always" ? "always" : "errors-only"
}

export function setDevConsoleMode(mode: DevConsoleMode) {
  writeBrowserPreference(DEV_CONSOLE_MODE_KEY, mode)
  window.dispatchEvent(new CustomEvent(DEV_CONSOLE_MODE_EVENT, { detail: { mode } }))
}

export function devAlertsEnabled() {
  return readBrowserPreference(DEV_ALERTS_KEY) !== "0"
}

export function setDevAlertsEnabled(enabled: boolean) {
  writeBrowserPreference(DEV_ALERTS_KEY, enabled ? "1" : "0")
  window.dispatchEvent(new CustomEvent(DEV_ALERTS_EVENT, { detail: { enabled } }))
}

function audioContextConstructor() {
  return window.AudioContext
    || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
}

export function prepareDevAlerts() {
  if (!devAlertsEnabled()) return
  try {
    const Constructor = audioContextConstructor()
    if (!Constructor) return
    audioContext ||= new Constructor()
    if (audioContext.state === "suspended") void audioContext.resume().catch(() => undefined)
  } catch {
    // Audio is best-effort and must never block a Dev action.
  }
}

export function requestDevAlertPermission() {
  try {
    if (!("Notification" in window) || Notification.permission !== "default") return
    void Notification.requestPermission().catch(() => undefined)
  } catch {
    // Notification permission is optional and browser-controlled.
  }
}

function playDoneTone() {
  if (!devAlertsEnabled() || !audioContext || audioContext.state !== "running") return
  const now = Date.now()
  if (now - lastToneAt < TONE_DEDUP_MS) return
  lastToneAt = now
  try {
    const start = audioContext.currentTime
    const partials = [
      { ratio: 1, peak: 0.12, decay: 1.1 },
      { ratio: 2, peak: 0.05, decay: 0.7 },
      { ratio: 3.01, peak: 0.03, decay: 0.5 },
    ]
    for (const partial of partials) {
      const oscillator = audioContext.createOscillator()
      const gain = audioContext.createGain()
      oscillator.type = "sine"
      oscillator.frequency.value = 740 * partial.ratio
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(partial.peak, start + 0.005)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + partial.decay)
      oscillator.connect(gain).connect(audioContext.destination)
      oscillator.start(start)
      oscillator.stop(start + partial.decay + 0.02)
    }
  } catch {
    // A blocked or closing audio context degrades silently.
  }
}

function completionHref(notification: PlatformNotification) {
  if (!notification.appSlug) return null
  if (notification.kind === "session_done" && notification.sessionId) {
    return appDevSessionPath(notification.appSlug, notification.sessionId)
  }
  if (notification.kind === "auto_solve_done" && notification.headlessIssueNumber) {
    return appDevGitHubIssuePath(notification.appSlug, notification.headlessIssueNumber)
  }
  return null
}

function completionCopy(notification: PlatformNotification) {
  if (notification.kind === "auto_solve_done") {
    return {
      title: notification.appName ? `${notification.appName} issue finished` : "Issue work finished",
      body: notification.headlessIssueNumber
        ? `Issue #${notification.headlessIssueNumber} is ready for review.`
        : "Automated issue work is ready for review.",
    }
  }
  return {
    title: notification.appName ? `${notification.appName} Dev session finished` : "Dev session finished",
    body: notification.prTitle || "The coding agent is waiting for your review.",
  }
}

function showSystemNotification(notification: PlatformNotification) {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return
    const copy = completionCopy(notification)
    const browserNotification = new Notification(copy.title, {
      body: copy.body,
      tag: `devchat-${notification.kind}-${notification.sessionId || notification.id}`,
    })
    browserNotification.onclick = () => {
      try {
        window.focus()
        const href = completionHref(notification)
        if (href) window.location.assign(href)
        browserNotification.close()
      } catch {
        // Navigation remains available from the Work surface.
      }
    }
  } catch {
    // Browser notifications are a best-effort enhancement.
  }
}

export function notifyDevCompletion(notification: PlatformNotification) {
  if (!devAlertsEnabled() || notification.readAt) return
  if (notification.kind !== "session_done" && notification.kind !== "auto_solve_done") return
  if (document.visibilityState === "hidden") showSystemNotification(notification)
  else playDoneTone()
}

export function testDevAlert() {
  prepareDevAlerts()
  requestDevAlertPermission()
  window.setTimeout(() => {
    if (document.visibilityState === "hidden") {
      showSystemNotification({
        id: -1,
        kind: "session_done",
        readAt: null,
        appId: null,
        appSlug: null,
        appName: null,
        createdAt: new Date().toISOString(),
      })
    } else {
      playDoneTone()
    }
  }, DEV_ALERT_TEST_DELAY_MS)
  return DEV_ALERT_TEST_DELAY_MS
}
