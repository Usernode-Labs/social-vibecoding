import { isAdminPreviewEnabled } from "@/lib/admin-preview"

export type AdminUser = {
  isAdmin?: boolean
  canAdminWrite?: boolean
  role?: "admin" | "view_admin" | "user"
}

export type AdminOverview = {
  stuckApps?: Array<{ slug?: string; dbStatus?: string; createdBy?: string; createdAt?: string }>
  orphanWorkers?: Array<{ name?: string; appSlug?: string; uptimeSeconds?: number; sessionArchived?: boolean }>
  llmToday?: { totalSpendCents?: number; users?: Array<{ username?: string; costCents?: number }> }
}

export type AdminUserRecord = {
  id: number
  username: string
  is_admin?: boolean
  admin_readonly?: boolean
  app_quota?: number | null
  apps_created?: number | null
  daily_limit_cents?: number | null
  usernode_pubkey?: string | null
  activation_code?: string | null
  cost_today_cents?: number | null
  is_self?: boolean
}

export type ActivationCode = {
  id: number
  code: string
  created_at?: string
  used_at?: string | null
  used_by_username?: string | null
}

export type AdminLimits = {
  user_daily_limit_cents?: number
  global_daily_limit_cents?: number
  system_tokens_daily_limit_cents?: number
}

export type SubmittedFeatureStatus = "all" | "open" | "closed" | "completed"

/**
 * Read-only cross-app feature request. The server owns ranking and pagination;
 * this type intentionally does not expose any moderation or status mutation.
 */
export type SubmittedFeature = {
  id: number
  app_id?: number
  app_slug?: string | null
  app_name?: string | null
  title: string
  description?: string | null
  kind?: string
  status?: string
  github_issue_number?: number | null
  created_at?: string | null
  created_by?: number | null
  created_by_username?: string | null
  up_count?: number
  down_count?: number
}

export type SubmittedFeaturesPage = {
  features: SubmittedFeature[]
  total: number
  limit: number
  offset: number
}

export type MergeRunStatus = "running" | "merged" | "blocked" | "conflict_resolving" | "conflict_failed" | "awaiting_github" | "noop" | "error" | "pr_closed"
export type MergeRunKind = "merge" | "conflict_resolution"
export type MergeRun = { id: number; app_id?: number; app_slug?: string | null; app_name?: string | null; session_id?: number | null; pr_number?: number | null; pr_title?: string | null; kind?: MergeRunKind; trigger?: string | null; status?: MergeRunStatus | string; summary?: string | null; started_at?: string | null; ended_at?: string | null; step_count?: number }
export type MergeDebugStep = { id: number; run_id: number; seq: number; phase?: string | null; level?: "info" | "warn" | "error" | string; message?: string | null; detail?: Record<string, unknown> | null; created_at?: string | null }
export type MergeRunsPage = { runs: MergeRun[]; hasMore: boolean; nextCursor: { before: string; before_id: number } | null }
export type MergeDebugApp = { id: number; slug: string; name?: string | null; run_count?: number }

export class AdminAccessError extends Error {
  constructor(public readonly status: number) {
    super(status === 401 ? "Sign in as an admin to view operations." : "Admin access required.")
  }
}

async function request<T>(path: string, options: { body?: unknown; method?: "GET" | "POST" | "PUT" | "DELETE"; signal?: AbortSignal } = {}): Promise<T> {
  if (isAdminPreviewEnabled()) throw new AdminAccessError(403)
  const response = await fetch(path, {
    credentials: "same-origin",
    method: options.method,
    signal: options.signal,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body), headers: { "Content-Type": "application/json" } }),
  })
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new AdminAccessError(response.status)
    const payload = await response.json().catch(() => null) as { error?: unknown } | null
    if (typeof payload?.error === "string") throw new Error(payload.error)
    throw new Error(`Request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}

export async function getAdminUser(signal?: AbortSignal) {
  if (isAdminPreviewEnabled()) throw new AdminAccessError(403)
  const response = await fetch("/api/auth/me", { credentials: "same-origin", signal })
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new AdminAccessError(response.status)
    throw new Error(`Request failed (${response.status})`)
  }
  const payload = await response.json() as { user?: AdminUser }
  if (!payload.user?.isAdmin) throw new AdminAccessError(403)
  return payload.user
}

export function getAdminOverview(signal?: AbortSignal) {
  return request<AdminOverview>("/api/admin/overview", { signal })
}

export function getAdminUsers(signal?: AbortSignal) {
  return request<AdminUserRecord[]>("/api/admin/users", { signal })
}

export function getActivationCodes(signal?: AbortSignal) {
  return request<ActivationCode[]>("/api/admin/codes", { signal })
}

export function createActivationCode() {
  return request<ActivationCode>("/api/admin/codes", { method: "POST" })
}

export function revokeActivationCode(id: number) {
  return request<{ ok: true }>(`/api/admin/codes/${encodeURIComponent(String(id))}`, { method: "DELETE" })
}

export function getAdminLimits(signal?: AbortSignal) {
  return request<AdminLimits>("/api/admin/limits", { signal })
}

export function getSubmittedFeatures(
  status: SubmittedFeatureStatus,
  options: { limit?: number; offset?: number; signal?: AbortSignal } = {},
) {
  const params = new URLSearchParams({ status, limit: String(options.limit ?? 200), offset: String(options.offset ?? 0) })
  return request<SubmittedFeaturesPage>(`/api/admin/submitted-features?${params}`, { signal: options.signal })
}

/** Fetches every existing read-only page for a client-side CSV. */
export async function getAllSubmittedFeatures(status: SubmittedFeatureStatus, signal?: AbortSignal) {
  const limit = 200
  const features: SubmittedFeature[] = []
  let offset = 0
  let total = Infinity
  while (offset < total) {
    const page = await getSubmittedFeatures(status, { limit, offset, signal })
    features.push(...page.features)
    total = page.total
    offset += page.features.length
    if (!page.features.length) break
  }
  return features
}

export function getMergeDebugApps(signal?: AbortSignal) { return request<{ apps: MergeDebugApp[] }>("/api/debug/apps", { signal }) }

export function getMergeRuns(filters: { app?: string; prNumber?: string; sessionId?: string; outcome?: string; kind?: string; before?: string; beforeId?: number; signal?: AbortSignal }) {
  const params = new URLSearchParams({ limit: "30" })
  if (filters.app) params.set("app", filters.app)
  if (filters.prNumber) params.set("pr_number", filters.prNumber)
  if (filters.sessionId) params.set("session_id", filters.sessionId)
  if (filters.outcome) params.set("outcome", filters.outcome)
  if (filters.kind) params.set("kind", filters.kind)
  if (filters.before && filters.beforeId !== undefined) { params.set("before", filters.before); params.set("before_id", String(filters.beforeId)) }
  return request<MergeRunsPage>(`/api/debug/merge-runs?${params}`, { signal: filters.signal })
}

export function getMergeRun(id: number, signal?: AbortSignal) { return request<{ run: MergeRun; steps: MergeDebugStep[] }>(`/api/debug/merge-runs/${encodeURIComponent(String(id))}`, { signal }) }

/** Existing atomic admin endpoint. Values are integer cents by server contract. */
export function updateAdminLimits(limits: { global: number; system: number; user: number }) {
  return request<AdminLimits>("/api/admin/limits", { body: limits, method: "PUT" })
}

export function updateAdminUserQuota(id: number, quota: number) {
  return request<{ ok: true; app_quota: number }>(`/api/admin/users/${encodeURIComponent(String(id))}/app-quota`, { body: { quota }, method: "PUT" })
}

export function updateAdminUserDailyLimit(id: number, cents: number | null) {
  return request<{ ok: true; daily_limit_cents: number | null }>(`/api/admin/users/${encodeURIComponent(String(id))}/daily-limit`, { body: { cents }, method: "PUT" })
}
