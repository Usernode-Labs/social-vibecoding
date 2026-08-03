import { ArrowRight, Award, CalendarClock, CheckCircle2, CircleDashed, Clock3, ExternalLink, Gift, ShieldCheck, XCircle } from "lucide-react"
import { useEffect, useState } from "react"
import { useParams } from "react-router-dom"

import { ActionAnchor, ActionLink } from "@/components/action-link"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { TopBar } from "@/components/top-bar"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { PlatformIcon } from "@/components/platform-icon"
import { getChallengeSnapshot, type Challenge, type ChallengeProgress, type ChallengeSnapshot } from "@/lib/challenges-api"
import { challengePhase, type ChallengeLifecycleSource } from "@/lib/challenge-lifecycle"
import { getNativeProfileInfo } from "@/lib/native-bridge"
import { challengesPath } from "@/lib/routes"

type DetailState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "not-found" }
  | { kind: "ready"; snapshot: ChallengeSnapshot; challenge: Challenge; progress?: ChallengeProgress; native: boolean }

function asNumber(value: string | undefined) {
  if (!value?.trim()) return undefined
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : undefined
}

function progressFor(snapshot: ChallengeSnapshot, challenge: Challenge) {
  const matches = snapshot.challengeProgress.filter((candidate) => candidate.challenge_id === challenge.id)
  if (challenge.event_id !== undefined) {
    return matches.find((candidate) => candidate.event_id === challenge.event_id)
      ?? (matches.length === 1 && matches[0].event_id === undefined ? matches[0] : undefined)
  }
  return matches.length === 1 ? matches[0] : matches.find((candidate) => candidate.event_id === undefined)
}

function Status({ challenge, progress }: { challenge: Challenge; progress?: ChallengeProgress }) {
  const value = challengePhase(challenge, progress)
  const detail = {
    open: { label: "Open", icon: CircleDashed, variant: "outline" as const, copy: "Not started" },
    "in-progress": { label: "In progress", icon: CircleDashed, variant: "secondary" as const, copy: "Progress is being tracked" },
    pending: { label: "Pending", icon: Clock3, variant: "secondary" as const, copy: "Submitted — awaiting review" },
    completed: { label: "Completed", icon: CheckCircle2, variant: "secondary" as const, copy: "Reward earned" },
    missed: { label: "Missed", icon: XCircle, variant: "outline" as const, copy: "No longer available" },
  }[value]
  const target = progress?.target ?? challenge.metric?.target
  const showProgress = typeof progress?.current === "number" && typeof target === "number" && target > 0 && ["count", "sum", "percentage"].includes(challenge.metric?.kind?.toLowerCase() ?? "")
  const current = showProgress ? Math.max(0, Math.min(progress!.current!, target!)) : undefined
  const label = current === undefined ? (progress?.description || detail.copy) : `${format(current)} / ${format(target!)}${challenge.metric?.label ? ` ${challenge.metric.label}` : ""}`
  return <Card data-challenge-phase={value}><CardHeader className="gap-2"><div className="flex flex-wrap items-center gap-2"><Badge variant={detail.variant}><PlatformIcon data-icon="inline-start" icon={detail.icon} />{detail.label}</Badge>{challenge.category ? <Badge variant="outline">{challenge.category}</Badge> : null}</div><CardDescription className="text-sm">{label}</CardDescription></CardHeader>{current !== undefined ? <CardContent><div aria-label="Challenge progress" aria-valuemax={target} aria-valuemin={0} aria-valuenow={current} className="h-2 overflow-hidden rounded-full bg-border" role="progressbar"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(current / target! * 100)}%` }} /></div></CardContent> : null}</Card>
}

function earnedPoints(challenge: Challenge, progress?: ChallengeProgress) {
  const flatPoints = (challenge as ChallengeLifecycleSource).earned_points
  const value = progress?.earned_points ?? flatPoints
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function CompletedStatus({ challenge, progress }: { challenge: Challenge; progress?: ChallengeProgress }) {
  const points = earnedPoints(challenge, progress)
  const anchor = points === undefined ? challenge.reward || "Reward confirmed" : format(points)
  const rewardCaption = challenge.reward && challenge.reward !== anchor && !rewardRepeatsPoints(challenge.reward, points) ? challenge.reward : undefined
  return <Card aria-labelledby="challenge-reward-earned" className="status-container shadow-none" data-challenge-phase="completed" data-status-tone="positive" role="region">
    <CardContent className="flex flex-col gap-6 p-6 sm:p-8">
      <div className="flex items-center gap-2 font-medium"><PlatformIcon icon={CheckCircle2} size="sm" />Completed</div>
      <div className="flex flex-col gap-2">
        <p aria-label={points === undefined ? anchor : `${format(points)} points earned`} className="text-4xl font-semibold tracking-tight tabular-nums">{anchor}</p>
        <div className="flex flex-col gap-1">
          <h2 className="text-balance text-xl font-semibold" id="challenge-reward-earned">Reward earned</h2>
          {rewardCaption ? <p className="text-pretty text-base/7 text-current/80 sm:text-sm/6">{rewardCaption}</p> : null}
        </div>
      </div>
      <ActionLink className="w-fit pointer-coarse:min-h-12" size="sm" to={challengesPath()} variant="ghost">View season history<PlatformIcon data-icon="inline-end" icon={ArrowRight} /></ActionLink>
    </CardContent>
  </Card>
}

function rewardRepeatsPoints(reward: string, points: number | undefined) {
  if (points === undefined) return false
  const match = reward.trim().toLowerCase().replaceAll(",", "").match(/^(\d+(?:\.\d+)?)\s*(?:points?|pts?)$/)
  return match ? Number(match[1]) === points : false
}

function format(value: number) { return Number.isInteger(value) ? new Intl.NumberFormat().format(value) : value.toLocaleString(undefined, { maximumFractionDigits: 2 }) }

export function ChallengeDetailContent({ challenge, progress, native, season }: { challenge: Challenge; progress?: ChallengeProgress; native: boolean; season?: string }) {
  const title = challenge.goal || challenge.task || "Challenge"
  const task = challenge.task && challenge.task !== title ? challenge.task : undefined
  const value = challengePhase(challenge, progress)
  const terminal = value === "completed" || value === "missed"
  return <div className="isolate flex w-full flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6" data-testid="challenge-detail">
    <div className="flex flex-wrap items-center gap-2">{season ? <Badge variant="outline">{season}</Badge> : null}<Badge variant="secondary"><PlatformIcon data-icon="inline-start" icon={native ? ShieldCheck : CalendarClock} />{native ? "Personal progress available" : "Public challenge data"}</Badge></div>
    <TopBar title={title} />
    <div className="flex flex-col gap-6" data-testid="challenge-terminal-content">
      {task ? <p className="max-w-[65ch] text-pretty text-base/7 text-muted-foreground sm:text-sm/6">{task}</p> : null}
      {value === "completed" ? <CompletedStatus challenge={challenge} progress={progress} /> : <Status challenge={challenge} progress={progress} />}
      <section aria-labelledby="challenge-details" className="space-y-3"><h2 className="text-xl font-semibold" id="challenge-details">Challenge details</h2><Card><CardContent className="space-y-5 pt-6">{challenge.description ? <Detail label="Description" value={challenge.description} /> : null}{challenge.requirements ? <Detail label="Requirements" value={challenge.requirements} /> : null}{challenge.reward ? <Detail icon={Gift} label="Reward" value={challenge.reward} /> : null}{challenge.reward_logic ? <Detail icon={Award} label="Reward logic" value={challenge.reward_logic} /> : null}{!challenge.description && !challenge.requirements && !challenge.reward && !challenge.reward_logic ? <p className="text-sm text-muted-foreground">Challenge details will be added by the season organizer.</p> : null}</CardContent></Card></section>
      {value === "missed" ? <ActionLink className="w-fit pointer-coarse:min-h-12" size="sm" to={challengesPath()} variant="ghost">View season history<PlatformIcon data-icon="inline-end" icon={ArrowRight} /></ActionLink> : null}
      {challenge.cta_link && !terminal ? <ActionAnchor className="w-fit" href={challenge.cta_link} rel="noreferrer" target="_self">{challenge.cta_label || "Open challenge action"}<PlatformIcon data-icon="inline-end" icon={ExternalLink} /></ActionAnchor> : null}
    </div>
  </div>
}

function Detail({ label, value, icon: Icon }: { label: string; value: string; icon?: typeof Award }) { return <div className="space-y-1.5"><p className="flex items-center gap-2 text-sm font-medium">{Icon ? <PlatformIcon icon={Icon} size="sm" /> : null}{label}</p><p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{value}</p></div> }

export function ChallengeDetail() {
  const challengeId = asNumber(useParams().challengeId)
  const [state, setState] = useState<DetailState>(() => challengeId === undefined ? { kind: "not-found" } : { kind: "loading" })
  useEffect(() => {
    if (challengeId === undefined) return
    const controller = new AbortController()
    let cancelled = false
    void getNativeProfileInfo().then((profile) => ({ participantId: profile?.participantId ?? undefined, native: profile?.participantId !== undefined && profile?.participantId !== null })).then(async ({ participantId, native }) => {
      const snapshot = await getChallengeSnapshot({ participantId, includeInactive: true, signal: controller.signal })
      const challenge = snapshot.challenges.find((item) => item.id === challengeId)
      if (!challenge) return { kind: "not-found" } as DetailState
      return { kind: "ready", snapshot, challenge, progress: progressFor(snapshot, challenge), native } as DetailState
    }).then((next) => { if (!cancelled) setState(next) }).catch((cause: unknown) => { if (!cancelled && !(cause instanceof DOMException && cause.name === "AbortError")) setState({ kind: "error", message: cause instanceof Error ? cause.message : "Unable to load this challenge" }) })
    return () => { cancelled = true; controller.abort() }
  }, [challengeId])
  if (state.kind === "loading") return <div className="isolate flex w-full flex-1 flex-col" data-testid="challenge-detail-loading"><TopBar title="Challenge" /><div className="flex w-full flex-1 flex-col gap-4 px-4 py-4 sm:px-6"><Skeleton className="h-12 w-3/4" /><Skeleton className="h-36 w-full" /></div></div>
  if (state.kind === "error") return <div className="isolate flex w-full flex-1 flex-col" data-testid="challenge-detail-error"><TopBar title="Challenge unavailable" /><div className="flex w-full flex-1 flex-col gap-4 p-6"><Alert variant="destructive"><AlertDescription>{state.message}</AlertDescription></Alert></div></div>
  if (state.kind === "not-found") return <div className="isolate flex w-full flex-1 flex-col" data-testid="challenge-detail-not-found"><TopBar title="Challenge not found" /><div className="flex w-full flex-1 flex-col p-6"><Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={CalendarClock} /></EmptyMedia><EmptyDescription>This challenge may have ended or is not available in the current season.</EmptyDescription></EmptyHeader></Empty></div></div>
  return <ChallengeDetailContent challenge={state.challenge} native={state.native} progress={state.progress} season={state.snapshot.season?.name} />
}
