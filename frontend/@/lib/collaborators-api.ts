type ErrorPayload = { error?: unknown } | null

export class CollaboratorRequestError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "CollaboratorRequestError"
    this.status = status
  }
}

export type Collaborator = {
  userId: number
  username: string
  status: "member" | "invited"
  invitedBy: string | null
  isCreator: boolean
  createdAt: string
  acceptedAt: string | null
}

export type CollaboratorRoster = {
  collaborators: Collaborator[]
  collabVisibility: "public" | "private"
  viewVisibility: "public" | "private"
  creatorId: number
}

export type UserSearchResult = { id: number; username: string }

async function responseError(response: Response) {
  const payload = await response.json().catch(() => null) as ErrorPayload
  return typeof payload?.error === "string" && payload.error.trim()
    ? payload.error
    : `Request failed (${response.status})`
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init })
  if (!response.ok) throw new CollaboratorRequestError(response.status, await responseError(response))
  return response.json() as Promise<T>
}

/** Collaboration-gated canonical roster. A 404 is intentionally non-disclosing. */
export function getCollaborators(slug: string, signal?: AbortSignal) {
  return requestJson<CollaboratorRoster>(`/api/apps/${encodeURIComponent(slug)}/collaborators`, { signal })
}

/** Existing prefix typeahead; excludeApp suppresses both members and pending invitees. */
export async function searchInviteUsers(slug: string, query: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ q: query, excludeApp: slug })
  const payload = await requestJson<{ users?: UserSearchResult[] }>(`/api/users/search?${params.toString()}`, { signal })
  return Array.isArray(payload.users) ? payload.users : []
}

/** The server owns visibility, self-hosted, duplicate-invite and collaborator authorization checks. */
export function inviteCollaborator(slug: string, username: string) {
  return requestJson<{ ok: true; username: string }>(`/api/apps/${encodeURIComponent(slug)}/invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  })
}

/** Creator/admin removal, pending-invite revoke, and self-leave all share this server-authorized endpoint. */
export function removeCollaborator(slug: string, userId: number) {
  return requestJson<{ ok: true }>(`/api/apps/${encodeURIComponent(slug)}/collaborators/${encodeURIComponent(String(userId))}`, {
    method: "DELETE",
  })
}
