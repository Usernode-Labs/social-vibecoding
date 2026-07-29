export type AppRecord = {
  id: string | number
  slug: string
  name: string
  status: "running" | "error" | "awaiting_secrets" | "building" | string
  tagline?: string | null
  description?: string | null
  icon_url?: string | null
  active_users: number
  is_favorited: boolean
  is_collaborator: boolean
  your_apps_hidden: boolean
  favorite_order: number | null
  open_prs: number
  active_sessions: number
  open_issues: number
  missingSecrets?: string[] | null
  can_manage?: boolean
  can_collaborate?: boolean
  locked?: boolean
  url?: string | null
}

export type AppsResponse = { apps: AppRecord[] }
export type FavoriteAppResponse = { ok: true; is_favorited: boolean }
export type AppChangeLockResponse = { ok: true; locked: boolean }
export type AppManifestProposalResponse = { ok: true; sessionId: number | string; prNumber?: number | null; prUrl?: string | null }
export type AppVisibilityProposalResponse = AppManifestProposalResponse & { existing: boolean }
export type AppDetail = AppRecord & {
  /** Public app metadata used only to determine whether app-scoped feedback can be offered. */
  repo_url?: string | null
  url?: string | null
  self_hosted?: boolean
  view_visibility?: "public" | "private"
  lastFailure?: { reason?: string } | null
}

/** A deliberately public, wallet-free contributor record for an app profile. */
export type PublicAppContributor = {
  user_id: number
  username: string
}

export type AppVisibility = "public" | "private"

export type CreateAppInput = {
  name: string
  repoUrl?: string
  collabVisibility: AppVisibility
  viewVisibility: AppVisibility
}

export type VerifyRepoAccess = {
  ok: true
  owner: string
  repo: string
  name?: string
  description?: string
  fullName?: string
}

export type AppSession = {
  id: number
  branch_name: string | null
  pr_title: string | null
  session_title: string | null
  status: string
  warm: boolean
  created_at: string
}

async function requestJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", signal })
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}

async function responseError(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: unknown } | null
  return typeof payload?.error === "string" && payload.error.trim()
    ? payload.error
    : `Request failed (${response.status})`
}

export function listApps(signal?: AbortSignal) {
  return requestJson<AppsResponse>("/api/apps", signal)
}

export function getApp(slug: string, signal?: AbortSignal) {
  return requestJson<{ app: AppDetail }>(`/api/apps/${encodeURIComponent(slug)}`, signal)
}

/**
 * Public app profiles expose their creator, accepted collaborators and merged
 * proposal authors. Private apps intentionally return 404, which callers
 * should treat as an unavailable public roster rather than as an error.
 */
export async function getPublicAppContributors(slug: string, signal?: AbortSignal): Promise<PublicAppContributor[] | null> {
  const response = await fetch(`/api/public/apps/${encodeURIComponent(slug)}/contributors?include_wallets=0`, {
    credentials: "same-origin",
    signal,
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as { contributors?: PublicAppContributor[] }
  return Array.isArray(payload.contributors) ? payload.contributors : []
}

export function getAppSessions(slug: string, signal?: AbortSignal) {
  return requestJson<{ sessions: AppSession[] }>(`/api/apps/${encodeURIComponent(slug)}/sessions`, signal)
}

/**
 * The server validates repository access again on creation. This preflight
 * exists solely to make the imported-app form explain whether the platform
 * bot can actually build the selected repository before a write is attempted.
 */
export async function verifyRepositoryAccess(repoUrl: string, signal?: AbortSignal): Promise<VerifyRepoAccess> {
  const response = await fetch(`/api/github/verify-access?url=${encodeURIComponent(repoUrl)}`, {
    credentials: "same-origin",
    signal,
  })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as VerifyRepoAccess
  if (payload.ok !== true || !payload.owner || !payload.repo) throw new Error("The server did not confirm repository access.")
  return payload
}

/** Existing app-factory contract. The server owns quota, visibility and bot-access checks. */
export async function createApp(input: CreateAppInput): Promise<AppRecord> {
  const response = await fetch("/api/apps", {
    credentials: "same-origin",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as { app?: AppRecord }
  if (!payload.app?.slug) throw new Error("The server did not return the new app.")
  return payload.app
}

/** Retry is intentionally limited to an errored app; the server rechecks manager access and retry caps. */
export async function retryFailedApp(slug: string): Promise<{ ok: true }> {
  const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/retry`, {
    credentials: "same-origin",
    method: "POST",
  })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as { ok?: boolean }
  if (payload.ok !== true) throw new Error("The server did not confirm the retry.")
  return { ok: true }
}

/**
 * Set the desired saved state explicitly. For collaborator apps the server
 * treats `false` as a personal "hide from Your apps" preference, not a
 * removal of collaborator access.
 */
export async function setAppFavorite(slug: string, favorited: boolean): Promise<FavoriteAppResponse> {
  const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/favorite`, {
    credentials: "same-origin",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ favorited }),
  })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as FavoriteAppResponse
  if (payload.ok !== true || typeof payload.is_favorited !== "boolean") {
    throw new Error("The server did not confirm the saved-app update.")
  }
  return payload
}

/**
 * Persist the complete personal order of the visible "Your apps" rail. The
 * endpoint deliberately accepts slugs rather than app ids and silently drops
 * stale or no-longer-visible entries. It can create an ordering row for a
 * collaborator app, but it never changes whether that app is hidden or
 * favourited; `setAppFavorite` remains the sole membership-state operation.
 */
export async function setFavoriteOrder(order: string[]): Promise<{ ok: true }> {
  const response = await fetch("/api/favorites/order", {
    credentials: "same-origin",
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order }),
  })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as { ok?: boolean }
  if (payload.ok !== true) throw new Error("The server did not confirm the app order.")
  return { ok: true }
}

/**
 * The existing full-admin change lock. This does not change an app's
 * lifecycle or visibility; it adds/removes the extra admin-approval
 * requirement before community-approved changes can merge. The server owns
 * the authorization check, system message, and WebSocket fan-out.
 */
export async function setAppChangeLock(slug: string, locked: boolean): Promise<AppChangeLockResponse> {
  const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/lock`, {
    credentials: "same-origin",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ locked }),
  })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as AppChangeLockResponse
  if (payload.ok !== true || typeof payload.locked !== "boolean") {
    throw new Error("The server did not confirm the change-lock update.")
  }
  return payload
}

/**
 * Renames an app by creating the existing GitHub-backed manifest proposal.
 * The visible name does not change optimistically: the returned Dev session
 * enters the normal vote/merge lifecycle and deploy reconciliation applies it.
 */
export async function proposeAppRename(slug: string, newName: string): Promise<AppManifestProposalResponse> {
  const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/rename`, {
    credentials: "same-origin",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newName: newName.trim() }),
  })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as { ok?: boolean; sessionId?: unknown; prNumber?: unknown; prUrl?: unknown }
  if (payload.ok !== true || (typeof payload.sessionId !== "number" && typeof payload.sessionId !== "string")) {
    throw new Error("The server did not return the rename proposal.")
  }
  return {
    ok: true,
    sessionId: payload.sessionId,
    prNumber: typeof payload.prNumber === "number" ? payload.prNumber : null,
    prUrl: typeof payload.prUrl === "string" ? payload.prUrl : null,
  }
}

/**
 * Proposes the existing manifest-backed visibility transition. The app keeps
 * its current access policy until the returned Dev proposal passes, merges,
 * deploys, and server reconciliation applies the new combination.
 *
 * A 409 is not treated as an opaque failure because the server deliberately
 * returns the already-open visibility proposal so the caller can continue its
 * canonical vote lifecycle instead of stacking another PR.
 */
export async function proposeAppVisibility(
  slug: string,
  input: { collabVisibility: AppVisibility; viewVisibility: AppVisibility },
): Promise<AppVisibilityProposalResponse> {
  const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/visibility-pr`, {
    credentials: "same-origin",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  const payload = await response.json().catch(() => null) as {
    ok?: boolean
    error?: unknown
    sessionId?: unknown
    prNumber?: unknown
    prUrl?: unknown
  } | null
  const sessionId = payload?.sessionId
  const hasSession = typeof sessionId === "number" || typeof sessionId === "string"
  if (response.status === 409 && hasSession) {
    return {
      ok: true,
      existing: true,
      sessionId,
      prNumber: typeof payload?.prNumber === "number" ? payload.prNumber : null,
      prUrl: typeof payload?.prUrl === "string" ? payload.prUrl : null,
    }
  }
  if (!response.ok) {
    throw new Error(
      typeof payload?.error === "string" && payload.error.trim()
        ? payload.error
        : `Request failed (${response.status})`,
    )
  }
  if (payload?.ok !== true || !hasSession) {
    throw new Error("The server did not return the visibility proposal.")
  }
  return {
    ok: true,
    existing: false,
    sessionId,
    prNumber: typeof payload.prNumber === "number" ? payload.prNumber : null,
    prUrl: typeof payload.prUrl === "string" ? payload.prUrl : null,
  }
}

/**
 * Start the existing generic Dev session flow. Intentionally send no body:
 * only issue-originated creation supplies `issueNumber`; the server remains
 * authoritative for collaborator access, repository readiness, capacity, and
 * branch creation.
 */
export async function createAppSession(slug: string, issueNumber?: number): Promise<AppSession> {
  const issue = Number.isSafeInteger(issueNumber) && Number(issueNumber) > 0
    ? Number(issueNumber)
    : null
  const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/sessions`, {
    credentials: "same-origin",
    method: "POST",
    ...(issue === null
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ issueNumber: issue }),
        }),
  })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as { session?: AppSession }
  if (!payload.session || !Number.isFinite(payload.session.id)) {
    throw new Error("The server did not return the new Dev session.")
  }
  return payload.session
}

/**
 * The server mints the short-lived identity token used by hosted child apps
 * and staging previews. Keeping it in the app data layer prevents route
 * components from inventing their own fetch/refresh contracts.
 */
export async function getIframeToken(signal?: AbortSignal) {
  const response = await fetch("/api/iframe-token", { credentials: "same-origin", signal })
  if (!response.ok) throw new Error(`Request failed (${response.status})`)
  const payload = await response.json() as { token?: string }
  if (!payload.token) throw new Error("Your app session could not be prepared.")
  return payload.token
}

/**
 * Probe an already-authorized staging host before mounting its iframe. The
 * route owns presentation and cancellation; this adapter owns the network
 * readiness contract so child-app routes do not make ad-hoc cross-origin
 * requests.
 */
export async function waitForHostedTls(stagingUrl: string, options: { alive: () => boolean; resolveHost: (url: string) => string }) {
  const started = Date.now()
  while (options.alive() && Date.now() - started < 180000) {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 8000)
    try {
      await fetch(options.resolveHost(stagingUrl), { cache: "no-store", mode: "no-cors", signal: controller.signal })
      window.clearTimeout(timeout)
      return true
    } catch {
      window.clearTimeout(timeout)
      await new Promise((resolve) => window.setTimeout(resolve, 2500))
    }
  }
  return false
}
