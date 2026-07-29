import { maskAdminIdentity } from "@/lib/admin-preview"
import { isExpectedReactShellWorkerStatus } from "@/lib/react-worker-status-contract"
import { advanceWebSessionEpoch } from "@/lib/session-boundary"

const SESSION_CLEANUP_PENDING_KEY = "usernode-session-cleanup-pending-v1"
const SESSION_CLEANUP_STATE_EVENT = "usernode:session-cleanup-state"
let memorySessionCleanupState: "clear" | "pending" | "unknown" = "unknown"

function notifySessionCleanupState() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SESSION_CLEANUP_STATE_EVENT))
  }
}

function sessionCleanupStorage() {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function markSessionCleanupPending() {
  memorySessionCleanupState = "pending"
  try {
    sessionCleanupStorage()?.setItem(SESSION_CLEANUP_PENDING_KEY, String(Date.now()))
  } catch {
    // The in-memory state keeps this document fail-closed when Web Storage is
    // unavailable in a hardened or ephemeral WebView.
  }
  notifySessionCleanupState()
}

function clearSessionCleanupPending() {
  memorySessionCleanupState = "clear"
  try {
    sessionCleanupStorage()?.removeItem(SESSION_CLEANUP_PENDING_KEY)
  } catch {
    // A successful cache cleanup is authoritative for this document even when
    // the browser refuses persistent Web Storage.
  }
  notifySessionCleanupState()
}

export function hasPendingSessionCleanup() {
  if (memorySessionCleanupState === "pending") return true
  const storage = sessionCleanupStorage()
  if (!storage) return memorySessionCleanupState !== "clear"
  try {
    return storage.getItem(SESSION_CLEANUP_PENDING_KEY) !== null
  } catch {
    return memorySessionCleanupState !== "clear"
  }
}

export function subscribeSessionCleanup(listener: () => void) {
  if (typeof window === "undefined") return () => {}
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === SESSION_CLEANUP_PENDING_KEY) listener()
  }
  window.addEventListener("storage", onStorage)
  window.addEventListener(SESSION_CLEANUP_STATE_EVENT, listener)
  return () => {
    window.removeEventListener("storage", onStorage)
    window.removeEventListener(SESSION_CLEANUP_STATE_EVENT, listener)
  }
}

function requireCompletedSessionCleanup() {
  if (hasPendingSessionCleanup()) {
    throw new Error("Finish clearing local session data before signing in again.")
  }
}

export async function loginWithPassword(input: { username: string; password: string }) {
  requireCompletedSessionCleanup()
  const response = await fetch("/api/auth/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  if (response.ok) return
  const result = await response.json().catch(() => null) as { error?: string } | null
  throw new Error(result?.error || "Unable to log in")
}

export type WalletAuthCheck = {
  status: "linked" | "not_linked"
  challenge: string | null
  isGenesis: boolean
}

export type WalletLinkRequest = {
  to: string
  amount: number | string
  memo: string
  expiresAt: string
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

async function authJson(response: Response, fallback: string) {
  const result = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok) throw new Error(text(result?.error) || fallback)
  return result || {}
}

export async function checkWalletAuthentication(pubkey: string): Promise<WalletAuthCheck> {
  const response = await fetch("/api/auth/wallet-check", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey }),
  })
  const result = await authJson(response, "Unable to check this wallet")
  return {
    status: result.status === "linked" ? "linked" : "not_linked",
    challenge: text(result.challenge),
    isGenesis: result.isGenesis === true,
  }
}

export async function loginWithWallet(input: {
  pubkey: string
  publicKey: string
  challenge: string
  signature: string
}) {
  requireCompletedSessionCleanup()
  const response = await fetch("/api/auth/wallet-verify", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  await authJson(response, "Unable to verify this wallet")
}

export async function resetPasswordWithWallet(input: {
  pubkey: string
  publicKey: string
  challenge: string
  signature: string
  newPassword: string
}) {
  const response = await fetch("/api/auth/wallet-reset-verify", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  await authJson(response, "Unable to reset the password")
}

function normalizeWalletLink(value: unknown): WalletLinkRequest | null {
  if (!value || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  const to = text(row.to)
  const memo = text(row.memo)
  const expiresAt = text(row.expiresAt)
  if (!to || !memo || !expiresAt || (typeof row.amount !== "number" && typeof row.amount !== "string")) return null
  return { to, amount: row.amount, memo, expiresAt }
}

async function walletAccountRequest(
  path: "/api/auth/wallet-link-login" | "/api/auth/wallet-register",
  input: { username: string; password: string; pubkey: string }
) {
  requireCompletedSessionCleanup()
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  const result = await authJson(response, path.endsWith("register") ? "Unable to create the account" : "Unable to link the account")
  return normalizeWalletLink(result.walletLink)
}

export function linkWalletDuringLogin(input: { username: string; password: string; pubkey: string }) {
  return walletAccountRequest("/api/auth/wallet-link-login", input)
}

export function registerWithWallet(input: { username: string; password: string; pubkey: string }) {
  return walletAccountRequest("/api/auth/wallet-register", input)
}

function logoutCacheMessage(controller: ServiceWorker) {
  const path = new URL(controller.scriptURL, window.location.origin).pathname
  return path.endsWith("/react-sw.js") ? "clear-react-session-cache" : "clear-api-cache"
}

type ReactSessionClearReply = {
  buildRevision: string
  clearedAt: number
  ok: true
  type: "clear-react-session-cache"
  version: string
}

function postServiceWorkerMessage(controller: ServiceWorker, type: string) {
  return new Promise<unknown>((resolve, reject) => {
    const channel = new MessageChannel()
    const timer = window.setTimeout(
      () => reject(new Error("The offline session cache did not acknowledge cleanup.")),
      3000,
    )
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timer)
      resolve(event.data)
    }
    try {
      controller.postMessage({ type }, [channel.port2])
    } catch (error) {
      window.clearTimeout(timer)
      reject(error)
    }
  })
}

function validReactClearReply(value: unknown): value is ReactSessionClearReply {
  if (!value || typeof value !== "object") return false
  const reply = value as Record<string, unknown>
  return reply.ok === true
    && reply.type === "clear-react-session-cache"
    && typeof reply.version === "string"
    && typeof reply.buildRevision === "string"
    && typeof reply.clearedAt === "number"
}

async function clearCurrentServiceWorkerCache(expectedEpoch: number) {
  const controller = navigator.serviceWorker?.controller
  // An uncontrolled first load has no worker-owned authenticated cache to
  // acknowledge. Direct CacheStorage deletion below remains authoritative.
  if (!controller) return
  const message = logoutCacheMessage(controller)
  const reply = await postServiceWorkerMessage(controller, message)
  if (message === "clear-react-session-cache") {
    if (!validReactClearReply(reply)) {
      throw new Error("The offline session cache returned an invalid cleanup acknowledgment.")
    }
    const status = await postServiceWorkerMessage(controller, "get-react-shell-status")
    const expectedWorker = {
      buildRevision: import.meta.env.VITE_REACT_SHELL_REVISION,
      scope: new URL(import.meta.env.BASE_URL, window.location.origin).href,
    }
    if (
      !isExpectedReactShellWorkerStatus(status, expectedWorker)
      || status.buildRevision !== reply.buildRevision
      || status.version !== reply.version
      || status.lastSessionClearAt !== reply.clearedAt
    ) {
      throw new Error("The offline session cache did not confirm the cleanup transition.")
    }
    return
  }
  const row = reply && typeof reply === "object" ? reply as Record<string, unknown> : null
  if (
    row?.done !== true
    || typeof row.epoch !== "number"
    || !Number.isSafeInteger(row.epoch)
    || row.epoch < expectedEpoch
  ) {
    throw new Error("The legacy offline cache returned an invalid cleanup acknowledgment.")
  }
}

async function clearLegacyApiCaches() {
  if (!("caches" in window)) return
  const names = await window.caches.keys()
  const userCaches = names.filter((name) => name.startsWith("usernode-api-"))
  const deleted = await Promise.all(userCaches.map((name) => window.caches.delete(name)))
  const failed = userCaches.filter((_, index) => !deleted[index])
  const remaining = (await window.caches.keys()).filter((name) => name.startsWith("usernode-api-"))
  if (failed.length || remaining.length) {
    throw new Error("Cached session data could not be cleared from this browser.")
  }
}

async function clearServiceWorkerSessionCache() {
  // A /react/ client is controlled by the React-scoped worker, so the root
  // worker never observes its logout POST. Advance the shared epoch before
  // deletion so a delayed response in any legacy tab is ineligible to write
  // after the boundary, then clear every legacy per-user cache family.
  const epoch = await advanceWebSessionEpoch()
  await Promise.all([
    clearLegacyApiCaches(),
    clearCurrentServiceWorkerCache(epoch),
  ])
}

export async function retryPendingSessionCleanup() {
  await clearServiceWorkerSessionCache()
  clearSessionCleanupPending()
}

export type LogoutResult = {
  cleanup: "complete" | "pending"
  sessionEnded: true
}

/**
 * Ends the existing Social Vibecoding web session and clears the per-user API
 * cache before another person can use this browser/WebView profile. This is
 * intentionally separate from the native Usernode wallet logout.
 */
export async function logoutCurrentSession(): Promise<LogoutResult> {
  let requestFailure: unknown = null
  try {
    const response = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" })
    if (!response.ok) throw new Error(`Logout failed (${response.status})`)
  } catch (error) {
    requestFailure = error
  }

  let cleanupFailure: unknown = null
  try {
    await clearServiceWorkerSessionCache()
    clearSessionCleanupPending()
  } catch (error) {
    cleanupFailure = error
    markSessionCleanupPending()
  }

  if (requestFailure && cleanupFailure) {
    throw new AggregateError(
      [requestFailure, cleanupFailure],
      "The web session ended with request and offline-cache cleanup failures.",
    )
  }
  if (requestFailure) throw requestFailure
  if (cleanupFailure) return { cleanup: "pending", sessionEnded: true }
  return { cleanup: "complete", sessionEnded: true }
}

/**
 * Creates an account through the established activation-code endpoint. The
 * server remains the source of truth for code validity, username uniqueness,
 * password handling, and the HttpOnly session cookie it issues on success.
 */
export async function registerWithActivationCode(input: { code: string; username: string; password: string }) {
  requireCompletedSessionCleanup()
  const response = await fetch("/api/auth/register", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  if (response.ok) return
  const result = await response.json().catch(() => null) as { error?: string } | null
  throw new Error(result?.error || "Unable to register")
}

export type CurrentUser = {
  id?: number
  username?: string
  canCreateApps?: boolean
  canAdminWrite?: boolean
  isAdmin?: boolean
}

/** The existing auth session is the authority for whether creation is offered. */
export async function getCurrentUser(signal?: AbortSignal): Promise<CurrentUser> {
  const response = await fetch("/api/auth/me", { credentials: "same-origin", signal })
  if (!response.ok) throw new Error(response.status === 401 ? "Sign in to create an app." : `Request failed (${response.status})`)
  const payload = await response.json() as { user?: CurrentUser }
  if (!payload.user) throw new Error("Sign in to create an app.")
  return maskAdminIdentity(payload.user)
}
