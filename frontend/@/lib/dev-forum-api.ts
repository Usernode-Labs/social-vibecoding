export type DevProposal = {
  id: number
  pr_number: number | null
  pr_title: string | null
  pr_title_fallback?: string | null
  status: string
  pr_url?: string | null
  pr_summary_md?: string | null
  username?: string | null
  yes_count: number | string
  no_count: number | string
  votes_required?: number | string | null
  chat_count?: number | string | null
  linked_issues?: Array<number | string> | null
  priority?: { top?: string | null } | null
  category?: { top?: string | null } | null
  assignee?: { top?: string | null } | null
  my_vote?: string | null
  /** Count includes direct kudos and any awarded issue bounty credit. */
  kudos_count?: number | string | null
  /** Includes either direct kudos or awarded bounty credit. */
  my_kudos?: boolean
  /** Only direct kudos can be retracted through the kudos endpoint. */
  my_kudos_direct?: boolean
  created_at: string
}

export type DevIssue = {
  id: number
  title: string
  kind: string
  description?: string | null
  created_by_username?: string | null
  status: string
  up_count: number | string
  down_count: number | string
  votes_required?: number | string | null
  chat_count?: number | string | null
  priority?: { top?: string | null } | null
  category?: { top?: string | null } | null
  assignee?: { top?: string | null } | null
  my_vote?: string | null
  created_at: string
  payload?: {
    issueNumber?: number | string | null
    issueTitle?: string | null
    reason?: string | null
  } | null
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

/** Read-only forum data. Voting, merge and moderation stay on their proven routes. */
export function getDevForum(slug: string, signal?: AbortSignal) {
  const safeSlug = encodeURIComponent(slug)
  return Promise.all([
    requestJson<{ promoted: DevProposal[] }>(`/api/apps/${safeSlug}/promoted`, signal),
    requestJson<{ issues: DevIssue[] }>(`/api/apps/${safeSlug}/issues`, signal),
  ]).then(([proposals, issues]) => ({ proposals: proposals.promoted, issues: issues.issues }))
}

/** View-authorized governance feed without the unrelated promoted-PR request. */
export function getOpenGovernanceIssues(slug: string, signal?: AbortSignal) {
  return requestJson<{ issues: DevIssue[] }>(`/api/apps/${encodeURIComponent(slug)}/issues`, signal)
}

/** View-authorized recovery for deep-linking an active or completed proposal. */
export function getDevProposalById(slug: string, proposalId: number | string, signal?: AbortSignal) {
  return requestJson<{ proposal: DevProposal }>(
    `/api/apps/${encodeURIComponent(slug)}/proposals/${encodeURIComponent(String(proposalId))}`,
    signal,
  )
}

/** View-authorized recovery for a governance item no longer in the open feed. */
export function getGovernanceIssueById(slug: string, issueId: number | string, signal?: AbortSignal) {
  return requestJson<{ issue: DevIssue }>(
    `/api/apps/${encodeURIComponent(slug)}/governance/${encodeURIComponent(String(issueId))}`,
    signal,
  )
}

/**
 * Creates the existing vote-only close proposal. This does not close GitHub:
 * the server verifies the target is currently open, deduplicates concurrent
 * proposals, and leaves application to the established governance vote.
 */
export async function createCloseIssueProposal(slug: string, issueNumber: number, reason: string) {
  const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/issues`, {
    credentials: "same-origin",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "close_issue",
      payload: { issueNumber, ...(reason.trim() ? { reason: reason.trim() } : {}) },
    }),
  })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as { issue?: DevIssue }
  if (!payload.issue || typeof payload.issue.id !== "number" || payload.issue.kind !== "close_issue") {
    throw new Error("The server did not confirm the close proposal.")
  }
  return payload.issue
}

/**
 * Cast the authenticated viewer's vote on an open promoted PR. The server is
 * authoritative for the current PR state, electorate, tally, notification
 * side effects, and any resulting background merge.
 */
export async function castProposalVote(sessionId: number, vote: "yes" | "no") {
  const response = await fetch(`/api/sessions/${encodeURIComponent(String(sessionId))}/vote`, {
    credentials: "same-origin",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vote }),
  })
  if (!response.ok) throw new Error(await responseError(response))
  return response.json() as Promise<{ ok: true; merged?: boolean; unchanged?: boolean }>
}

/**
 * Cast the authenticated viewer's vote on an open governance proposal. An
 * up-vote may apply an eligible change server-side, so callers always reload
 * the canonical forum snapshot after success rather than inventing a local
 * status transition.
 */
export async function castGovernanceVote(issueId: number, vote: "up" | "down") {
  const response = await fetch(`/api/issues/${encodeURIComponent(String(issueId))}/vote`, {
    credentials: "same-origin",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vote }),
  })
  if (!response.ok) throw new Error(await responseError(response))
  return response.json() as Promise<{ ok: true; toggled?: boolean; renamed?: { applied?: boolean } | null; secretChanged?: { applied?: boolean } | null; issueClosed?: { applied?: boolean } | null }>
}
