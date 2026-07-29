export type LeaderboardWindow = "all" | "week"
export type HistoryType = "all" | "kudos" | "votes"

export type LeaderboardPr = {
  session_id: number
  pr_number: number | null
  pr_url: string | null
  pr_title: string | null
  status: string
  author_username: string | null
  app_slug: string
  app_name: string
  kudos_count: number
}

export type LeaderboardUser = {
  username: string
  kudos_received_prs_merged: number
  kudos_received: number
  prs_merged: number
  prs_kudosed?: number
  kudos_received_prs_unmerged?: number
  issues_created?: number
  active_apps?: Array<{ slug: string; name: string }>
}

type LeaderboardResponse<T> = { items: T[]; window: LeaderboardWindow; weekStart: string | null }

export type LeaderboardUserProfilePr = {
  session_id: number
  pr_number: number | null
  pr_url: string | null
  pr_title: string | null
  status: string
  created_at: string
  app_slug: string
  app_name: string
  kudos_count: number
}

export type LeaderboardUserProfile = {
  user: { user_id: number; username: string }
  stats: { kudos_merged: number; prs_merged: number; prs_total: number }
  items: LeaderboardUserProfilePr[]
  nextBefore: string | null
}

type HistoryApp = { slug: string; name: string }

export type HistoryItem = {
  type: "kudos" | "bounty" | "pr_vote" | "proposal_vote"
  created_at: string
  app: HistoryApp
  status?: "open" | "awarded" | "voided" | string
  vote?: "yes" | "no" | "up" | "down" | string
  pr?: { sessionId: number | null; number: number | null; title: string | null; author: string | null }
  issue?: { number: number | null; title?: string | null; kind?: string | null }
  awarded?: { username: string | null; at: string | null }
}

export type MyHistoryResponse = {
  items: HistoryItem[]
  nextBefore: string | null
}

export class ApiRequestError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`Request failed (${status})`)
    this.name = "ApiRequestError"
    this.status = status
  }
}

async function requestJson<T>(path: string, signal?: AbortSignal) {
  const response = await fetch(path, { credentials: "same-origin", signal })
  if (!response.ok) throw new ApiRequestError(response.status)
  return response.json() as Promise<T>
}

export function getTopPrs(window: LeaderboardWindow, signal?: AbortSignal) {
  return requestJson<LeaderboardResponse<LeaderboardPr>>(`/api/leaderboard/prs?window=${window}&limit=20`, signal)
}

export function getTopUsers(window: LeaderboardWindow, signal?: AbortSignal) {
  return requestJson<LeaderboardResponse<LeaderboardUser>>(`/api/leaderboard/users?window=${window}&limit=20`, signal)
}

export function getLeaderboardUserProfile(username: string, before?: string | null, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: "50" })
  if (before) query.set("before", before)
  return requestJson<LeaderboardUserProfile>(`/api/leaderboard/users/${encodeURIComponent(username)}/prs?${query}`, signal)
}

/**
 * The signed-in viewer's own give-side record. This adapter remains read-only;
 * source records link to their owned React proposal or issue details, where
 * each mutation is capability-gated independently.
 */
export function getMyHistory(type: HistoryType, before?: string | null, signal?: AbortSignal) {
  const query = new URLSearchParams({ type, limit: "50" })
  if (before) query.set("before", before)
  return requestJson<MyHistoryResponse>(`/api/me/history?${query}`, signal)
}
