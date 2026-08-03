import type { StatusDotPresentation } from "@/components/status-dot"

export type KnownServiceLifecycleState =
  | "running"
  | "ok"
  | "enabled"
  | "disabled"
  | "loaded"
  | "not-loaded"
  | "starting"
  | "missing"
  | "unreachable"
  | "bad-response"
  | "error"
  | "failed"
  | "orphan"
  | "stuck"

export type ServicePresentationStatus = KnownServiceLifecycleState | "unknown"

const servicePresentations = {
  running: { status: "running", role: "positive", label: "Running" },
  ok: { status: "ok", role: "positive", label: "Available" },
  enabled: { status: "enabled", role: "positive", label: "Enabled" },
  disabled: { status: "disabled", role: "neutral", label: "Disabled" },
  loaded: { status: "loaded", role: "positive", label: "Loaded" },
  "not-loaded": { status: "not-loaded", role: "warning", label: "Not loaded" },
  starting: { status: "starting", role: "info", label: "Starting" },
  missing: { status: "missing", role: "negative", label: "Missing" },
  unreachable: { status: "unreachable", role: "negative", label: "Unavailable" },
  "bad-response": { status: "bad-response", role: "negative", label: "Unavailable" },
  error: { status: "error", role: "negative", label: "Unavailable" },
  failed: { status: "failed", role: "negative", label: "Unavailable" },
  orphan: { status: "orphan", role: "negative", label: "Orphaned" },
  stuck: { status: "stuck", role: "attention", label: "Stuck" },
} satisfies {
  [Status in KnownServiceLifecycleState]: StatusDotPresentation & { status: Status }
}

function isKnownServiceLifecycleState(status: string): status is KnownServiceLifecycleState {
  return Object.prototype.hasOwnProperty.call(servicePresentations, status)
}

/** Maps operational service vocabularies to the finite StatusDot contract. */
export function servicePresentationStatus(status: string | null | undefined): StatusDotPresentation & {
  status: ServicePresentationStatus
} {
  const normalized = status?.trim().toLocaleLowerCase().replaceAll("_", "-") || ""
  if (isKnownServiceLifecycleState(normalized)) return servicePresentations[normalized]
  return { status: "unknown", role: "warning", label: "Unknown" }
}
