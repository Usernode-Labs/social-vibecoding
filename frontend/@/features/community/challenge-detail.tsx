import { ArrowLeft, Award, CalendarClock, CheckCircle2, CircleDashed, Clock3, ExternalLink, Gift, ShieldCheck, XCircle } from "lucide-react"
import { useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { PlatformIcon } from "@/components/platform-icon"
import { getChallengeSnapshot, type Challenge, type ChallengeProgress, type ChallengeSnapshot } from "@/lib/challenges-api"
import { getNativeProfileInfo } from "@/lib/native-bridge"

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

function phase(challenge: Challenge, progress?: ChallengeProgress) {
  if (challenge.completed || progress?.state === "earned") return "completed" as const
  if (progress?.state === "pending") return "pending" as const
  if (progress?.state === "missed" || progress?.state === "declined") return "missed" as const
  if (progress?.state === "in_progress" || (progress?.current ?? 0) > 0) return "in-progress" as const
  return "open" as const
}

function Status({ challenge, progress }: { challenge: Challenge; progress?: ChallengeProgress }) {
  const value = phase(challenge, progress)
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
  return <Card className="bg-muted/30"><CardHeader className="gap-2"><div className="flex flex-wrap items-center gap-2"><Badge variant={detail.variant}><PlatformIcon data-icon="inline-start" icon={detail.icon} size="xs" />{detail.label}</Badge>{challenge.category ? <Badge variant="outline">{challenge.category}</Badge> : null}</div><CardDescription className="text-sm">{label}</CardDescription></CardHeader>{current !== undefined ? <CardContent><div aria-label="Challenge progress" aria-valuemax={target} aria-valuemin={0} aria-valuenow={current} className="h-2 overflow-hidden rounded-full bg-border" role="progressbar"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(current / target! * 100)}%` }} /></div></CardContent> : null}</Card>
}

function format(value: number) { return Number.isInteger(value) ? new Intl.NumberFormat().format(value) : value.toLocaleString(undefined, { maximumFractionDigits: 2 }) }

export function ChallengeDetailContent({ challenge, progress, native, season }: { challenge: Challenge; progress?: ChallengeProgress; native: boolean; season?: string }) {
  const title = challenge.goal || challenge.task || "Challenge"
  const task = challenge.task && challenge.task !== title ? challenge.task : undefined
  return <main className="isolate mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6" data-testid="challenge-detail">
    <Button className="w-fit" render={<Link to="/community/challenges" />} variant="ghost"><PlatformIcon data-icon="inline-start" icon={ArrowLeft} />All challenges</Button>
    <header className="space-y-3"><div className="flex flex-wrap items-center gap-2">{season ? <Badge variant="outline">{season}</Badge> : null}<Badge variant="secondary"><PlatformIcon data-icon="inline-start" icon={native ? ShieldCheck : CalendarClock} size="xs" />{native ? "Personal progress available" : "Public challenge data"}</Badge></div><h2 className="text-balance text-3xl font-semibold tracking-tight">{title}</h2>{task ? <p className="max-w-[65ch] text-pretty text-base/7 text-muted-foreground sm:text-sm/6">{task}</p> : null}</header>
    <Status challenge={challenge} progress={progress} />
    <section aria-labelledby="challenge-details" className="space-y-3"><h3 className="text-xl font-semibold" id="challenge-details">Challenge details</h3><Card><CardContent className="space-y-5 pt-6">{challenge.description ? <Detail label="Description" value={challenge.description} /> : null}{challenge.requirements ? <Detail label="Requirements" value={challenge.requirements} /> : null}{challenge.reward ? <Detail icon={Gift} label="Reward" value={challenge.reward} /> : null}{challenge.reward_logic ? <Detail icon={Award} label="Reward logic" value={challenge.reward_logic} /> : null}{!challenge.description && !challenge.requirements && !challenge.reward && !challenge.reward_logic ? <p className="text-sm text-muted-foreground">Challenge details will be added by the season organizer.</p> : null}</CardContent></Card></section>
    {challenge.cta_link ? <Alert><PlatformIcon icon={ExternalLink} /><AlertTitle>Continue with the existing challenge action</AlertTitle><AlertDescription className="flex flex-wrap items-center gap-3">This React view is read-only. The action below remains managed by the established challenge flow.<Button render={<a href={challenge.cta_link} rel="noreferrer" target="_self" />} size="sm" variant="outline">{challenge.cta_label || "Open challenge action"}<PlatformIcon data-icon="inline-end" icon={ExternalLink} size="sm" /></Button></AlertDescription></Alert> : null}
  </main>
}

function Detail({ label, value, icon: Icon }: { label: string; value: string; icon?: typeof Award }) { return <div className="space-y-1.5"><h4 className="flex items-center gap-2 text-sm font-medium">{Icon ? <PlatformIcon icon={Icon} size="sm" /> : null}{label}</h4><p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{value}</p></div> }

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
  if (state.kind === "loading") return <main className="isolate mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-8 sm:px-6" data-testid="challenge-detail-loading"><Skeleton className="h-8 w-36" /><Skeleton className="h-12 w-3/4" /><Skeleton className="h-36 w-full" /></main>
  if (state.kind === "error") return <main className="mx-auto flex w-full max-w-3xl flex-1 p-6" data-testid="challenge-detail-error"><Alert variant="destructive"><AlertTitle>Challenge unavailable</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert></main>
  if (state.kind === "not-found") return <main className="flex flex-1 items-center justify-center p-6" data-testid="challenge-detail-not-found"><Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={CalendarClock} /></EmptyMedia><EmptyTitle>Challenge not found</EmptyTitle><EmptyDescription>This challenge may have ended or is not available in the current season.</EmptyDescription></EmptyHeader><EmptyContent><Button render={<Link to="/community/challenges" />} variant="outline"><PlatformIcon data-icon="inline-start" icon={ArrowLeft} />All challenges</Button></EmptyContent></Empty></main>
  return <ChallengeDetailContent challenge={state.challenge} native={state.native} progress={state.progress} season={state.snapshot.season?.name} />
}
