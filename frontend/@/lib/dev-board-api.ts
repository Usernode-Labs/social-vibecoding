import { getAppSessions, type AppSession } from "@/lib/apps-api"
import { getDevForum, type DevIssue, type DevProposal } from "@/lib/dev-forum-api"
import { getGitHubIssues, type GitHubIssue } from "@/lib/github-issues-api"

export type BoardOrderEntry = { type: "issue" | "proposal" | "gov"; ref: number }
export type BoardOrder = { issues: BoardOrderEntry[]; review: BoardOrderEntry[] }
export type PmOrderEntry = { type: "issue" | "proposal"; ref: number }
export type PmOrder = Record<string, PmOrderEntry[]>

export type SharedBoardSession = AppSession & {
  username?: string | null
  shared_at?: string | null
  last_activity_at?: string | null
  busy?: boolean
}

export type MergedBoardItem = {
  id: number
  pr_number?: number | null
  pr_title?: string | null
  username?: string | null
  created_at: string
  row_type?: "pr" | "close_issue" | string
  title?: string | null
}

export type DevBoardSnapshot = {
  issues: GitHubIssue[]
  proposals: DevProposal[]
  governance: DevIssue[]
  merged: MergedBoardItem[]
  sessions: AppSession[]
  sharedSessions: SharedBoardSession[]
  order: BoardOrder
  pmOrder: PmOrder
  mergedTotal: number
  mergedHasMore: boolean
}

export type MergedBoardPage = {
  merged: MergedBoardItem[]
  total: number
  hasMore: boolean
}

export type MergedBoardCursor = {
  createdAt: string
  id: number
  rowType: string
}

async function requestJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", signal })
  if (!response.ok) throw new Error(`Request failed (${response.status})`)
  return response.json() as Promise<T>
}

function normalizeOrder(value: unknown): BoardOrder {
  if (!value || typeof value !== "object") return { issues: [], review: [] }
  const data = value as Partial<BoardOrder>
  const valid = (entries: unknown): BoardOrderEntry[] => Array.isArray(entries)
    ? entries.filter((entry): entry is BoardOrderEntry => Boolean(entry) && typeof entry === "object" && ["issue", "proposal", "gov"].includes((entry as BoardOrderEntry).type) && Number.isFinite((entry as BoardOrderEntry).ref))
    : []
  return { issues: valid(data.issues), review: valid(data.review) }
}

function normalizePmOrder(value: unknown): PmOrder {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter(([assignee]) => Boolean(assignee.trim()))
      .map(([assignee, entries]) => [
        assignee.toLocaleLowerCase(),
        Array.isArray(entries)
          ? entries.filter((entry): entry is PmOrderEntry => Boolean(entry)
            && typeof entry === "object"
            && ["issue", "proposal"].includes((entry as PmOrderEntry).type)
            && Number.isFinite((entry as PmOrderEntry).ref))
          : [],
      ]),
  )
}

export function getDevBoardSnapshot(slug: string, signal?: AbortSignal): Promise<DevBoardSnapshot> {
  const safeSlug = encodeURIComponent(slug)
  return Promise.all([
    getGitHubIssues(slug, signal),
    getDevForum(slug, signal),
    getAppSessions(slug, signal),
    // These supporting feeds are progressive enhancement. An unavailable
    // shared/merged endpoint must not hide the app's sessions and issue board.
    requestJson<{ sessions?: SharedBoardSession[] }>(`/api/apps/${safeSlug}/shared-sessions`, signal).catch(() => ({ sessions: [] })),
    getMergedBoardPage(slug, undefined, signal).catch(() => ({ merged: [], total: 0, hasMore: false })),
    requestJson<unknown>(`/api/apps/${safeSlug}/board-order`, signal).catch(() => null),
    requestJson<unknown>(`/api/apps/${safeSlug}/pm-order`, signal).catch(() => null),
  ]).then(([github, forum, sessions, shared, merged, rawOrder, rawPmOrder]) => ({
    issues: github.issues || [],
    proposals: forum.proposals || [],
    governance: (forum.issues || []).filter((item) => ["secret_change", "rename", "close_issue"].includes(item.kind)),
    merged: merged.merged || [],
    sessions: sessions.sessions || [],
    sharedSessions: shared.sessions || [],
    order: normalizeOrder(rawOrder),
    pmOrder: normalizePmOrder(rawPmOrder),
    mergedTotal: typeof merged.total === "number" ? merged.total : (merged.merged || []).length,
    mergedHasMore: Boolean(merged.hasMore),
  }))
}

export async function getMergedBoardPage(
  slug: string,
  cursor?: MergedBoardCursor,
  signal?: AbortSignal,
): Promise<MergedBoardPage> {
  const parameters = new URLSearchParams({ limit: "20" })
  if (cursor) {
    parameters.set("before", cursor.createdAt)
    parameters.set("before_id", String(cursor.id))
    parameters.set("before_type", cursor.rowType === "close_issue" ? "close_issue" : "pr")
  }
  const page = await requestJson<{ merged?: MergedBoardItem[]; total?: number; hasMore?: boolean }>(
    `/api/apps/${encodeURIComponent(slug)}/merged?${parameters}`,
    signal,
  )
  const merged = Array.isArray(page.merged) ? page.merged : []
  return {
    merged,
    total: typeof page.total === "number" ? page.total : merged.length,
    hasMore: Boolean(page.hasMore),
  }
}

export async function saveDevBoardOrder(slug: string, column: "issues" | "review", order: BoardOrderEntry[]): Promise<BoardOrder> {
  const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/board-order`, {
    credentials: "same-origin",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ column, order }),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: unknown } | null
    throw new Error(typeof payload?.error === "string" ? payload.error : `Request failed (${response.status})`)
  }
  return normalizeOrder(await response.json())
}

async function responseError(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: unknown } | null
  return typeof payload?.error === "string" ? payload.error : `Request failed (${response.status})`
}

export async function saveDevPmOrder(slug: string, assignee: string, order: PmOrderEntry[]): Promise<PmOrder> {
  const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/pm-order`, {
    credentials: "same-origin",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assignee, order }),
  })
  if (!response.ok) throw new Error(await responseError(response))
  return normalizePmOrder(await response.json())
}

type PmTopicTarget = { type: "issue" | "proposal"; ref: number }

/**
 * PM drag assignment is the caller's reversible assignee vote, not a private
 * workflow field. The server recomputes the visible leading assignee.
 */
export async function setDevPmAssignee(slug: string, target: PmTopicTarget, assignee: string) {
  const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/topics/${target.type}/${target.ref}/attributes`, {
    credentials: "same-origin",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ field: "assignee", value: assignee }),
  })
  if (!response.ok) throw new Error(await responseError(response))
  return response.json() as Promise<unknown>
}

export async function clearDevPmAssignee(slug: string, target: PmTopicTarget) {
  const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/topics/${target.type}/${target.ref}/attributes?field=assignee`, {
    credentials: "same-origin",
    method: "DELETE",
  })
  if (!response.ok) throw new Error(await responseError(response))
  return response.json() as Promise<unknown>
}
