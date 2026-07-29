export type SessionUpdateEvent = {
  type: "session_update"
  action: string
  sessionId?: number | string
  appId?: number | string
  appSlug?: string
  behindMain?: number
}

export type BoardOrderUpdateEvent = {
  type: "board_order_update"
  appId?: number | string
  appSlug?: string
  column?: string
  pm?: boolean
}

export type SessionEventsConnectionState = "connecting" | "connected" | "reconnecting" | "unavailable"

type GlobalEventsSubscriptionOptions = {
  onConnectionStateChange?: (state: SessionEventsConnectionState) => void
  onSessionUpdate?: (event: SessionUpdateEvent) => void
  onBoardOrderUpdate?: (event: BoardOrderUpdateEvent) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isIdentifier(value: unknown): value is number | string {
  return typeof value === "number" || typeof value === "string"
}

function parseSessionUpdate(value: unknown): SessionUpdateEvent | null {
  if (!isRecord(value) || value.type !== "session_update") return null
  return {
    type: "session_update",
    action: typeof value.action === "string" ? value.action : "updated",
    ...(isIdentifier(value.sessionId) ? { sessionId: value.sessionId } : {}),
    ...(isIdentifier(value.appId) ? { appId: value.appId } : {}),
    ...(typeof value.appSlug === "string" ? { appSlug: value.appSlug } : {}),
    ...(typeof value.behindMain === "number" ? { behindMain: value.behindMain } : {}),
  }
}

function parseBoardOrderUpdate(value: unknown): BoardOrderUpdateEvent | null {
  if (!isRecord(value) || value.type !== "board_order_update") return null
  return {
    type: "board_order_update",
    ...(isIdentifier(value.appId) ? { appId: value.appId } : {}),
    ...(typeof value.appSlug === "string" ? { appSlug: value.appSlug } : {}),
    ...(typeof value.column === "string" ? { column: value.column } : {}),
    ...(typeof value.pm === "boolean" ? { pm: value.pm } : {}),
  }
}

function eventsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  // The production shell uses the same cookie-authenticated endpoint. Keep
  // the staging iframe JWT fallback for the existing embedded-app contract.
  const token = new URLSearchParams(window.location.search).get("token")
  return `${protocol}//${window.location.host}/ws/events${token ? `?token=${encodeURIComponent(token)}` : ""}`
}

/**
 * Typed read-only subscription to the established global session-update
 * channel. The server filters app visibility before broadcasting; consumers
 * still refetch their own authorised snapshot rather than patching it from a
 * partial event. This also makes reconnect recovery deterministic.
 */
export function subscribeGlobalUpdates(options: GlobalEventsSubscriptionOptions) {
  let disposed = false
  let socket: WebSocket | null = null
  let reconnectTimer: number | null = null

  const emitState = (state: SessionEventsConnectionState) => options.onConnectionStateChange?.(state)
  const clearReconnect = () => {
    if (reconnectTimer === null) return
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  const connect = () => {
    if (disposed) return
    emitState(socket ? "reconnecting" : "connecting")
    try {
      // Read from globalThis at connect time. It preserves the browser's
      // native constructor in production and lets deterministic browser
      // fixtures exercise reconnect behavior without a live socket server.
      socket = new globalThis.WebSocket(eventsUrl())
    } catch {
      emitState("unavailable")
      return
    }
    socket.onopen = () => {
      if (disposed) return
      clearReconnect()
      emitState("connected")
    }
    socket.onmessage = (message) => {
      let data: unknown
      try { data = JSON.parse(message.data as string) } catch { return }
      const update = parseSessionUpdate(data)
      if (update) options.onSessionUpdate?.(update)
      const boardOrder = parseBoardOrderUpdate(data)
      if (boardOrder) options.onBoardOrderUpdate?.(boardOrder)
    }
    socket.onerror = () => {
      if (!disposed) emitState("reconnecting")
    }
    socket.onclose = () => {
      if (disposed) return
      emitState("reconnecting")
      clearReconnect()
      // Match the legacy global-events client: a reconnect gives consumers a
      // fresh snapshot after any events that were missed while disconnected.
      reconnectTimer = window.setTimeout(connect, 3000)
    }
  }

  connect()
  return () => {
    disposed = true
    clearReconnect()
    socket?.close()
  }
}

export function subscribeSessionUpdates(options: {
  onConnectionStateChange?: (state: SessionEventsConnectionState) => void
  onSessionUpdate: (event: SessionUpdateEvent) => void
}) {
  return subscribeGlobalUpdates(options)
}
