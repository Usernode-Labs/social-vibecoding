export type GitHubIssueHeadless = {
  sessionId?: number | string | null
  status?: "generating" | "ready" | "failed" | string | null
  outcome?: "spec" | "code" | "spec_code" | "question" | string | null
  username?: string | null
  mySessionId?: number | string | null
  stagingUrl?: string | null
}

export type GitHubIssueClaim = {
  userId?: number | string | null
  username?: string | null
  mine?: boolean
  claimedAt?: string | null
  expiresAt?: string | null
}

export type GitHubIssue = {
  number: number
  title: string
  body?: string | null
  htmlUrl?: string | null
  user?: string | null
  created_at?: string | null
  updated_at?: string | null
  bounty_count?: number | string | null
  /** Whether the current viewer has already placed their one-way pledge. */
  my_bounty?: boolean
  created_by_username?: string | null
  chatCount?: number | string | null
  headless?: GitHubIssueHeadless | null
  in_progress?: {
    count?: number | string | null
    users?: string[] | null
    mine?: boolean
    claims?: GitHubIssueClaim[] | null
  } | null
  priority?: { top?: string | null } | null
  category?: { top?: string | null } | null
  assignee?: { top?: string | null } | null
}

export type GitHubIssueComment = {
  author?: string | null
  body?: string | null
  createdAt?: string | null
}

export type GitHubIssuesResponse = {
  issues: GitHubIssue[]
  truncatedList?: boolean
  note?: string | null
}

async function requestJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", signal })
  if (!response.ok) throw new Error(`Request failed (${response.status})`)
  return response.json() as Promise<T>
}

async function responseError(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: unknown } | null
  return typeof payload?.error === "string" && payload.error.trim()
    ? payload.error
    : `Request failed (${response.status})`
}

/** Existing view-authorized GitHub issue feed. Mutations use focused adapters below. */
export function getGitHubIssues(slug: string, signal?: AbortSignal) {
  return requestJson<GitHubIssuesResponse>(`/api/apps/${encodeURIComponent(slug)}/github-issues`, signal)
}

/** Existing lazy GitHub-comment reader used by the legacy issue topic. */
export function getGitHubIssueComments(slug: string, issueNumber: number | string, signal?: AbortSignal) {
  return requestJson<{ comments: GitHubIssueComment[]; truncated?: boolean; note?: string | null }>(
    `/api/apps/${encodeURIComponent(slug)}/github-issues/${encodeURIComponent(String(issueNumber))}/comments`,
    signal,
  )
}

/**
 * Author-only server contract. The server verifies collaborator access, the
 * current GitHub issue state, and authorship before it patches GitHub.
 */
export async function renameGitHubIssue(slug: string, issueNumber: number | string, title: string): Promise<{ ok: true; title: string }> {
  const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/github-issues/${encodeURIComponent(String(issueNumber))}/title`, {
    credentials: "same-origin",
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as { ok?: boolean; title?: string }
  if (payload.ok !== true || typeof payload.title !== "string") throw new Error("The server did not confirm the issue title.")
  return { ok: true, title: payload.title }
}

/**
 * Collaborator-owned, platform-local progress mark. The server confirms the
 * issue is still open before creating or renewing only the caller's claim.
 */
export async function claimGitHubIssue(slug: string, issueNumber: number | string) {
  const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/github-issues/${encodeURIComponent(String(issueNumber))}/claim`, {
    credentials: "same-origin",
    method: "POST",
  })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as { ok?: boolean; created?: boolean; claimedAt?: string | null }
  if (payload.ok !== true) throw new Error("The server did not confirm the in-progress mark.")
  return payload
}

/** Clears only the caller's own in-progress claim. */
export async function clearMyGitHubIssueClaim(slug: string, issueNumber: number | string) {
  const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/github-issues/${encodeURIComponent(String(issueNumber))}/claim`, {
    credentials: "same-origin",
    method: "DELETE",
  })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as { ok?: boolean; cleared?: boolean }
  if (payload.ok !== true) throw new Error("The server did not confirm the in-progress mark was cleared.")
  return payload
}

/**
 * Write-admin escape hatch for a stale collaborator claim. The server remains
 * authoritative for both the admin role and the target claim owner.
 */
export async function clearGitHubIssueClaim(slug: string, issueNumber: number | string, userId: number | string) {
  const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/github-issues/${encodeURIComponent(String(issueNumber))}/claim`, {
    credentials: "same-origin",
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as { ok?: boolean; cleared?: boolean }
  if (payload.ok !== true) throw new Error("The server did not confirm the in-progress mark was cleared.")
  return payload
}

/**
 * Places a symbolic, irreversible weekly-kudos pledge on an open GitHub
 * issue. The server verifies current GitHub state, collaborator access, the
 * caller's shared weekly quota, and duplicate pledges before recording it.
 */
export async function giveGitHubIssueBounty(slug: string, issueNumber: number | string): Promise<{ ok: true; bountyCount: number; remaining: number; limit: number }> {
  const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/issues/${encodeURIComponent(String(issueNumber))}/bounty`, {
    credentials: "same-origin",
    method: "POST",
  })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as { ok?: boolean; bountyCount?: unknown; remaining?: unknown; limit?: unknown }
  if (
    payload.ok !== true
    || typeof payload.bountyCount !== "number"
    || typeof payload.remaining !== "number"
    || typeof payload.limit !== "number"
  ) throw new Error("The server did not confirm the kudos pledge.")
  return { ok: true, bountyCount: payload.bountyCount, remaining: payload.remaining, limit: payload.limit }
}

/**
 * Starts the existing unattended issue run. The server selects/validates the
 * requested model, bills the authenticated user, enforces capacity, and
 * creates a headless session without opening a PR or deploy.
 */
export async function startHeadlessGitHubIssueSession(slug: string, issueNumber: number | string, model: string) {
  const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/issues/${encodeURIComponent(String(issueNumber))}/headless-session`, {
    credentials: "same-origin",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as { session?: { id?: unknown } }
  if (!payload.session || (typeof payload.session.id !== "number" && typeof payload.session.id !== "string")) throw new Error("The server did not return the generated proposal session.")
  return { sessionId: payload.session.id }
}

/** Clones a completed shared proposal into the caller's private Dev session. */
export async function cloneHeadlessGitHubIssueSession(headlessSessionId: number | string) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(String(headlessSessionId))}/clone-headless`, {
    credentials: "same-origin",
    method: "POST",
  })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as { session?: { id?: unknown } }
  if (!payload.session || (typeof payload.session.id !== "number" && typeof payload.session.id !== "string")) throw new Error("The server did not return the new Dev session.")
  return { sessionId: payload.session.id }
}

export type TopicAttributeField = "priority" | "assignee" | "category"

export type TopicCategory = {
  value: string
  label: string
  custom?: boolean
}

export type TopicAttributeOptions = {
  field: TopicAttributeField
  options: Array<{ value: string; count: number; mine?: boolean }>
  myValue?: string | null
  categories?: TopicCategory[]
}

async function topicAttributeResponse(response: Response, field: TopicAttributeField) {
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as TopicAttributeOptions
  if (payload.field !== field || !Array.isArray(payload.options)) throw new Error(`The server did not confirm the ${field} vote.`)
  return payload
}

/** View-safe source for a topic's current options and the caller's reversible vote. */
export async function getGitHubIssueAttribute(slug: string, issueNumber: number | string, field: TopicAttributeField, signal?: AbortSignal) {
  const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/topics/issue/${encodeURIComponent(String(issueNumber))}/attributes?field=${field}`, {
    credentials: "same-origin",
    signal,
  })
  return topicAttributeResponse(response, field)
}

/** Collaborators can cast only their own social-signal vote. */
export async function setGitHubIssueAttribute(slug: string, issueNumber: number | string, field: TopicAttributeField, value: string) {
  const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/topics/issue/${encodeURIComponent(String(issueNumber))}/attributes`, {
    credentials: "same-origin",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ field, value }),
  })
  return topicAttributeResponse(response, field)
}

/** Withdraws only the current user's vote for the selected social field. */
export async function clearGitHubIssueAttribute(slug: string, issueNumber: number | string, field: TopicAttributeField) {
  const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/topics/issue/${encodeURIComponent(String(issueNumber))}/attributes?field=${field}`, {
    credentials: "same-origin",
    method: "DELETE",
  })
  return topicAttributeResponse(response, field)
}
