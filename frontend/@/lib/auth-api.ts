import { maskAdminIdentity } from "@/lib/admin-preview"

export async function loginWithPassword(input: { username: string; password: string }) {
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

async function clearServiceWorkerApiCache() {
  const controller = navigator.serviceWorker?.controller
  if (!controller) return
  await new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, 1000)
    try {
      const channel = new MessageChannel()
      channel.port1.onmessage = () => { window.clearTimeout(timer); resolve() }
      controller.postMessage({ type: "clear-api-cache" }, [channel.port2])
    } catch {
      window.clearTimeout(timer)
      resolve()
    }
  })
}

/**
 * Ends the existing Social Vibecoding web session and clears the per-user API
 * cache before another person can use this browser/WebView profile. This is
 * intentionally separate from the native Usernode wallet logout.
 */
export async function logoutCurrentSession() {
  try {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" })
  } finally {
    await clearServiceWorkerApiCache().catch(() => undefined)
  }
}

/**
 * Creates an account through the established activation-code endpoint. The
 * server remains the source of truth for code validity, username uniqueness,
 * password handling, and the HttpOnly session cookie it issues on success.
 */
export async function registerWithActivationCode(input: { code: string; username: string; password: string }) {
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
