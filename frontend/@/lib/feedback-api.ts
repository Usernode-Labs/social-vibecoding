export type FeedbackTarget = "platform" | "app"

export type FeedbackInput = {
  description: string
  title?: string
  target: FeedbackTarget
  appSlug?: string
}

export type FeedbackResult = {
  url?: string
  title?: string
  titleFallback?: boolean
}

async function responseError(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: unknown } | null
  return typeof payload?.error === "string" && payload.error.trim()
    ? payload.error
    : `Request failed (${response.status})`
}

/**
 * The server owns rate limiting, optional AI naming, target validation and
 * GitHub issue creation. An absent title is intentional: it tells the
 * existing endpoint to use its safe fallback/generation path.
 */
export async function submitFeedback(input: FeedbackInput): Promise<FeedbackResult> {
  // Keep the selected app in the request URL as well as the validated JSON
  // body. The local production-write proxy can then permit feedback only for
  // its explicitly scoped app without buffering or rewriting a POST body.
  // The production endpoint ignores this compatibility query parameter and
  // remains the authority for validating the submitted target and app slug.
  const scope = input.target === "app" && input.appSlug
    ? `?app=${encodeURIComponent(input.appSlug)}`
    : ""
  const response = await fetch(`/api/feedback${scope}`, {
    credentials: "same-origin",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      description: input.description,
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      target: input.target,
      ...(input.target === "app" && input.appSlug ? { appSlug: input.appSlug } : {}),
    }),
  })
  if (!response.ok) throw new Error(await responseError(response))
  return response.json() as Promise<FeedbackResult>
}

/**
 * This is a best-effort preview only. The submit endpoint remains fully
 * functional when title generation is unavailable or rate-limited.
 */
export async function getFeedbackTitlePreview(description: string, signal?: AbortSignal) {
  const response = await fetch("/api/feedback/title", {
    credentials: "same-origin",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
    signal,
  })
  if (!response.ok) return null
  const payload = await response.json() as { title?: unknown }
  return typeof payload.title === "string" && payload.title.trim() ? payload.title : null
}
