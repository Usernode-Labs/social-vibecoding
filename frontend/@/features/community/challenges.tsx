import type { CSSProperties } from "react"
import { Award, CheckCircle2 } from "lucide-react"
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"

import { PageHeader } from "@/components/page-header"
import { PlatformIcon } from "@/components/platform-icon"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { getChallengeSnapshot, type Challenge, type ChallengeSnapshot } from "@/lib/challenges-api"
import { getNativeProfileInfo } from "@/lib/native-bridge"
import { challengeDetailPath } from "@/lib/routes"

const pointsFormatter = new Intl.NumberFormat()
const metricFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

type ChallengeProgress = {
  state?: string
  description?: string
  current?: number
  target?: number
  earned_points?: number
  pending_points?: number
}

/**
 * The challenges service is being widened independently. This narrow adapter
 * keeps the feed tolerant of the existing flat response and the richer Fair
 * Rewards presentation fields, without putting parsing or API calls in UI.
 */
type ChallengeFeedItem = Challenge & {
  schedule_end?: string
  ends_at?: string
  deadline?: string
  featured_order?: number
  state?: string
  reward_state?: string
  current?: number
  target?: number
  earned_points?: number
  pending_points?: number
  metric?: { kind?: string; label?: string; target?: number }
  challenge_progress?: ChallengeProgress
  progress?: ChallengeProgress
}

type ChallengePhase = "open" | "in-progress" | "pending" | "completed" | "missed"
type ChallengeBandName = "Featured" | "Today" | "This week" | "Season"

type ChallengeCardModel = {
  item: ChallengeFeedItem
  phase: ChallengePhase
  progress?: { current: number; target: number; label?: string }
  band: ChallengeBandName
}

type ChallengeBand = {
  name: ChallengeBandName
  deadline?: string
  cards: ChallengeCardModel[]
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function readProgress(item: ChallengeFeedItem) {
  return item.challenge_progress ?? item.progress
}

function challengePhase(item: ChallengeFeedItem): ChallengePhase {
  const progress = readProgress(item)
  const state = (progress?.state ?? item.reward_state ?? item.state ?? "").toLowerCase()
  const earned = numberValue(progress?.earned_points) ?? numberValue(item.earned_points) ?? 0
  const pending = numberValue(progress?.pending_points) ?? numberValue(item.pending_points) ?? 0

  if (item.completed || state === "earned" || state === "completed" || earned > 0) return "completed"
  if (state === "pending" || state === "submitted" || pending > 0) return "pending"
  if (state === "missed" || state === "declined" || state === "expired") return "missed"
  if (state === "in_progress" || state === "in-progress" || (numberValue(progress?.current) ?? numberValue(item.current) ?? 0) > 0) return "in-progress"
  return "open"
}

function metricProgress(item: ChallengeFeedItem) {
  const progress = readProgress(item)
  const current = numberValue(progress?.current) ?? numberValue(item.current)
  const kind = item.metric?.kind?.toLowerCase()
  const target = numberValue(progress?.target) ?? numberValue(item.target) ?? numberValue(item.metric?.target) ?? (kind === "percentage" && current !== undefined ? 100 : undefined)

  // Binary, rank, and unknown metrics deliberately have no made-up fill.
  if ((kind && !["count", "sum", "percentage"].includes(kind)) || target === undefined || target <= 0 || current === undefined) return undefined
  return { current: Math.max(0, Math.min(current, target)), target, label: item.metric?.label }
}

function scheduleEnd(item: ChallengeFeedItem) {
  const raw = item.ends_at ?? item.schedule_end ?? item.deadline
  if (!raw) return undefined
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

function classifyBand(item: ChallengeFeedItem, now: Date): ChallengeBandName {
  if (item.featured) return "Featured"
  const end = scheduleEnd(item)
  if (!end || end.getTime() <= now.getTime()) return "Season"
  const remaining = end.getTime() - now.getTime()
  if (remaining <= 24 * 60 * 60 * 1000) return "Today"
  if (remaining <= 7 * 24 * 60 * 60 * 1000) return "This week"
  return "Season"
}

function deadlineText(items: ChallengeCardModel[], now: Date) {
  const next = items
    .map(({ item }) => scheduleEnd(item))
    .filter((date): date is Date => Boolean(date && date.getTime() > now.getTime()))
    .sort((a, b) => a.getTime() - b.getTime())[0]
  if (!next) return undefined
  const hours = Math.ceil((next.getTime() - now.getTime()) / (60 * 60 * 1000))
  return hours < 24 ? `${hours}h left` : `${Math.ceil(hours / 24)}d left`
}

function buildChallengeBands(items: ChallengeFeedItem[], now = new Date()): ChallengeBand[] {
  const priority: ChallengeBandName[] = ["Featured", "Today", "This week", "Season"]
  const grouped = new Map<ChallengeBandName, ChallengeCardModel[]>()
  for (const item of items.filter(({ enabled }) => enabled !== false)) {
    const band = classifyBand(item, now)
    const card = { item, phase: challengePhase(item), progress: metricProgress(item), band }
    grouped.set(band, [...(grouped.get(band) ?? []), card])
  }

  return priority.flatMap((name) => {
    const cards = grouped.get(name)
    if (!cards?.length) return []
    cards.sort((a, b) => {
      const completion = Number(a.phase === "completed") - Number(b.phase === "completed")
      if (completion) return completion
      if (name === "Featured") return (a.item.featured_order ?? a.item.display_order ?? 0) - (b.item.featured_order ?? b.item.display_order ?? 0)
      return (a.item.display_order ?? 0) - (b.item.display_order ?? 0)
    })
    return [{ name, cards, deadline: name === "Featured" ? undefined : deadlineText(cards, now) }]
  })
}

function formatPoints(value: number) {
  return `${pointsFormatter.format(value)} pts`
}

function rewardText(item: ChallengeFeedItem, phase: ChallengePhase) {
  const progress = readProgress(item)
  const earned = numberValue(progress?.earned_points) ?? numberValue(item.earned_points) ?? 0
  const pending = numberValue(progress?.pending_points) ?? numberValue(item.pending_points) ?? 0
  if (phase === "completed" && earned > 0) return `Completed ${formatPoints(earned)}`
  if (phase === "pending" && pending > 0) return `Pending ${formatPoints(pending)}`
  return item.reward ? `Reward ${item.reward}` : "Reward pending"
}

function phaseCopy(item: ChallengeFeedItem, phase: ChallengePhase, progress?: ChallengeCardModel["progress"]) {
  if (progress) return `${formatMetric(progress.current)} / ${formatMetric(progress.target)}${progress.label ? ` ${progress.label}` : ""}`
  const description = readProgress(item)?.description
  if (description && phase !== "open") return description
  return phase === "completed" ? "Completed" : phase === "pending" ? "Submitted — awaiting review" : phase === "missed" ? "No longer available" : phase === "in-progress" ? "In progress" : "Not done"
}

function formatMetric(value: number) {
  return Number.isInteger(value) ? pointsFormatter.format(value) : metricFormatter.format(value)
}

function ChallengeCard({ card }: { card: ChallengeCardModel }) {
  const { item, phase, progress } = card
  const fill = progress ? Math.round((progress.current / progress.target) * 100) : undefined
  const title = item.goal || item.task || "Challenge"
  const status = phaseCopy(item, phase, progress)

  // Mirrors the mobile AtomicChallengeCard contract from Flutter PR #463:
  // one earning mechanic, title, and one truthful progress/reward rail. No
  // category, task prose, badge, or action competes with the detail screen.
  return <Card className="relative" data-testid={`challenge-card-${item.id}`}>
    <CardContent className="p-4">
      <Link aria-label={`${title}, ${status}, ${rewardText(item, phase)}`} className="block space-y-2 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" to={challengeDetailPath(item.id)}>
        <h4 className="text-balance text-base font-medium sm:text-sm">{title}</h4>
        <div aria-label={`${title} progress`} aria-valuemax={progress?.target} aria-valuemin={0} aria-valuenow={progress?.current} className="relative isolate flex h-12 overflow-hidden rounded-md bg-muted" role="progressbar">
          {fill !== undefined && phase === "in-progress" ? <div aria-hidden="true" className="absolute bottom-0 left-0 h-1 bg-primary" style={{ "--challenge-fill": `${fill}%`, width: "var(--challenge-fill)" } as CSSProperties} /> : null}
          <div className="relative z-10 flex min-w-0 flex-1 items-center justify-between gap-3 px-3 text-base/7 sm:text-sm/6">
            <span className="min-w-0 truncate">{phase === "completed" ? <><PlatformIcon className="mr-1 inline-block align-text-bottom" icon={CheckCircle2} size="sm" />{status}</> : status}</span>
            <span className="shrink-0 font-medium tabular-nums">{rewardText(item, phase)}</span>
          </div>
        </div>
      </Link>
    </CardContent>
  </Card>
}

/** Named, deterministic presentation surface for route and Storybook evidence. */
function attachProgress(snapshot: ChallengeSnapshot) {
  return snapshot.challenges.map((challenge) => {
    const item = challenge as ChallengeFeedItem
    const progress = snapshot.challengeProgress.find((candidate) => (
      candidate.challenge_id === item.id
      && (item.event_id === undefined || candidate.event_id === undefined || candidate.event_id === item.event_id)
    ))
    return progress ? { ...item, challenge_progress: progress } : item
  })
}

export function ChallengeFeed({ snapshot, now = new Date() }: { snapshot: ChallengeSnapshot; now?: Date }) {
  const bands = buildChallengeBands(attachProgress(snapshot), now)
  if (!bands.length) return <Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={Award} /></EmptyMedia><EmptyTitle>No active challenges</EmptyTitle><EmptyDescription>Season challenges will appear here when they open.</EmptyDescription></EmptyHeader></Empty>

  return <div className="space-y-8">
    {bands.map((band) => <section aria-labelledby={`challenge-band-${band.name.toLowerCase().replaceAll(" ", "-")}`} className="space-y-3" key={band.name}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-balance text-xl font-semibold" id={`challenge-band-${band.name.toLowerCase().replaceAll(" ", "-")}`}>{band.name}</h3>
        {band.deadline ? <p className="shrink-0 text-base/7 text-muted-foreground sm:text-sm/6">{band.deadline}</p> : null}
      </div>
      <div className="flex flex-col gap-3">
        {band.cards.map((card) => <ChallengeCard card={card} key={card.item.id} />)}
      </div>
    </section>)}
  </div>
}

export function Challenges() {
  const [data, setData] = useState<ChallengeSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    void getNativeProfileInfo()
      .then((profile) => getChallengeSnapshot({ participantId: profile?.participantId ?? undefined, signal: controller.signal }))
      .then((snapshot) => { if (!cancelled) setData(snapshot) })
      .catch((cause: unknown) => {
        if (!cancelled && !(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : "Unable to load challenges")
      })
    return () => { cancelled = true; controller.abort() }
  }, [])

  return <div className="isolate flex w-full flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6" data-testid="challenges">
    <PageHeader title={data?.season?.name || "Challenges"} />
    {error ? <Alert variant="destructive"><AlertTitle>Challenges unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    {!data && !error ? <div className="space-y-3"><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /></div> : null}
    {data ? <ChallengeFeed snapshot={data} /> : null}
    {data?.entries.length ? <section className="space-y-3"><h3 className="text-xl font-semibold">Season leaderboard</h3>{data.entries.map((entry) => <Card key={entry.rank} size="sm"><CardHeader className="grid-cols-[auto_1fr_auto] gap-3"><span className="tabular-nums text-muted-foreground">#{entry.rank}</span><CardTitle>{entry.display_name || `Participant ${entry.participant_id}`}</CardTitle><Badge><PlatformIcon data-icon="inline-start" icon={Award} size="xs" />{pointsFormatter.format(Number(entry.total_points || 0))}</Badge></CardHeader></Card>)}</section> : null}
  </div>
}
