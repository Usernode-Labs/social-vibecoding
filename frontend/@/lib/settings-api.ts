export type WebSettings = {
  username: string | null
  locale: string | null
  aiProgressEstimate: boolean
  hasApiKey: boolean
  keyLast4: string | null
  usernodePubkey: string | null
  walletLinkEnabled: boolean
  isAdmin: boolean
  canAdminWrite: boolean
}

export type AiBudget = {
  spentCents: number
  limitCents: number
  globalSpentCents: number
  globalLimitCents: number
  byokSpentCents: number
  aiEnabled: boolean
}

export type AiGrant = {
  appId: number
  appName: string
  appSlug: string | null
  status: "active" | "revoked"
  dailyCapCents: number
  allowByok: boolean
  spentTodayCents: number
  byokSpentTodayCents: number
}

export type AgentFileKind = "instruction" | "skill"

export type AgentFile = {
  kind: AgentFileKind
  name: string
  description: string
  sizeBytes: number
  updatedAt: string | null
}

export type AgentFileLimits = {
  maxFilesPerKind: number
  maxFileBytes: number
}

export async function responseError(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: unknown } | null
  return typeof payload?.error === "string" && payload.error.trim()
    ? payload.error
    : `Request failed (${response.status})`
}

export async function getWebSettings(signal?: AbortSignal): Promise<WebSettings> {
  const response = await fetch("/api/auth/me", { credentials: "same-origin", signal })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as {
    user?: {
      username?: unknown
      locale?: unknown
      aiProgressEstimate?: unknown
      hasApiKey?: unknown
      keyLast4?: unknown
      usernodePubkey?: unknown
      walletLinkEnabled?: unknown
      isAdmin?: unknown
      canAdminWrite?: unknown
    }
  }
  if (!payload.user) throw new Error("Not authenticated")
  return {
    username: typeof payload.user.username === "string" ? payload.user.username : null,
    locale: typeof payload.user.locale === "string" && payload.user.locale.trim() ? payload.user.locale : null,
    aiProgressEstimate: payload.user.aiProgressEstimate === true,
    hasApiKey: payload.user.hasApiKey === true,
    keyLast4: typeof payload.user.keyLast4 === "string" ? payload.user.keyLast4 : null,
    usernodePubkey: typeof payload.user.usernodePubkey === "string" && payload.user.usernodePubkey.trim()
      ? payload.user.usernodePubkey.trim()
      : null,
    walletLinkEnabled: payload.user.walletLinkEnabled === true,
    isAdmin: payload.user.isAdmin === true,
    canAdminWrite: payload.user.canAdminWrite === true,
  }
}

export async function getAiBudget(signal?: AbortSignal): Promise<AiBudget> {
  const response = await fetch("/api/budget", { credentials: "same-origin", signal })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as Record<string, unknown>
  return {
    spentCents: Number.isFinite(Number(payload.spentCents)) ? Number(payload.spentCents) : 0,
    limitCents: Number.isFinite(Number(payload.limitCents)) ? Number(payload.limitCents) : 0,
    globalSpentCents: Number.isFinite(Number(payload.globalSpentCents)) ? Number(payload.globalSpentCents) : 0,
    globalLimitCents: Number.isFinite(Number(payload.globalLimitCents)) ? Number(payload.globalLimitCents) : 0,
    byokSpentCents: Number.isFinite(Number(payload.byokSpentCents)) ? Number(payload.byokSpentCents) : 0,
    aiEnabled: payload.aiEnabled === true,
  }
}

export async function updateWebLocale(locale: string | null) {
  const response = await fetch("/api/me/locale", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ locale }),
  })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as { locale?: unknown }
  return typeof payload.locale === "string" && payload.locale.trim() ? payload.locale : null
}

export async function updateAiProgressEstimate(enabled: boolean) {
  const response = await fetch("/api/me/ai-progress-estimate", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as { enabled?: unknown }
  return payload.enabled === true
}

export async function saveAnthropicApiKey(key: string) {
  const response = await fetch("/api/me/api-key", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as { keyLast4?: unknown }
  return typeof payload.keyLast4 === "string" && payload.keyLast4
    ? payload.keyLast4
    : key.slice(-4)
}

export async function removeAnthropicApiKey() {
  const response = await fetch("/api/me/api-key", {
    method: "DELETE",
    credentials: "same-origin",
  })
  if (!response.ok) throw new Error(await responseError(response))
}

export async function changeWebPassword(currentPassword: string, newPassword: string) {
  const response = await fetch("/api/me/password", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword }),
  })
  if (!response.ok) throw new Error(await responseError(response))
}

function normalizeGrant(value: unknown): AiGrant | null {
  if (!value || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  const appId = Number(row.appId)
  if (!Number.isInteger(appId)) return null
  return {
    appId,
    appName: typeof row.appName === "string" && row.appName.trim() ? row.appName : `App ${appId}`,
    appSlug: typeof row.appSlug === "string" ? row.appSlug : null,
    status: row.status === "revoked" ? "revoked" : "active",
    dailyCapCents: Number.isFinite(Number(row.dailyCapCents)) ? Number(row.dailyCapCents) : 0,
    allowByok: row.allowByok === true,
    spentTodayCents: Number.isFinite(Number(row.spentTodayCents)) ? Number(row.spentTodayCents) : 0,
    byokSpentTodayCents: Number.isFinite(Number(row.byokSpentTodayCents)) ? Number(row.byokSpentTodayCents) : 0,
  }
}

export async function getAiGrants(signal?: AbortSignal): Promise<AiGrant[]> {
  const response = await fetch("/api/me/llm-grants", { credentials: "same-origin", signal })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as { grants?: unknown }
  return Array.isArray(payload.grants)
    ? payload.grants.map(normalizeGrant).filter((grant): grant is AiGrant => grant !== null)
    : []
}

export async function updateAiGrant(
  appId: number,
  updates: { dailyCapCents?: number; allowByok?: boolean }
) {
  const response = await fetch(`/api/me/llm-grants/${appId}`, {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  })
  if (!response.ok) throw new Error(await responseError(response))
}

export async function revokeAiGrant(appId: number) {
  const response = await fetch(`/api/me/llm-grants/${appId}`, {
    method: "DELETE",
    credentials: "same-origin",
  })
  if (!response.ok) throw new Error(await responseError(response))
}

function normalizeAgentFile(value: unknown): AgentFile | null {
  if (!value || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  if ((row.kind !== "instruction" && row.kind !== "skill") || typeof row.name !== "string") return null
  return {
    kind: row.kind,
    name: row.name,
    description: typeof row.description === "string" ? row.description : "",
    sizeBytes: Number.isFinite(Number(row.size_bytes ?? row.sizeBytes))
      ? Number(row.size_bytes ?? row.sizeBytes)
      : 0,
    updatedAt: typeof (row.updated_at ?? row.updatedAt) === "string"
      ? String(row.updated_at ?? row.updatedAt)
      : null,
  }
}

export async function getAgentFiles(signal?: AbortSignal): Promise<{
  files: AgentFile[]
  limits: AgentFileLimits
}> {
  const response = await fetch("/api/me/agent-files", { credentials: "same-origin", signal })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as {
    files?: unknown
    limits?: { maxFilesPerKind?: unknown; maxFileBytes?: unknown }
  }
  return {
    files: Array.isArray(payload.files)
      ? payload.files.map(normalizeAgentFile).filter((file): file is AgentFile => file !== null)
      : [],
    limits: {
      maxFilesPerKind: Number(payload.limits?.maxFilesPerKind) || 10,
      maxFileBytes: Number(payload.limits?.maxFileBytes) || 48 * 1024,
    },
  }
}

export async function getAgentFileContent(kind: AgentFileKind, name: string) {
  const query = new URLSearchParams({ kind, name })
  const response = await fetch(`/api/me/agent-files/content?${query}`, { credentials: "same-origin" })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as { file?: { content?: unknown } }
  return typeof payload.file?.content === "string" ? payload.file.content : ""
}

export async function saveAgentFile(input: {
  kind: AgentFileKind
  name: string
  description: string
  content: string
}) {
  const response = await fetch("/api/me/agent-files", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  if (!response.ok) throw new Error(await responseError(response))
}

export async function deleteAgentFile(kind: AgentFileKind, name: string) {
  const response = await fetch("/api/me/agent-files", {
    method: "DELETE",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, name }),
  })
  if (!response.ok) throw new Error(await responseError(response))
}
