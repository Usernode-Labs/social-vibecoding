export type GroupChatAttachment = {
  id: string
  kind: "image" | "markdown" | "html" | "text" | "binary" | string
  filename: string
  contentType?: string | null
  sizeBytes?: number | null
  meta?: unknown
}

export type GroupChatReaction = {
  emoji: string
  count: number
  users?: string[]
}

export type GroupChatQuote = {
  source?: "message" | "pr" | "spec" | string
  author?: string | null
  snippet?: string | null
  refMsgId?: number | string | null
  prNumber?: number | string | null
}

export type GroupChatMetadata = {
  attachments?: GroupChatAttachment[]
  quote?: GroupChatQuote
  specShare?: {
    title?: string | null
    version?: number | string | null
    sharedBy?: { username?: string | null }
  }
}

export type GroupChatMessage = {
  id: number | string
  user_id: number | string | null
  username: string | null
  content: string
  msg_type: "message" | "system" | "vote" | "conflict" | "spec_share" | string
  metadata?: GroupChatMetadata | null
  created_at: string
  edited_at?: string | null
  reactions?: GroupChatReaction[]
  has_unread_notification?: boolean
}

export type GroupChatHistory = { messages: GroupChatMessage[] }

export type GroupChatConnectionState = "connecting" | "connected" | "reconnecting" | "unavailable"

export type GroupChatThread = {
  type: "issue" | "session" | "governance"
  ref: number
}

export type GroupChatReplyTarget = {
  source: "message" | "event" | "spec"
  refMsgId: number
  author: string | null
  snippet: string
}

type GroupChatSubscriptionOptions = {
  onConnectionStateChange?: (state: GroupChatConnectionState) => void
  onTypingUsersChange?: (usernames: string[]) => void
  /**
   * The socket broadcast is deliberately treated as an invalidation signal,
   * not as a partial replacement for canonical history. This preserves the
   * existing server's reaction, notification, metadata and access shaping.
   */
  onMessagesChanged: () => void
}

async function requestJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", signal })
  if (!response.ok) throw new Error(`Request failed (${response.status})`)
  return response.json() as Promise<T>
}

/** Latest general app discussion history. Topic histories use the scoped reader below. */
export function getGroupChat(slug: string, signal?: AbortSignal) {
  return requestJson<GroupChatHistory>(`/api/apps/${encodeURIComponent(slug)}/messages?limit=50`, signal)
}
export function getTopicDiscussion(slug: string, threadType: GroupChatThread["type"], threadRef: number, before?: string | number, signal?: AbortSignal) {
  const params = new URLSearchParams({
    thread_type: threadType,
    thread_ref: String(threadRef),
    limit: "50",
  })
  if (before != null) params.set("before", String(before))
  return requestJson<GroupChatHistory>(
    `/api/apps/${encodeURIComponent(slug)}/messages?${params}`,
    signal
  )
}

/** Canonical collaboration-gated candidate set shared with @mention UI. */
export async function getMentionSuggestions(slug: string, signal?: AbortSignal) {
  const payload = await requestJson<{ users?: Array<{ username?: string | null }> }>(
    `/api/apps/${encodeURIComponent(slug)}/mention-suggestions`,
    signal,
  )
  return (payload.users || [])
    .map(({ username }) => username?.trim() || "")
    .filter(Boolean)
}

/** The attachment endpoint performs its own app-view authorization. */
export function groupChatAttachmentPath(slug: string, attachmentId: string) {
  return `/api/apps/${encodeURIComponent(slug)}/chat-attachments/${encodeURIComponent(attachmentId)}`
}

/**
 * Uploads immutable attachment bytes before the chat send. The server remains
 * authoritative for file classification, per-kind limits and app storage.
 */
export async function uploadGroupChatAttachment(slug: string, file: File, signal?: AbortSignal) {
  const response = await fetch(
    `/api/apps/${encodeURIComponent(slug)}/chat-attachments?filename=${encodeURIComponent(file.name)}`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
      signal,
    }
  )
  const result = await response.json().catch(() => null) as (GroupChatAttachment & { error?: string }) | null
  if (!response.ok || !result?.id) {
    throw new Error(result?.error || `Upload failed (${response.status})`)
  }
  return result
}

function groupChatUrl(slug: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  // Preserve the existing staging iframe fallback. Production continues to
  // authenticate only with the same-origin session cookie.
  const token = new URLSearchParams(window.location.search).get("token")
  return `${protocol}//${window.location.host}/ws/chat/${encodeURIComponent(slug)}${token ? `?token=${encodeURIComponent(token)}` : ""}`
}

function isRelevantChatBroadcast(value: unknown, thread?: GroupChatThread) {
  if (!value || typeof value !== "object") return false
  const event = value as {
    type?: unknown
    thread?: { type?: unknown; ref?: unknown } | null
  }
  // Reaction broadcasts do not carry a thread marker. A harmless canonical
  // re-read is preferable to trying to patch a possibly scoped aggregate
  // into the general transcript locally.
  if (event.type === "reaction") return true
  if (event.type !== "chat" && event.type !== "chat_edit") return false
  if (!thread) return !event.thread
  return event.thread?.type === thread.type && Number(event.thread.ref) === thread.ref
}

function isMatchingThreadBroadcast(value: unknown, thread?: GroupChatThread) {
  if (!value || typeof value !== "object") return false
  const event = value as { thread?: { type?: unknown; ref?: unknown } | null }
  if (!thread) return !event.thread
  return event.thread?.type === thread.type && Number(event.thread.ref) === thread.ref
}

/**
 * Small typed adapter for the established group-chat socket. React sends only
 * canonical text, minimal reply references, author edits and reaction toggles,
 * then refetches history after broadcasts rather than maintaining a partial
 * local chat cache.
 */
export function subscribeGroupChat(
  slug: string,
  options: GroupChatSubscriptionOptions,
  thread?: GroupChatThread
) {
  let disposed = false
  let socket: WebSocket | null = null
  let reconnectTimer: number | null = null
  let typingThrottleTimer: number | null = null
  const typingUsers = new Map<string, { username: string; timeout: number }>()

  const emitState = (state: GroupChatConnectionState) => options.onConnectionStateChange?.(state)
  const emitTypingUsers = () => options.onTypingUsersChange?.([...typingUsers.values()].map(({ username }) => username))
  const clearTypingUsers = () => {
    typingUsers.forEach(({ timeout }) => window.clearTimeout(timeout))
    typingUsers.clear()
    emitTypingUsers()
  }
  const clearReconnect = () => {
    if (reconnectTimer === null) return
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  const connect = () => {
    if (disposed) return
    emitState(socket ? "reconnecting" : "connecting")
    try {
      socket = new globalThis.WebSocket(groupChatUrl(slug))
    } catch {
      emitState("unavailable")
      return
    }
    socket.onopen = () => {
      if (disposed) return
      clearReconnect()
      emitState("connected")
      // Reconnects may have missed messages while the socket was down.
      options.onMessagesChanged()
    }
    socket.onmessage = (message) => {
      let event: unknown
      try { event = JSON.parse(message.data as string) } catch { return }
      if (event && typeof event === "object" && (event as { type?: unknown }).type === "typing" && isMatchingThreadBroadcast(event, thread)) {
        const typingEvent = event as { userId?: unknown; username?: unknown }
        if ((typeof typingEvent.userId === "number" || typeof typingEvent.userId === "string") && typeof typingEvent.username === "string" && typingEvent.username.trim()) {
          const key = String(typingEvent.userId)
          const existing = typingUsers.get(key)
          if (existing) window.clearTimeout(existing.timeout)
          const timeout = window.setTimeout(() => {
            typingUsers.delete(key)
            emitTypingUsers()
          }, 3000)
          typingUsers.set(key, { username: typingEvent.username.trim(), timeout })
          emitTypingUsers()
        }
        return
      }
      if (isRelevantChatBroadcast(event, thread)) options.onMessagesChanged()
    }
    socket.onerror = () => {
      if (!disposed) emitState("reconnecting")
    }
    socket.onclose = () => {
      if (disposed) return
      clearTypingUsers()
      emitState("reconnecting")
      clearReconnect()
      reconnectTimer = window.setTimeout(connect, 3000)
    }
  }

  connect()
  return {
    send(content: string, replyTarget?: GroupChatReplyTarget | null, attachmentIds: string[] = []) {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("Discussion is reconnecting. Try again in a moment.")
      }
      socket.send(JSON.stringify({
        type: "chat",
        content,
        ...(thread ? { thread } : {}),
        ...(replyTarget
          ? { quote: { source: replyTarget.source, refMsgId: replyTarget.refMsgId } }
          : {}),
        ...(attachmentIds.length ? { attachmentIds } : {}),
      }))
    },
    react(messageId: number | string, emoji: string) {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("Discussion is reconnecting. Try again in a moment.")
      }
      socket.send(JSON.stringify({ type: "react", messageId, emoji }))
    },
    edit(messageId: number | string, content: string) {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("Discussion is reconnecting. Try again in a moment.")
      }
      socket.send(JSON.stringify({ type: "edit", messageId, content }))
    },
    typing() {
      if (!socket || socket.readyState !== WebSocket.OPEN || typingThrottleTimer !== null) return
      socket.send(JSON.stringify({ type: "typing", ...(thread ? { thread } : {}) }))
      typingThrottleTimer = window.setTimeout(() => {
        typingThrottleTimer = null
      }, 2000)
    },
    dispose() {
      disposed = true
      clearReconnect()
      if (typingThrottleTimer !== null) window.clearTimeout(typingThrottleTimer)
      clearTypingUsers()
      socket?.close()
    },
  }
}
