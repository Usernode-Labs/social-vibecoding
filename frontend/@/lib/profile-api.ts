import { collectChallengeProgress, type Challenge, type ChallengeBreakdown, type ChallengeProgress, type ChallengeSeason } from "@/lib/challenges-api"

export type ProfileRanking = {
  total_points?: number
  rank?: number
  total_participants?: number
  season_name?: string
  total_tokens?: number
  terms_accepted?: boolean
}

type Season = ChallengeSeason

export type ProfileChallengeHistoryItem = {
  challenge: Challenge
  seasonId: number
  seasonName?: string
  progress: ChallengeProgress
}

async function requestJson<T>(path: string, signal?: AbortSignal) {
  const response = await fetch(path, { credentials: "same-origin", signal })
  if (!response.ok) throw new Error(`Request failed (${response.status})`)
  const payload = await response.json() as T | { success?: boolean; data?: T }
  if (typeof payload === "object" && payload !== null && "success" in payload) {
    if (payload.success === false) throw new Error("Challenge service unavailable")
    return payload.data as T
  }
  return payload as T
}

export async function getProfileRanking(participantId: number, signal?: AbortSignal) {
  const seasonsResponse = await requestJson<Season[] | { seasons?: Season[] }>("/challenges-api/seasons", signal)
  const seasons = Array.isArray(seasonsResponse) ? seasonsResponse : seasonsResponse.seasons || []
  const active = seasons.find((season) => season.is_active) || seasons.at(-1)
  const seasonId = active?.season_id ?? active?.id
  const suffix = seasonId === undefined ? "" : `&season_id=${encodeURIComponent(String(seasonId))}`
  const ranking = await requestJson<ProfileRanking>(`/challenges-api/me/ranking?participant_id=${encodeURIComponent(String(participantId))}${suffix}`, signal)
  return { ranking, seasonName: active?.name }
}

/**
 * Returns completed participant challenges from every season exposed by the
 * existing public read API. A participant ID must come from the native bridge;
 * this function never derives or registers one. A challenge only enters the
 * history when its participant-specific progress says it was earned/completed
 * (or reports earned points), rather than because a campaign is now over.
 */
export async function getProfileChallengeHistory(participantId: number, signal?: AbortSignal): Promise<ProfileChallengeHistoryItem[]> {
  const seasonsResponse = await requestJson<Season[] | { seasons?: Season[] }>("/challenges-api/seasons", signal)
  const seasons = Array.isArray(seasonsResponse) ? seasonsResponse : seasonsResponse.seasons || []
  const usableSeasons = seasons.flatMap((season) => {
    const seasonId = season.season_id ?? season.id
    return seasonId === undefined ? [] : [{ ...season, seasonId }]
  })

  const seasonRows = await Promise.all(usableSeasons.map(async (season) => {
    const query = `participant_id=${encodeURIComponent(String(participantId))}&season_id=${encodeURIComponent(String(season.seasonId))}`
    const [challenges, breakdown] = await Promise.all([
      requestJson<Challenge[]>(`/challenges-api/challenges?season_id=${encodeURIComponent(String(season.seasonId))}&participant_id=${encodeURIComponent(String(participantId))}`, signal),
      requestJson<ChallengeBreakdown>(`/challenges-api/me/breakdown?${query}&include_activity=1`, signal),
    ])
    const progress = collectChallengeProgress(breakdown)
    return { season, challenges, progress }
  }))

  return seasonRows.flatMap(({ season, challenges, progress }) => challenges.flatMap((challenge) => {
    const itemProgress = progress.find((candidate) => candidate.challenge_id === challenge.id && (candidate.event_id === undefined || candidate.event_id === challenge.event_id))
    if (!itemProgress || (itemProgress.state !== "earned" && itemProgress.state !== "completed" && !(itemProgress.earned_points && itemProgress.earned_points > 0))) return []
    return [{ challenge, seasonId: season.seasonId, seasonName: season.name, progress: itemProgress }]
  })).sort((a, b) => {
    const aDate = Date.parse(a.challenge.schedule_end || a.challenge.schedule_start || "") || 0
    const bDate = Date.parse(b.challenge.schedule_end || b.challenge.schedule_start || "") || 0
    return bDate - aDate
  })
}
