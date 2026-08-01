export type ChallengeSeason = {
  id?: number
  season_id?: number
  name?: string
  is_active?: boolean
  starts_at?: string
  ends_at?: string
}

/**
 * The backend deliberately leaves metric kinds open-ended. Keep the original
 * wire value as well as the known set so a new kind remains state-only rather
 * than making the feed lie about its progress treatment.
 */
export type ChallengeMetric = {
  kind?: string
  label?: string
  target?: number
}

export type Challenge = {
  id: number
  event_id?: number
  event_name?: string
  event_type?: string
  goal?: string
  task?: string
  category?: string
  reward?: string
  description?: string
  requirements?: string
  reward_logic?: string
  cta_label?: string
  cta_type?: string
  cta_link?: string
  schedule_start?: string
  schedule_end?: string
  featured?: boolean
  featured_order?: number
  enabled?: boolean
  completed?: boolean
  display_order?: number
  metric?: ChallengeMetric
}

export type ChallengeProgressState =
  | "none"
  | "in_progress"
  | "pending"
  | "earned"
  | "completed"
  | "missed"
  | "declined"
  | "unknown"

/**
 * Participant-specific data served by `/challenges-api/me/breakdown`.
 * `event_id` is attached while normalizing nested payloads, which prevents
 * same-id challenges from different events being accidentally merged by UI.
 */
export type ChallengeProgress = {
  challenge_id: number
  state: ChallengeProgressState
  raw_state?: string
  current?: number
  target?: number
  pending_points?: number
  earned_points?: number
  description?: string
  event_id?: number
}

export type ChallengeLeaderboardEntry = {
  rank: number
  display_name?: string
  participant_id?: number
  user_id?: number
  total_points?: number
}

export type ChallengeSnapshot = {
  season: ChallengeSeason | null
  challenges: Challenge[]
  entries: ChallengeLeaderboardEntry[]
  /** Empty when no participant ID was supplied or a read-only breakdown fails. */
  challengeProgress: ChallengeProgress[]
  /** Season-scoped participant points from the already-loaded breakdown. */
  seasonPoints?: number
}

export type ChallengeSnapshotOptions = {
  /**
   * Optional native-bridge-owned identity. This adapter never attempts to
   * infer it from the session; callers may omit it for public challenge feeds.
   */
  participantId?: number
  /** Detail routes opt into season-wide lookup so completed deep links survive. */
  includeInactive?: boolean
  signal?: AbortSignal
}

export type ChallengeBreakdownEvent = {
  event_id?: number
  event?: { id?: number }
  challenge_progress?: unknown
  total_points?: number | string
}

export type ChallengeBreakdown = {
  scope?: string
  challenge_progress?: unknown
  total_points?: number | string
  event_id?: number
  event?: { id?: number }
  events?: ChallengeBreakdownEvent[]
  seasons?: Array<{ events?: ChallengeBreakdownEvent[] }>
}

export type ChallengeSnapshotPayload = {
  season: ChallengeSeason | null
  challenges: Challenge[]
  leaderboard?: { leaderboard?: ChallengeLeaderboardEntry[]; entries?: ChallengeLeaderboardEntry[] }
  breakdown?: ChallengeBreakdown | null
}

const knownProgressStates = new Set<Exclude<ChallengeProgressState, "unknown">>([
  "none",
  "in_progress",
  "pending",
  "earned",
  "completed",
  "missed",
  "declined",
])

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function normalizeProgressState(value: unknown): Pick<ChallengeProgress, "state" | "raw_state"> {
  const raw = typeof value === "string" ? value : undefined
  const normalized = raw?.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (normalized && knownProgressStates.has(normalized as Exclude<ChallengeProgressState, "unknown">)) {
    return { state: normalized as Exclude<ChallengeProgressState, "unknown">, ...(raw === normalized ? {} : { raw_state: raw }) }
  }
  return { state: "unknown", ...(raw ? { raw_state: raw } : {}) }
}

/**
 * Accepts the live Board shape and compact Widgetbook/fixture shapes. Invalid
 * entries are omitted, while unknown state and metric values stay visible to
 * a future presentation layer instead of being coerced to "not started".
 */
export function normalizeChallengeProgress(raw: unknown, eventId?: number): ChallengeProgress[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const value = item as Record<string, unknown>
    const challengeId = asNumber(value.challenge_id)
    if (challengeId === undefined) return []
    const state = normalizeProgressState(value.state)
    const current = asNumber(value.current)
    const target = asNumber(value.target)
    const pendingPoints = asNumber(value.pending_points)
    const earnedPoints = asNumber(value.earned_points)
    const description = typeof value.description === "string" ? value.description : undefined
    return [{
      challenge_id: challengeId,
      ...state,
      ...(current === undefined ? {} : { current }),
      ...(target === undefined ? {} : { target }),
      ...(pendingPoints === undefined ? {} : { pending_points: pendingPoints }),
      ...(earnedPoints === undefined ? {} : { earned_points: earnedPoints }),
      ...(description === undefined ? {} : { description }),
      ...(eventId === undefined ? {} : { event_id: eventId }),
    }]
  })
}

/** Normalizes event, season, global, and legacy top-level progress rails. */
export function collectChallengeProgress(breakdown: ChallengeBreakdown | null | undefined): ChallengeProgress[] {
  if (!breakdown) return []
  const eventId = breakdown.event?.id ?? breakdown.event_id
  const progress = normalizeChallengeProgress(breakdown.challenge_progress, eventId)
  const appendEvent = (event: ChallengeBreakdownEvent) => (
    normalizeChallengeProgress(event.challenge_progress, event.event?.id ?? event.event_id)
  )
  return [
    ...progress,
    ...(breakdown.events?.flatMap(appendEvent) || []),
    ...(breakdown.seasons?.flatMap((season) => season.events?.flatMap(appendEvent) || []) || []),
  ]
}

/** Keeps the anchor on the same season breakdown already used for progress. */
export function challengeSeasonPoints(breakdown: ChallengeBreakdown | null | undefined): number | undefined {
  if (!breakdown) return undefined
  const direct = asNumber(breakdown.total_points)
  if (direct !== undefined) return direct
  if (breakdown.scope !== "season" || !breakdown.events) return undefined
  const eventTotals = breakdown.events.flatMap((event) => {
    const total = asNumber(event.total_points)
    return total === undefined ? [] : [total]
  })
  if (!eventTotals.length) return undefined
  return eventTotals.reduce((total, points) => total + points, 0)
}

/**
 * Keeps the API-to-presentation boundary fixture-testable without coupling it
 * to a live session or component. This is the production normalization path.
 */
export function normalizeChallengeSnapshot(payload: ChallengeSnapshotPayload): ChallengeSnapshot {
  return {
    season: payload.season,
    challenges: payload.challenges,
    entries: payload.leaderboard?.leaderboard || payload.leaderboard?.entries || [],
    challengeProgress: collectChallengeProgress(payload.breakdown),
    seasonPoints: challengeSeasonPoints(payload.breakdown),
  }
}

async function requestChallenge<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", signal })
  if (!response.ok) throw new Error(`Request failed (${response.status})`)
  const body = await response.json() as T | { success?: boolean; data?: T }
  if (typeof body === "object" && body !== null && "success" in body) {
    if (body.success === false) throw new Error("Challenge service unavailable")
    return body.data as T
  }
  return body as T
}

function resolveOptions(optionsOrSignal?: ChallengeSnapshotOptions | AbortSignal): ChallengeSnapshotOptions {
  if (optionsOrSignal && typeof optionsOrSignal === "object" && "aborted" in optionsOrSignal) {
    return { signal: optionsOrSignal as AbortSignal }
  }
  return optionsOrSignal || {}
}

/**
 * Read-only challenge data. Existing callers may pass an AbortSignal directly;
 * new native-aware callers can pass the bridge-supplied participant ID to add
 * activity/progress enrichment. No identity endpoint or mutation is involved.
 */
export async function getChallengeSnapshot(optionsOrSignal?: ChallengeSnapshotOptions | AbortSignal): Promise<ChallengeSnapshot> {
  const { participantId, includeInactive = false, signal } = resolveOptions(optionsOrSignal)
  const seasonsRaw = await requestChallenge<ChallengeSeason[] | { seasons?: ChallengeSeason[] }>("/challenges-api/seasons", signal)
  const seasons = Array.isArray(seasonsRaw) ? seasonsRaw : seasonsRaw.seasons || []
  const season = seasons.find((item) => item.is_active) || seasons.at(-1) || null
  const id = season?.season_id ?? season?.id
  if (id === undefined) return normalizeChallengeSnapshot({ season, challenges: [] })

  const participantQuery = participantId === undefined ? "" : `&participant_id=${encodeURIComponent(String(participantId))}`
  const challengePath = `/challenges-api/challenges?season_id=${id}&active_only=1${participantQuery}`
  const [activeChallenges, leaderboard, breakdown] = await Promise.all([
    requestChallenge<Challenge[]>(challengePath, signal),
    requestChallenge<{ leaderboard?: ChallengeLeaderboardEntry[]; entries?: ChallengeLeaderboardEntry[] }>(`/challenges-api/leaderboard?season_id=${id}&page=1&per_page=20`, signal)
      .catch((): { leaderboard?: ChallengeLeaderboardEntry[]; entries?: ChallengeLeaderboardEntry[] } => ({})),
    participantId === undefined
      ? Promise.resolve(null)
      : requestChallenge<ChallengeBreakdown>(`/challenges-api/me/breakdown?participant_id=${encodeURIComponent(String(participantId))}&include_activity=1&season_id=${id}`, signal)
        .catch(() => null),
  ])
  const challenges = includeInactive
    ? await requestChallenge<Challenge[]>(`/challenges-api/challenges?season_id=${id}${participantQuery}`, signal).catch(() => activeChallenges)
    : activeChallenges.length
      ? activeChallenges
      : await requestChallenge<Challenge[]>(`/challenges-api/challenges?season_id=${id}${participantQuery}`, signal).catch(() => [])
  return normalizeChallengeSnapshot({ season, challenges, leaderboard, breakdown })
}
