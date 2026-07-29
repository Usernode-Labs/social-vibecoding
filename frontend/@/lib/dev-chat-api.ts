export type DevSessionMessageRole = "user" | "assistant" | "system" | string

export type DevSessionMessage = {
  id: number
  role: DevSessionMessageRole
  content: string | null
  model: string | null
  token_count: number | null
  cost_cents: number | null
  metadata: Record<string, unknown> | null
  created_at: string
}

export type DevSession = {
  id: number
  app_slug: string
  app_name: string
  branch_name: string | null
  pr_title: string | null
  session_title: string | null
  status: string
  warm?: boolean
  visuals?: DevVisuals | null
  staging_url?: string | null
  /** Owner-controlled visibility for the public shared-session surface. */
  shared_at?: string | null
  testing_md?: string | null
  testing_path?: string | null
  /** Server-owned proposal check verdict; failed/pending states may be re-run by the owner. */
  check_state?: "passing" | "failing" | "pending" | "error" | "skipped" | string | null
  check_error_detail?: string | null
  created_at: string
}

type DevVisualMedia = { png?: string; webm?: string; gif?: string }
type DevVisualCapture = {
  index: number
  path: string
  viewport: "mobile" | string | null
  before: DevVisualMedia | null
  after: DevVisualMedia
  beforeFellBack?: boolean
}

export type DevVisuals = { captures: DevVisualCapture[] }

export type DevSessionResponse = {
  session: DevSession
  messages: DevSessionMessage[]
}

export type SessionSpecVersion = { version: number; built_at?: string | null; commit_sha?: string | null; pr_number?: number | null; shared_to_group_at?: string | null; char_count?: number | null }
export type SessionSpec = { version?: number; content: string; built_at?: string | null; commit_sha?: string | null; pr_number?: number | null; shared_to_group_at?: string | null }
export type ShareSessionSpecToUserResponse = {
  ok: true
  alreadyShared?: boolean
  recipient: { username: string }
}

export type DevAttachment = {
  id: string
  kind: "image" | "text" | "zip" | "binary" | string
  filename: string
  contentType: string
  sizeBytes: number
  meta: Record<string, unknown> | null
}

export type DevSessionStatus = {
  busy: boolean
  phase: "mayor1" | "cc" | "mayor2" | string | null
  progress: Array<{ text?: string } | string>
  estimate: { text?: string; remainingSeconds?: number } | null
  resolving: boolean
  sync: { phase?: string } | null
}

/**
 * The server owns every transition and may reject a stale or unauthorized
 * request. `unarchive` restores the original branch/PR lifecycle rather than
 * creating a local substitute.
 */
export type DevSessionLifecycleAction = "pause" | "resume" | "archive" | "unarchive"

export type DevSessionLifecycleResponse = {
  ok: boolean
  alreadyPaused?: boolean
  keptPromoted?: boolean
  ccPurged?: boolean
  prReopened?: boolean
}

export type StopDevTurnResponse = {
  ok: boolean
  stopped: boolean
  /** Present when no turn is active or the server protects the final wrap-up. */
  reason?: string
}

export type PromoteDevSessionResponse = {
  ok: true
  prNumber: number | null
  prUrl: string | null
  prTitle: string | null
}

export type SetDevSessionVisibilityResponse = {
  ok: true
  shared_at?: string | null
}

export type DevModel = {
  id: string
  label: string
  changeSize?: { short?: string; long?: string } | null
}

async function requestJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", signal })
  if (!response.ok) throw new Error(`Request failed (${response.status})`)
  return response.json() as Promise<T>
}

async function responseError(response: Response) {
  const body = await response.json().catch(() => null) as { error?: string } | null
  return new Error(body?.error || `Request failed (${response.status})`)
}

/** Live POST/SSE handling stays legacy until its resume contract migrates. */
export function getDevSession(sessionId: string, signal?: AbortSignal) {
  return requestJson<DevSessionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}`, signal)
}

/** Owner-only latest spec plus immutable version metadata. Never exposes a write. */
export function getSessionSpec(sessionId: string, signal?: AbortSignal) { return requestJson<{ spec: string; versions: SessionSpecVersion[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/spec`, signal) }
/** Historical content remains subject to the server's owner/share authorization rule. */
export function getSessionSpecVersion(sessionId: string, version: number, signal?: AbortSignal) { return requestJson<{ spec: SessionSpec }>(`/api/sessions/${encodeURIComponent(sessionId)}/specs/${encodeURIComponent(String(version))}`, signal) }

/**
 * Publishes one immutable, owner-authorized version to the app discussion.
 * The server writes the canonical `spec_share` row, stamps the version and
 * broadcasts the complete card metadata.
 */
export async function shareSessionSpecToGroup(sessionId: string, version: number, signal?: AbortSignal) {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/specs/${encodeURIComponent(String(version))}/share`,
    { method: "POST", credentials: "same-origin", signal },
  )
  if (!response.ok) throw await responseError(response)
  return response.json() as Promise<{ ok: true; appSlug: string; messageId: number }>
}

/**
 * Grants one named user access to an immutable version and asks the server to
 * deliver its existing private notification. The endpoint rechecks ownership,
 * recipient existence and private-app collaboration access.
 */
export async function shareSessionSpecToUser(
  sessionId: string,
  version: number,
  username: string,
  signal?: AbortSignal,
) {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/specs/${encodeURIComponent(String(version))}/share-user`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
      signal,
    },
  )
  if (!response.ok) throw await responseError(response)
  return response.json() as Promise<ShareSessionSpecToUserResponse>
}

export function getDevSessionStatus(sessionId: string, signal?: AbortSignal) {
  return requestJson<DevSessionStatus>(`/api/sessions/${encodeURIComponent(sessionId)}/status`, signal)
}

/** The server's allowlist is authoritative for both picker options and turn validation. */
export async function getDevModels(signal?: AbortSignal) {
  const payload = await requestJson<{ models?: DevModel[]; default?: string }>("/api/models", signal)
  const models = (payload.models || []).filter((model) => typeof model?.id === "string" && typeof model?.label === "string")
  if (!models.length) throw new Error("No Dev models are currently available.")
  const defaultModel = models.some((model) => model.id === payload.default) ? payload.default! : models[0].id
  return { defaultModel, models }
}

/**
 * Applies the server-owned reversible session transition. Capacity, ownership,
 * promoted-session handling, worker teardown, and background sync all remain
 * server behavior; the UI only renders the resulting state after a refetch.
 */
export async function changeDevSessionLifecycle(
  sessionId: string,
  action: DevSessionLifecycleAction,
  signal?: AbortSignal,
) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/${action}`, {
    method: "POST",
    credentials: "same-origin",
    signal,
  })
  if (!response.ok) throw await responseError(response)
  return response.json() as Promise<DevSessionLifecycleResponse>
}

/**
 * Requests that the server stop the authenticated owner's currently running
 * turn. The server decides whether a turn exists and refuses the non-stoppable
 * Mayor wrap-up phase, so callers must refresh the canonical session state.
 */
export async function stopDevTurn(sessionId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, {
    method: "POST",
    credentials: "same-origin",
    signal,
  })
  if (!response.ok) throw await responseError(response)
  return response.json() as Promise<StopDevTurnResponse>
}

/**
 * Moves an idle, owner-owned active session into the existing proposal vote
 * lifecycle. The server remains responsible for capacity, lazy PR creation,
 * staging recovery, and the GitHub transition; callers reload its canonical
 * session snapshot after success rather than guessing the resulting state.
 */
export async function promoteDevSession(sessionId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/promote`, {
    method: "POST",
    credentials: "same-origin",
    signal,
  })
  if (!response.ok) throw await responseError(response)
  return response.json() as Promise<PromoteDevSessionResponse>
}

/**
 * Makes an owner session visible to collaborators or returns it to the owner's
 * private Dev workspace. The server owns ownership, eligible lifecycle states,
 * the original shared timestamp, and the board/session-update broadcast.
 * Callers must refetch the canonical session after success rather than
 * guessing visibility locally.
 */
export async function setDevSessionVisibility(sessionId: string, visible: boolean, signal?: AbortSignal) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/${visible ? "share" : "unshare"}`, {
    method: "POST",
    credentials: "same-origin",
    signal,
  })
  if (!response.ok) throw await responseError(response)
  return response.json() as Promise<SetDevSessionVisibilityResponse>
}

export type EnsureStagingResponse = { status: "ready" | "rebuilding" | "unavailable"; url?: string; reason?: string }

export async function ensureDevStaging(sessionId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/ensure-staging`, {
    method: "POST",
    credentials: "same-origin",
    signal,
  })
  if (!response.ok) throw await responseError(response)
  return response.json() as Promise<EnsureStagingResponse>
}

/**
 * Requests the server-owned staging/check pipeline for an owner session. The
 * server coalesces repeated requests, rechecks authorization, and publishes
 * the pending/result state through the existing session event flow.
 */
export async function recheckDevSession(sessionId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/recheck`, {
    method: "POST",
    credentials: "same-origin",
    signal,
  })
  if (!response.ok) throw await responseError(response)
  const payload = await response.json() as { status?: unknown; checkState?: unknown }
  if (payload.status !== "running" || payload.checkState !== "pending") throw new Error("The server did not start the check run.")
  return { status: "running" as const, checkState: "pending" as const }
}

/**
 * Mints the platform's short-lived, server-authorized child-app iframe token.
 * This is deliberately kept in the data layer: presentation routes must not
 * make raw endpoint calls or accidentally grow a second token contract.
 */
/** Uploads raw bytes using the existing server-side classifier and ownership checks. */
export async function uploadDevAttachment(sessionId: string, file: File, signal?: AbortSignal) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/attachments?filename=${encodeURIComponent(file.name)}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
    signal,
  })
  if (!response.ok) throw await responseError(response)
  return response.json() as Promise<DevAttachment>
}

export function devAttachmentUrl(sessionId: string, attachmentId: string) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${attachmentId}`
}

export function createDevSessionEventSource(sessionId: string) {
  return new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events`)
}

/**
 * Starts an existing Dev turn. The owned EventSource adapter is the UI's live
 * source; this request body is deliberately drained so its server SSE remains
 * healthy without recreating a second event protocol in React.
 */
export async function startDevChat(sessionId: string, input: { message: string; attachmentIds: string[]; model: string }, signal?: AbortSignal) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: input.message,
      model: input.model,
      ...(input.attachmentIds.length ? { attachmentIds: input.attachmentIds } : {}),
    }),
    signal,
  })
  if (!response.ok) throw await responseError(response)

  // The response is the legacy primary SSE. Keep it consumed until completion;
  // `useDevSessionStream` receives the identical, resumable event bus feed.
  if (response.body) {
    void response.body.pipeTo(new WritableStream({ write() {} })).catch(() => undefined)
  }
}
