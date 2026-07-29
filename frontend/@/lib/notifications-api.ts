export type Notification = {
  id: number
  kind: string
  readAt: string | null
  appId: number | null
  appSlug: string | null
  appName: string | null
  createdAt: string
  /** Server-derived topic scope for a mention/reply/reaction target. */
  threadType?: "issue" | "session" | "governance" | string | null
  threadRef?: number | null
  sessionId?: number | null
  headlessIssueNumber?: number | null
  prTitle?: string | null
  messageContent?: string | null
  sourceUsername?: string | null
}

export type NotificationsSnapshot = { notifications: Notification[]; unread: number }

export type NotificationCursor = { createdAt: string; id: number }

export type PendingInvite = {
  kind: "collab" | "approver"
  appId: number
  appSlug: string
  appName: string
  invitedBy: string | null
  createdAt: string
}

export type NotificationsPage = {
  notifications: Notification[]
  unread?: number
  pendingInvites?: PendingInvite[]
  hasMore: boolean
  nextBefore: NotificationCursor | null
}

const SESSION_KINDS = new Set(["session_done", "auto_solve_done", "stale_pr", "check_failed"])

async function requestJson<T>(path: string, init?: RequestInit) {
  const response = await fetch(path, { credentials: "same-origin", ...init })
  if (!response.ok) throw new Error(`Request failed (${response.status})`)
  return response.json() as Promise<T>
}

export function isBellNotification(notification: Notification) {
  // Actionable invitations are modeled from `pendingInvites`, which is the
  // server's authoritative source of still-actionable collaborator and
  // approver membership. Showing their notification rows as ordinary bell
  // messages would duplicate the same invitation and make Mark all read
  // appear to resolve it when it has not been accepted or declined.
  return !SESSION_KINDS.has(notification.kind) && notification.kind !== "collab_invite" && notification.kind !== "approver_invite"
}

export async function getNotificationsPage(cursor?: NotificationCursor | null, signal?: AbortSignal): Promise<NotificationsPage> {
  const params = new URLSearchParams({ limit: "20" })
  if (cursor) {
    params.set("before", cursor.createdAt)
    params.set("before_id", String(cursor.id))
  }
  const snapshot = await requestJson<NotificationsPage>(`/api/notifications?${params.toString()}`, { signal })
  return {
    notifications: Array.isArray(snapshot.notifications) ? snapshot.notifications : [],
    ...(typeof snapshot.unread === "number" ? { unread: snapshot.unread } : {}),
    ...(Array.isArray(snapshot.pendingInvites) ? { pendingInvites: snapshot.pendingInvites } : {}),
    hasMore: snapshot.hasMore === true,
    nextBefore: snapshot.nextBefore && typeof snapshot.nextBefore.createdAt === "string" && Number.isFinite(snapshot.nextBefore.id)
      ? snapshot.nextBefore
      : null,
  }
}

export function markNotificationRead(id: number) {
  return requestJson<{ unread: number }>("/api/notifications/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) })
}

/** Clears only chat-actionable notifications attached to one canonical row. */
export function markChatMessageRead(chatMessageId: number) {
  return requestJson<{ unread: number; cleared: number }>("/api/notifications/read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_message_id: chatMessageId }),
  })
}

function inviteBase(kind: PendingInvite["kind"]) {
  return kind === "approver" ? "/api/approver-invites" : "/api/invites"
}

export function acceptInvite(invite: PendingInvite) {
  return requestJson<{ ok: true; appSlug?: string }>(`${inviteBase(invite.kind)}/${encodeURIComponent(String(invite.appId))}/accept`, { method: "POST" })
}

export function declineInvite(invite: PendingInvite) {
  return requestJson<{ ok: true }>(`${inviteBase(invite.kind)}/${encodeURIComponent(String(invite.appId))}/decline`, { method: "POST" })
}

/**
 * The legacy endpoint only understands `{ all: true }`, which would also
 * clear Dev-completion notifications. Those notifications belong to the Work
 * surface in this migration, so clear the visible bell rows one-by-one
 * instead. This retains the server's normal single-row mark-read contract
 * without silently changing hidden Work state.
 */
export async function markBellNotificationsRead(notifications: Notification[]) {
  const unreadBellIds = notifications.filter((notification) => isBellNotification(notification) && !notification.readAt).map((notification) => notification.id)
  await Promise.all(unreadBellIds.map((id) => markNotificationRead(id)))
}
