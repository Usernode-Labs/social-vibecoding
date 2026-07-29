const SESSION_DRAFT_PREFIX = "social-vibecoding:dev-session-draft:"
const SAVED_DRAFT_PREFIX = "usernode:dc-saved-drafts:"

export const MAX_SAVED_DEV_DRAFTS = 20

export type SavedDevDraft = {
  id: string
  text: string
  savedAt: string | null
}

function key(sessionId: number | string) {
  return `${SESSION_DRAFT_PREFIX}${String(sessionId)}`
}

export function readDevSessionDraft(sessionId: number | string) {
  try {
    return sessionStorage.getItem(key(sessionId)) || ""
  } catch {
    return ""
  }
}

export function saveDevSessionDraft(sessionId: number | string, message: string) {
  try {
    if (message) sessionStorage.setItem(key(sessionId), message)
    else sessionStorage.removeItem(key(sessionId))
  } catch {
    // A draft is an enhancement; a restricted browser must still send turns.
  }
}

export function readSavedDevDrafts(sessionId: number | string): SavedDevDraft[] {
  try {
    const raw = localStorage.getItem(`${SAVED_DRAFT_PREFIX}${String(sessionId)}`)
    if (raw === null) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return []
      const row = candidate as Record<string, unknown>
      const id = typeof row.id === "string" ? row.id.trim() : ""
      const text = typeof row.text === "string" ? row.text.trim() : ""
      if (!id || !text) return []
      return [{
        id,
        text,
        savedAt: typeof row.savedAt === "string" ? row.savedAt : null,
      }]
    }).slice(0, MAX_SAVED_DEV_DRAFTS)
  } catch {
    return []
  }
}

export function saveSavedDevDrafts(sessionId: number | string, drafts: SavedDevDraft[]) {
  try {
    localStorage.setItem(
      `${SAVED_DRAFT_PREFIX}${String(sessionId)}`,
      JSON.stringify(drafts.slice(0, MAX_SAVED_DEV_DRAFTS)),
    )
  } catch {
    // Saved drafts are a local enhancement; restricted storage must not
    // interfere with the server-authorized Dev conversation.
  }
}

export function createSavedDevDraft(text: string): SavedDevDraft {
  const randomId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return {
    id: `d${randomId}`,
    text: text.trim(),
    savedAt: new Date().toISOString(),
  }
}

export function issueKickoffDraft(issueNumber: number, title: string, body?: string | null) {
  const description = body?.trim() ? `\n\n${body.trim()}` : ""
  return `Please implement GitHub issue #${issueNumber}: "${title}".${description}\n\nOpen a PR that closes this issue (include "Closes #${issueNumber}" so it links and closes the issue on merge).`
}
