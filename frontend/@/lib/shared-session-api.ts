/**
 * Metadata deliberately exposed by the view-authorized shared-sessions
 * endpoint. It excludes the owner's Dev-chat credentials and private turn
 * history; the public discussion uses the separate `session` chat thread.
 */
export type SharedSession = {
  id: number
  session_title?: string | null
  pr_title?: string | null
  branch_name?: string | null
  status: "active" | "paused" | string
  staging_url?: string | null
  can_preview?: boolean
  linked_issues?: number[] | null
  username?: string | null
  shared_at?: string | null
  created_at?: string | null
  last_activity_at?: string | null
  chat_count?: number | null
  last_message_at?: string | null
  busy?: boolean
}

export type SharedSessionDetail = {
  session: SharedSession | null
}

async function requestJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", signal })
  if (!response.ok) throw new Error(`Request failed (${response.status})`)
  return response.json() as Promise<T>
}

export function getSharedSessions(slug: string, signal?: AbortSignal) {
  return requestJson<{ sessions?: SharedSession[] }>(`/api/apps/${encodeURIComponent(slug)}/shared-sessions`, signal)
}

/**
 * Resolve metadata before mounting the independently authorized discussion.
 * The generic messages endpoint does not itself prove that a session remains
 * shared, so this guard preserves the public-session boundary.
 */
export async function getSharedSessionDetail(slug: string, sessionId: number, signal?: AbortSignal): Promise<SharedSessionDetail> {
  const { sessions = [] } = await getSharedSessions(slug, signal)
  const session = sessions.find((candidate) => candidate.id === sessionId) || null
  return { session }
}
