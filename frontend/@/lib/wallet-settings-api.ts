import { responseError } from "@/lib/settings-api"

export type WalletLinkTransaction = {
  type: "tx"
  to: string
  amount: number | string
  memo: string
  confirmTitle: string
  confirmSubtitle: string
}

export type WalletLinkRequest = {
  qr: WalletLinkTransaction
  expiresAt: string
}

export type WalletLinkStatus = {
  linked: boolean
  pubkey: string | null
}

function requiredText(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Wallet linking returned an invalid ${label}.`)
  }
  return value.trim()
}

export async function startWalletLink(): Promise<WalletLinkRequest> {
  const response = await fetch("/api/me/wallet-link", {
    method: "POST",
    credentials: "same-origin",
  })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as {
    qr?: Record<string, unknown>
    expiresAt?: unknown
  }
  const qr = payload.qr
  if (!qr || qr.type !== "tx" || (typeof qr.amount !== "number" && typeof qr.amount !== "string")) {
    throw new Error("Wallet linking returned an invalid transaction request.")
  }
  const expiresAt = requiredText(payload.expiresAt, "expiry")
  if (!Number.isFinite(Date.parse(expiresAt))) {
    throw new Error("Wallet linking returned an invalid expiry.")
  }
  return {
    expiresAt,
    qr: {
      type: "tx",
      to: requiredText(qr.to, "destination"),
      amount: qr.amount,
      memo: requiredText(qr.memo, "memo"),
      confirmTitle: typeof qr.confirmTitle === "string" && qr.confirmTitle.trim()
        ? qr.confirmTitle.trim()
        : "Link wallet",
      confirmSubtitle: typeof qr.confirmSubtitle === "string" && qr.confirmSubtitle.trim()
        ? qr.confirmSubtitle.trim()
        : "Link your Usernode wallet to this Social Vibecoding account.",
    },
  }
}

export async function getWalletLinkStatus(signal?: AbortSignal): Promise<WalletLinkStatus> {
  const response = await fetch("/api/me/wallet-link/status", {
    credentials: "same-origin",
    signal,
  })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as { linked?: unknown; pubkey?: unknown }
  const pubkey = typeof payload.pubkey === "string" && payload.pubkey.trim()
    ? payload.pubkey.trim()
    : null
  return { linked: payload.linked === true && pubkey !== null, pubkey }
}

export async function requestWalletChallenge(pubkey: string): Promise<string> {
  const response = await fetch("/api/auth/wallet-check", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey }),
  })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as { status?: unknown; challenge?: unknown }
  if (payload.status !== "linked" || typeof payload.challenge !== "string" || !payload.challenge) {
    throw new Error("This wallet is no longer linked to the signed-in account.")
  }
  return payload.challenge
}

export async function changePasswordWithWallet(input: {
  publicKey: string
  challenge: string
  signature: string
  newPassword: string
}) {
  const response = await fetch("/api/me/wallet-change-password", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  if (!response.ok) throw new Error(await responseError(response))
}
