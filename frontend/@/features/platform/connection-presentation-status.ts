import type { StatusDotPresentation } from "@/components/status-dot"

export type LiveConnectionState = "connecting" | "connected" | "reconnecting" | "unavailable"
export type ConnectionPresentationStatus = LiveConnectionState | "unknown"

/**
 * Shared presentation mapping for the current notification, session, and
 * group-discussion live connection states.
 */
export function connectionPresentationStatus(status: LiveConnectionState | null | undefined): StatusDotPresentation & {
  status: ConnectionPresentationStatus
} {
  switch (status) {
    case "connected":
      return { status: "connected", role: "positive", label: "Connected" }
    case "connecting":
      return { status: "connecting", role: "info", label: "Connecting" }
    case "reconnecting":
      return { status: "reconnecting", role: "info", label: "Reconnecting" }
    case "unavailable":
      return { status: "unavailable", role: "negative", label: "Unavailable" }
    default:
      return { status: "unknown", role: "neutral", label: "Unknown" }
  }
}
