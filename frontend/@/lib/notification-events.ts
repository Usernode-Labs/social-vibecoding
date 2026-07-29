import type { Notification } from "@/lib/notifications-api"

export type NotificationEventsConnectionState = "connecting" | "connected" | "reconnecting" | "unavailable"

export type NotificationEvent = {
  type: "notification_new" | "notifications_changed"
  notification: Notification | null
}

type NotificationEventsSubscriptionOptions = {
  onConnectionStateChange?: (state: NotificationEventsConnectionState) => void
  onNotificationChange: (event: NotificationEvent) => void
}

const subscribers = new Set<NotificationEventsSubscriptionOptions>()
let state: NotificationEventsConnectionState = "connecting"
let socket: WebSocket | null = null
let reconnectTimer: number | null = null
let disposed = true

function eventsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  const token = new URLSearchParams(window.location.search).get("token")
  return `${protocol}//${window.location.host}/ws/events${token ? `?token=${encodeURIComponent(token)}` : ""}`
}

function normalizeNotification(value: unknown): Notification | null {
  if (!value || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  const id = Number(row.id)
  if (!Number.isInteger(id) || typeof row.kind !== "string") return null
  const integerOrNull = (candidate: unknown) => {
    if (candidate === null || candidate === undefined || candidate === "") return null
    const number = Number(candidate)
    return Number.isInteger(number) ? number : null
  }
  return {
    id,
    kind: row.kind,
    readAt: typeof row.readAt === "string" ? row.readAt : null,
    appId: integerOrNull(row.appId),
    appSlug: typeof row.appSlug === "string" ? row.appSlug : null,
    appName: typeof row.appName === "string" ? row.appName : null,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : new Date().toISOString(),
    threadType: typeof row.threadType === "string" ? row.threadType : null,
    threadRef: integerOrNull(row.threadRef),
    sessionId: integerOrNull(row.sessionId),
    headlessIssueNumber: integerOrNull(row.headlessIssueNumber),
    prTitle: typeof row.prTitle === "string" ? row.prTitle : null,
    messageContent: typeof row.messageContent === "string" ? row.messageContent : null,
    sourceUsername: typeof row.sourceUsername === "string" ? row.sourceUsername : null,
  }
}

function parseNotificationEvent(value: unknown): NotificationEvent | null {
  if (!value || typeof value !== "object" || !("type" in value)) return null
  const payload = value as { type?: unknown; notification?: unknown }
  if (payload.type !== "notification_new" && payload.type !== "notifications_changed") return null
  return {
    type: payload.type,
    notification: payload.type === "notification_new"
      ? normalizeNotification(payload.notification)
      : null,
  }
}

function emitState(next: NotificationEventsConnectionState) {
  state = next
  for (const subscriber of subscribers) subscriber.onConnectionStateChange?.(next)
}

function clearReconnect() {
  if (reconnectTimer === null) return
  window.clearTimeout(reconnectTimer)
  reconnectTimer = null
}

function connect() {
  if (disposed || !subscribers.size || socket) return
  emitState(state === "connected" ? "reconnecting" : "connecting")
  try {
    socket = new globalThis.WebSocket(eventsUrl())
  } catch {
    socket = null
    emitState("unavailable")
    return
  }
  socket.onopen = () => {
    if (disposed) return
    clearReconnect()
    emitState("connected")
  }
  socket.onmessage = (message) => {
    let payload: unknown
    try {
      payload = JSON.parse(message.data as string)
    } catch {
      return
    }
    const event = parseNotificationEvent(payload)
    if (!event) return
    for (const subscriber of subscribers) subscriber.onNotificationChange(event)
  }
  socket.onerror = () => {
    if (!disposed) emitState("reconnecting")
  }
  socket.onclose = () => {
    socket = null
    if (disposed || !subscribers.size) return
    emitState("reconnecting")
    clearReconnect()
    reconnectTimer = window.setTimeout(connect, 3000)
  }
}

/**
 * Share one authenticated event socket across the platform shell and route
 * consumers. Notification pages still re-read canonical cursor data while
 * lightweight global consumers may use the fully hydrated pushed row.
 */
export function subscribeNotificationEvents(options: NotificationEventsSubscriptionOptions) {
  subscribers.add(options)
  options.onConnectionStateChange?.(state)
  if (subscribers.size === 1) {
    disposed = false
    connect()
  }
  return () => {
    subscribers.delete(options)
    if (subscribers.size) return
    disposed = true
    clearReconnect()
    const closing = socket
    socket = null
    closing?.close()
    state = "connecting"
  }
}
