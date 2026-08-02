import type { CSSProperties } from "react"
import { Award, CheckCircle2, Clock3, Trophy } from "lucide-react"
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"

import { PlatformIcon } from "@/components/platform-icon"
import { TopBar } from "@/components/top-bar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { getChallengeSnapshot, type ChallengeSnapshot } from "@/lib/challenges-api"
import {
  challengePhase,
  challengeProgressEvidence,
  type ChallengeLifecycleSource,
  type ChallengePhase,
} from "@/lib/challenge-lifecycle"
import { getNativeProfileInfo } from "@/lib/native-bridge"
import { challengeDetailPath } from "@/lib/routes"
import { cn } from "@/lib/utils"

const pointsFormatter = new Intl.NumberFormat()
const metricFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })
const seasonEndFormatter = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" })

type ChallengeFeedItem = ChallengeLifecycleSource & {
  schedule_end?: string
  ends_at?: string
  deadline?: string
  featured_order?: number
  metric?: { kind?: string; label?: string; target?: number }
}
type ChallengeBandName = "Featured" | "Today" | "This week" | "Season"

type ChallengeRowModel = {
  item: ChallengeFeedItem
  phase: ChallengePhase
  progress?: { current: number; target: number; label?: string }
  band: ChallengeBandName
}

type ChallengeBand = {
  name: ChallengeBandName
  deadline?: string
  cards: ChallengeRowModel[]
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function metricProgress(item: ChallengeFeedItem) {
  const progress = challengeProgressEvidence(item)
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

function deadlineText(items: ChallengeRowModel[], now: Date) {
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
  const grouped = new Map<ChallengeBandName, ChallengeRowModel[]>()
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
  const progress = challengeProgressEvidence(item)
  const earned = numberValue(progress?.earned_points) ?? numberValue(item.earned_points) ?? 0
  const pending = numberValue(progress?.pending_points) ?? numberValue(item.pending_points) ?? 0
  if (phase === "completed" && earned > 0) return `Completed ${formatPoints(earned)}`
  if (phase === "pending" && pending > 0) return `Pending ${formatPoints(pending)}`
  return item.reward ? item.reward.replace(/\bpoints?\b/gi, "pts") : "Reward pending"
}

function phaseCopy(item: ChallengeFeedItem, phase: ChallengePhase, progress?: ChallengeRowModel["progress"]) {
  if (progress) return `${formatMetric(progress.current)} / ${formatMetric(progress.target)}${progress.label ? ` ${progress.label}` : ""}`
  const description = challengeProgressEvidence(item)?.description
  if (description && phase !== "open") return description
  return phase === "completed" ? "Completed" : phase === "pending" ? "Submitted — awaiting review" : phase === "missed" ? "No longer available" : phase === "in-progress" ? "In progress" : "Not done"
}

function formatMetric(value: number) {
  return Number.isInteger(value) ? pointsFormatter.format(value) : metricFormatter.format(value)
}

function ChallengeRow({ card }: { card: ChallengeRowModel }) {
  const { item, phase, progress } = card
  const fill = progress ? Math.round((progress.current / progress.target) * 100) : undefined
  const title = item.goal || item.task || "Challenge"
  const status = phaseCopy(item, phase, progress)
  const reward = rewardText(item, phase)
  const compactReward = phase === "pending" ? reward.replace(/^Pending\s+/, "") : reward

  // One earning mechanic, one destination, and one truthful progress owner.
  // Instruction and category copy stay on detail so the band remains scannable.
  return <li data-challenge-phase={phase} data-testid={`challenge-card-${item.id}`}>
    <Link
      aria-label={`${title}, ${status}, ${reward}`}
      className={cn(
        "group relative isolate flex min-h-20 min-w-0 items-stretch overflow-hidden outline-none hover:bg-muted/60 focus-visible:z-10 focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/30",
        phase === "completed" && "status-surface hover:bg-[var(--status-surface)]",
      )}
      data-status-tone={phase === "completed" ? "positive" : undefined}
      to={challengeDetailPath(item.id)}
    >
      <div className="relative flex min-w-0 flex-1 items-center gap-3 overflow-hidden px-3 py-3 sm:px-4">
        <span
          aria-label={`${title} progress`}
          aria-valuemax={progress?.target}
          aria-valuemin={0}
          aria-valuenow={progress?.current}
          aria-valuetext={status}
          className="pointer-events-none absolute inset-0 overflow-hidden"
          role="progressbar"
        >
          {fill !== undefined && phase === "in-progress" ? <span aria-hidden="true" className="absolute inset-y-0 left-0 bg-primary/15" data-testid="challenge-progress-fill" style={{ "--challenge-fill": `${fill}%`, width: "var(--challenge-fill)" } as CSSProperties} /> : null}
        </span>
        <PlatformIcon className={cn("relative z-10", phase === "completed" ? "stroke-[var(--status-surface-foreground)]" : "stroke-muted-foreground")} icon={phase === "completed" ? CheckCircle2 : Award} />
        <div className="relative z-10 flex min-w-0 flex-1 flex-col gap-1">
          <h4 className={cn("text-base font-medium sm:text-sm", phase === "pending" ? "break-words sm:truncate" : "truncate")}>{title}</h4>
          <p className={cn("text-base/7 text-muted-foreground sm:text-sm/6", phase === "pending" ? "break-words sm:truncate" : "truncate", phase === "in-progress" && "text-foreground/80", phase === "completed" && "text-current/80")}>{status}</p>
        </div>
      </div>
      <p className={cn("relative z-10 flex shrink-0 items-center pr-3 text-base font-medium text-primary tabular-nums sm:pr-4 sm:text-sm", phase === "completed" && "font-semibold text-current")} data-testid="challenge-reward">
        {phase === "pending" ? <><span className="sm:hidden">{compactReward}</span><span className="max-sm:hidden">{reward}</span></> : reward}
      </p>
    </Link>
  </li>
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
  return <div className="flex flex-col gap-10">
    <SeasonAnchor bands={bands} now={now} snapshot={snapshot} />
    {bands.length ? bands.map((band) => <section aria-labelledby={`challenge-band-${band.name.toLowerCase().replaceAll(" ", "-")}`} className="flex flex-col gap-3" key={band.name}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-balance text-xl font-semibold" id={`challenge-band-${band.name.toLowerCase().replaceAll(" ", "-")}`}>{band.name}</h3>
        {band.deadline ? <p className="shrink-0 text-base/7 text-muted-foreground tabular-nums sm:text-sm/6">{band.deadline}</p> : null}
      </div>
      <ul className="divide-y divide-border/70 overflow-hidden rounded-xl bg-muted/30" role="list">
        {band.cards.map((card) => <ChallengeRow card={card} key={card.item.id} />)}
      </ul>
    </section>) : <Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={Award} /></EmptyMedia><EmptyTitle>No active challenges</EmptyTitle><EmptyDescription>Season challenges will appear here when they open.</EmptyDescription></EmptyHeader></Empty>}
    {snapshot.entries.length ? <SeasonLeaderboard snapshot={snapshot} /> : null}
  </div>
}

function seasonEndText(snapshot: ChallengeSnapshot, now: Date) {
  const raw = snapshot.season?.ends_at
  if (!raw) return "In progress"
  const end = new Date(raw)
  if (Number.isNaN(end.getTime())) return "In progress"
  if (end.getTime() <= now.getTime()) return "Ended"
  return seasonEndFormatter.format(end)
}

function SeasonAnchor({ snapshot, bands, now }: { snapshot: ChallengeSnapshot; bands: ChallengeBand[]; now: Date }) {
  const nextBand = bands.find((band) => band.deadline)
  const window = nextBand ? `${nextBand.name} · ${nextBand.deadline}` : "Season in progress"
  const points = snapshot.seasonPoints

  return <section aria-labelledby="challenge-season-anchor" className="rounded-2xl bg-muted/50 p-5 sm:p-6" data-testid="challenge-season-anchor">
    <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-base text-muted-foreground sm:text-sm">Season points</p>
        <h2 className="text-balance text-5xl font-semibold tracking-tight tabular-nums" id="challenge-season-anchor">{points === undefined ? "—" : pointsFormatter.format(points)}</h2>
        <p className="text-pretty text-base/7 text-muted-foreground sm:text-sm/6">{points === undefined ? "Open Usernode to see your total." : snapshot.season?.name || "Current season"}</p>
      </div>
      <dl className="grid grid-cols-2 gap-6 sm:min-w-72">
        <div className="flex min-w-0 flex-col gap-1">
          <dt className="text-base text-muted-foreground sm:text-sm">Current window</dt>
          <dd className="flex items-center gap-2 text-base font-medium tabular-nums sm:text-sm"><PlatformIcon className="stroke-muted-foreground" icon={Clock3} />{window}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <dt className="text-base text-muted-foreground sm:text-sm">Season ends</dt>
          <dd className="text-base font-medium tabular-nums sm:text-sm">{seasonEndText(snapshot, now)}</dd>
        </div>
      </dl>
    </div>
  </section>
}

function SeasonLeaderboard({ snapshot }: { snapshot: ChallengeSnapshot }) {
  return <section aria-labelledby="season-leaderboard-heading" className="flex flex-col gap-3">
    <h3 className="text-balance text-xl font-semibold" id="season-leaderboard-heading">Season leaderboard</h3>
    <ol className="divide-y divide-border/70" role="list">
      {snapshot.entries.map((entry) => <li className="flex min-h-16 items-center gap-3 px-3 py-3 sm:px-4" data-testid="challenge-leaderboard-row" key={`${entry.rank}-${entry.user_id ?? entry.participant_id ?? entry.display_name}`}>
        <p className="w-8 text-base text-muted-foreground tabular-nums sm:text-sm">#{entry.rank}</p>
        <p className="min-w-0 flex-1 truncate text-base font-medium sm:text-sm">{entry.display_name || ((entry.user_id ?? entry.participant_id) === undefined ? "Participant" : `Participant ${entry.user_id ?? entry.participant_id}`)}</p>
        <div aria-label={`${pointsFormatter.format(Number(entry.total_points || 0))} points`} className="flex shrink-0 items-center gap-2 text-primary">
          <PlatformIcon className="stroke-current" icon={Trophy} />
          <p className="text-lg font-semibold tabular-nums sm:text-base">{pointsFormatter.format(Number(entry.total_points || 0))}</p>
        </div>
      </li>)}
    </ol>
  </section>
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

  return <div className="isolate flex w-full flex-1 flex-col" data-testid="challenges">
    <TopBar title={data?.season?.name || "Challenges"} /><div className="flex w-full flex-1 flex-col gap-6 px-4 py-4 antialiased sm:px-6">
    {error ? <Alert variant="destructive"><AlertTitle>Challenges unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    {!data && !error ? <div className="flex flex-col gap-3"><Skeleton className="h-44 w-full" /><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /></div> : null}
    {data ? <ChallengeFeed snapshot={data} /> : null}
  </div></div>
}
