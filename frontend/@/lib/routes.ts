export function legacyHash(path: string) {
  return `/${path.startsWith("#") ? path : `#${path}`}`
}

export function appHash(slug: string, tab: "app" | "dev" = "app") {
  return `/#app/${encodeURIComponent(slug)}/${tab}`
}

export function appDetailsPath(slug: string) {
  return `/apps/${encodeURIComponent(slug)}`
}

const appInnerPathLimit = 512

/**
 * The hosted app owns its inner route. The shell accepts only an absolute
 * path on that app's existing origin; schemes, protocol-relative paths,
 * whitespace and URL-delimiter injection are rejected.
 */
export function safeAppInnerPath(value: string | null | undefined) {
  if (!value || value.length > appInnerPathLimit || !value.startsWith("/") || value.startsWith("//")) return null
  const hasUnsafeCharacter = [...value].some((character) => {
    const code = character.charCodeAt(0)
    return /[\s\\`'"<>]/.test(character) || code < 32 || code === 127
  })
  return hasUnsafeCharacter ? null : value
}

/** Basename-relative route used by React Router links. */
export function appOpenPath(slug: string, innerPath?: string | null) {
  if (!slug.trim()) throw new Error("App open route requires a non-empty slug")
  const route = `${appDetailsPath(slug)}/open`
  if (innerPath === null || innerPath === undefined) return route
  const safePath = safeAppInnerPath(innerPath)
  if (!safePath) throw new Error("App open route received an unsafe inner path")
  return `${route}?${new URLSearchParams({ path: safePath })}`
}

/** Full history-fallback pathname used outside React Router, including native shortcuts. */
export function reactAppOpenPath(slug: string, innerPath?: string | null) {
  return `/react${appOpenPath(slug, innerPath)}`
}

export function appShortcutTarget(origin: string | URL, slug: string, innerPath?: string | null) {
  const base = new URL(String(origin))
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) {
    throw new Error("App shortcut origin must be an HTTP(S) origin without credentials")
  }
  return new URL(reactAppOpenPath(slug, innerPath), base.origin).href
}

export function appDevPath(slug: string) {
  return `${appDetailsPath(slug)}/dev`
}

/** Collaboration-gated membership and invite management, separate from the public contributor roster. */
export function appMembersPath(slug: string) {
  return `${appDetailsPath(slug)}/members`
}

export function appDevSessionPath(slug: string, sessionId: number | string) {
  return `${appDevPath(slug)}/sessions/${encodeURIComponent(sessionId)}`
}

/** Public discussion for a currently shared session; private Dev chat stays owner-scoped. */
export function appDevSharedSessionPath(slug: string, sessionId: number | string) {
  return `${appDevPath(slug)}/shared/${encodeURIComponent(sessionId)}`
}

/** General app discussion, distinct from scoped session/issue/governance threads. */
export function appDevChatPath(slug: string) {
  return `${appDevPath(slug)}/chat`
}

export function leaderboardUserPath(username: string, window: "all" | "week" = "all") {
  return `/community/leaderboard/users/${encodeURIComponent(username)}?window=${window}`
}

/** Private signed-in give-side ledger. The original #leaderboard/history hash remains available during migration. */
export function leaderboardHistoryPath() {
  return "/community/leaderboard/history"
}

/** Read-only Fair Rewards challenge detail. Challenge CTAs remain legacy-owned. */
export function challengeDetailPath(challengeId: number | string) {
  return `/community/challenges/${encodeURIComponent(String(challengeId))}`
}

/** Read-only Fair Rewards season history home. */
export function challengesPath() {
  return "/community/challenges"
}

/** Read-only detail route. Voting and other proposal actions stay in legacy Dev. */
export function appDevProposalPath(slug: string, proposalId: number | string) {
  return `${appDevPath(slug)}/proposals/${encodeURIComponent(proposalId)}`
}

/**
 * Governance is intentionally separate from GitHub issues: this identifier is
 * a platform governance-proposal id, not an issue number.
 */
export function appDevGovernancePath(slug: string, governanceId: number | string) {
  return `${appDevPath(slug)}/governance/${encodeURIComponent(governanceId)}`
}

/** GitHub issue number, deliberately distinct from governance-proposal ids. */
export function appDevGitHubIssuePath(slug: string, issueNumber: number | string) {
  return `${appDevPath(slug)}/issues/${encodeURIComponent(issueNumber)}`
}
