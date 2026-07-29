import type { StatusDotPresentation } from "@/components/status-dot"

export type NodePresentationStatus = "synced" | "syncing" | "connecting" | "offline" | "unavailable" | "unknown"

/**
 * Maps the current native and cached sidecar vocabularies without exposing
 * either source's raw status string to presentation components.
 */
export function nodePresentationStatus(status: string | null | undefined): StatusDotPresentation & {
  status: NodePresentationStatus
} {
  switch (status?.trim().toLocaleLowerCase()) {
    case "synced":
      return { status: "synced", role: "positive", label: "Synced" }
    case "syncing":
      return { status: "syncing", role: "info", label: "Syncing" }
    case "connecting":
      return { status: "connecting", role: "info", label: "Connecting" }
    case "offline":
      return { status: "offline", role: "negative", label: "Offline" }
    case "unreachable":
    case "bad_response":
    case "error":
      return { status: "unavailable", role: "negative", label: "Unavailable" }
    default:
      return { status: "unknown", role: "neutral", label: "Unknown" }
  }
}
