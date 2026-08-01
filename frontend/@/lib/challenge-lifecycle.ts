import type { Challenge, ChallengeProgress } from "@/lib/challenges-api"

export type ChallengePhase = "open" | "in-progress" | "pending" | "completed" | "missed"

export type ChallengeProgressEvidence = Partial<Omit<ChallengeProgress, "state">> & {
  state?: string
}

/**
 * Presentation evidence tolerated across the flat and nested challenge
 * payloads while the service contract is being widened.
 */
export type ChallengeLifecycleSource = Challenge & {
  state?: string
  reward_state?: string
  current?: number
  target?: number
  earned_points?: number
  pending_points?: number
  challenge_progress?: ChallengeProgressEvidence
  progress?: ChallengeProgressEvidence
}

export function challengeProgressEvidence(challenge: ChallengeLifecycleSource) {
  return challenge.challenge_progress ?? challenge.progress
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function normalizedState(value: unknown) {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : ""
}

function progressState(progress: ChallengeProgressEvidence | undefined) {
  if (!progress) return undefined
  return progress.state === "unknown" && progress.raw_state
    ? progress.raw_state
    : progress.state
}

/**
 * One lifecycle truth for every Challenge surface. The evidence order mirrors
 * the widest live feed contract: participant progress, reward state, then the
 * challenge's flat state. A present progress state deliberately owns the
 * decision even when it is unknown.
 */
export function challengePhase(
  challenge: ChallengeLifecycleSource,
  explicitProgress?: ChallengeProgressEvidence,
): ChallengePhase {
  const progress = explicitProgress ?? challengeProgressEvidence(challenge)
  const state = normalizedState(progressState(progress) ?? challenge.reward_state ?? challenge.state)
  const earned = finiteNumber(progress?.earned_points) ?? finiteNumber(challenge.earned_points) ?? 0
  const pending = finiteNumber(progress?.pending_points) ?? finiteNumber(challenge.pending_points) ?? 0
  const current = finiteNumber(progress?.current) ?? finiteNumber(challenge.current) ?? 0

  if (challenge.completed || state === "earned" || state === "completed" || earned > 0) return "completed"
  if (state === "pending" || state === "submitted" || pending > 0) return "pending"
  if (state === "missed" || state === "declined" || state === "expired") return "missed"
  if (state === "in_progress" || current > 0) return "in-progress"
  return "open"
}
