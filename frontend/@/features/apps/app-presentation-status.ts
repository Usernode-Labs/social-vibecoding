import type { StatusDotPresentation } from "@/components/status-dot"

export type AppPresentationStatus = "running" | "building" | "awaiting-secrets" | "unavailable" | "paused" | "unknown"

/** Explicit adapter from app lifecycle language to finite semantic roles. */
export function appPresentationStatus(status: string | null | undefined): StatusDotPresentation & {
  status: AppPresentationStatus
} {
  switch (status) {
    case "running": return { status: "running", role: "positive", label: "Running" }
    case "building": return { status: "building", role: "info", label: "Building" }
    case "awaiting_secrets":
    case "awaiting-secrets": return { status: "awaiting-secrets", role: "warning", label: "Configuration required" }
    case "paused": return { status: "paused", role: "attention", label: "Paused" }
    case "error":
    case "unavailable": return { status: "unavailable", role: "negative", label: "Unavailable" }
    case "unknown": return { status: "unknown", role: "neutral", label: "Unknown" }
    case undefined:
    case null:
    case "": return { status: "unknown", role: "neutral", label: "Unknown" }
    default: return { status: "unknown", role: "neutral", label: "Unknown" }
  }
}
