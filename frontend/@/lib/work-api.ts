export type WorkSession = {
  id: number
  app_slug: string
  app_name: string
  branch_name: string | null
  pr_title: string | null
  session_title: string | null
  status: "active" | "promoted" | "paused" | string
  busy: boolean
  last_activity_at: string | null
  created_at: string
}

export type WorkProposal = {
  id: number
  app_slug: string
  app_name: string
  pr_title: string | null
  pr_number: number | null
  status: string
  yes_count: number
  votes_required?: number
  majority?: number
}

export type WorkGovernance = {
  id: number
  app_slug: string
  app_name: string
  title: string
  up_count: number
  votes_required?: number
  majority?: number
}

export type WorkSnapshot = {
  sessions: WorkSession[]
  proposals: WorkProposal[]
  governance: WorkGovernance[]
}

async function requestJson<T>(path: string, signal?: AbortSignal) {
  const response = await fetch(path, { credentials: "same-origin", signal })
  if (!response.ok) throw new Error(`Request failed (${response.status})`)
  return response.json() as Promise<T>
}

export async function getWorkSnapshot(signal?: AbortSignal): Promise<WorkSnapshot> {
  const [sessions, proposals] = await Promise.all([
    requestJson<{ sessions?: WorkSession[] }>("/api/me/active-sessions", signal),
    requestJson<{ proposals?: WorkProposal[]; governance?: WorkGovernance[] }>("/api/me/proposals", signal),
  ])
  return {
    sessions: Array.isArray(sessions.sessions) ? sessions.sessions : [],
    proposals: Array.isArray(proposals.proposals) ? proposals.proposals : [],
    governance: Array.isArray(proposals.governance) ? proposals.governance : [],
  }
}
