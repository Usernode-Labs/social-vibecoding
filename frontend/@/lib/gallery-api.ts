import { AdminAccessError } from "@/lib/admin-api"

export const galleryProblems = [
  { value: "", label: "Any capture outcome" },
  { value: "missing_recording", label: "Missing recording" },
  { value: "missing_before", label: "Missing before side" },
  { value: "before_fell_back", label: "Before fell back to home page" },
  { value: "root_only", label: "Shot at the front page only" },
  { value: "failed_or_skipped", label: "Capture failed or skipped" },
] as const

export type GalleryProblem = Exclude<(typeof galleryProblems)[number]["value"], "">

export type GalleryMedia = { png?: string | null; webm?: string | null; gif?: string | null }

export type GalleryVisualCapture = {
  index: number
  path?: string | null
  viewport?: "mobile" | string | null
  before?: GalleryMedia | null
  after?: GalleryMedia | null
  beforeFellBack?: boolean
}

export type GalleryVisuals = { captures?: GalleryVisualCapture[] } | null

export type GalleryProposal = {
  id: number
  mergedAt?: string | null
  prNumber?: number | null
  prUrl?: string | null
  title?: string | null
  appId?: number | null
  appSlug?: string | null
  appName?: string | null
  captureState?: "captured" | "partial" | "console_only" | "failed" | string | null
  captureReason?: string | null
  captureDetail?: Record<string, unknown> | null
  capturedAt?: string | null
  visuals?: GalleryVisuals
}

export type GalleryApp = { id: number; slug?: string | null; name?: string | null; proposal_count?: number | null }

export type GalleryStats = {
  total?: number
  complete?: number
  missing_recording?: number
  missing_before?: number
  before_fell_back?: number
  root_only?: number
  failed_or_skipped?: number
  unknown_state?: number
}

export type GalleryFilters = { app?: string; problem?: GalleryProblem | ""; before?: string; beforeId?: number | null; limit?: number }

export type GalleryPage = {
  proposals: GalleryProposal[]
  hasMore: boolean
  nextCursor: { before: string; before_id: number } | null
}

function query(filters: GalleryFilters, includeCursor = true) {
  const params = new URLSearchParams()
  if (filters.app) params.set("app", filters.app)
  if (filters.problem) params.set("problem", filters.problem)
  if (filters.limit != null) params.set("limit", String(filters.limit))
  if (includeCursor && filters.before && filters.beforeId != null) {
    params.set("before", filters.before)
    params.set("before_id", String(filters.beforeId))
  }
  return params
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", method: "GET", signal })
  if (response.status === 401 || response.status === 403) throw new AdminAccessError(response.status)
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: unknown } | null
    throw new Error(typeof payload?.error === "string" ? payload.error : `Request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}

/** Any admin can inspect this read-only index; the server independently enforces it. */
export function getGalleryApps(signal?: AbortSignal) {
  return request<{ apps?: GalleryApp[] }>("/api/gallery/apps", signal)
}

/** Server-owned counters; do not derive capture problems on the client. */
export function getGalleryStats(filters: Pick<GalleryFilters, "app" | "problem">, signal?: AbortSignal) {
  const params = query(filters, false)
  return request<{ stats?: GalleryStats }>(`/api/gallery/stats?${params.toString()}`, signal)
}

/** Metadata only. Artifact bytes remain at the deliberately public `/visuals/:id` route. */
export function getGalleryProposals(filters: GalleryFilters, signal?: AbortSignal) {
  const params = query(filters)
  return request<GalleryPage>(`/api/gallery/proposals?${params.toString()}`, signal)
}
