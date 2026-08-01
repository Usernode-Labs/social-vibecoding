import { Award, ExternalLink, HandHeart, History, ThumbsUp, Vote } from "lucide-react"
import { useEffect, useState } from "react"
import { useParams, useSearchParams } from "react-router-dom"

import { ActionAnchor, ActionLink } from "@/components/action-link"
import { PlatformIcon } from "@/components/platform-icon"
import { StreamRow } from "@/components/stream-row"
import { TopBar } from "@/components/top-bar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { ApiRequestError, getLeaderboardUserProfile, getMyHistory, getTopPrs, getTopUsers, type HistoryItem, type HistoryType, type LeaderboardPr, type LeaderboardUser, type LeaderboardUserProfilePr, type LeaderboardWindow } from "@/lib/leaderboard-api"
import { appDevGitHubIssuePath, appDevPath, appDevProposalPath, leaderboardHistoryPath, leaderboardUserPath } from "@/lib/routes"

type LeaderboardTab = "prs" | "users"

function validTab(value: string | null): LeaderboardTab {
  return value === "users" ? "users" : "prs"
}

function validWindow(value: string | null): LeaderboardWindow {
  return value === "week" ? "week" : "all"
}

function PaneSkeleton() {
  return <div className="flex flex-col gap-3">{Array.from({ length: 3 }, (_, index) => <Skeleton className="h-24 w-full" key={index} />)}</div>
}

export function Leaderboard() {
  const [params, setParams] = useSearchParams()
  const tab = validTab(params.get("tab"))
  const window = validWindow(params.get("window"))
  const [items, setItems] = useState<Array<LeaderboardPr | LeaderboardUser> | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setItems(null)
    setError(null)
    const request = tab === "prs" ? getTopPrs(window, controller.signal) : getTopUsers(window, controller.signal)
    request
      .then((response) => setItems(response.items))
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return
        setError(cause instanceof Error ? cause.message : "Unable to load the leaderboard")
      })
    return () => controller.abort()
  }, [tab, window])

  const select = (nextTab: LeaderboardTab, nextWindow: LeaderboardWindow) => {
    setParams({ tab: nextTab, window: nextWindow })
  }

  return (
    <div className="isolate flex w-full flex-1 flex-col" data-testid="leaderboard">
      <TopBar title="Kudos leaderboard" /><div className="flex w-full flex-1 flex-col gap-6 px-4 py-4 antialiased sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <div aria-label="Leaderboard view" className="flex gap-1" role="group">
          <Button aria-pressed={tab === "prs"} onClick={() => select("prs", window)} type="button" variant={tab === "prs" ? "secondary" : "ghost"}>Top PRs</Button>
          <Button aria-pressed={tab === "users"} onClick={() => select("users", window)} type="button" variant={tab === "users" ? "secondary" : "ghost"}>Top users</Button>
        </div>
        <div aria-label="Leaderboard period" className="flex gap-1" role="group">
          <Button aria-pressed={window === "all"} onClick={() => select(tab, "all")} size="sm" type="button" variant={window === "all" ? "secondary" : "outline"}>All-time</Button>
          <Button aria-pressed={window === "week"} onClick={() => select(tab, "week")} size="sm" type="button" variant={window === "week" ? "secondary" : "outline"}>This week</Button>
        </div>
        <ActionLink size="sm" to={leaderboardHistoryPath()} variant="ghost"><PlatformIcon data-icon="inline-start" icon={History} size="sm" />My history</ActionLink>
      </div>
      {error ? <Alert variant="destructive"><AlertTitle>Leaderboard unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
      {!items && !error ? <PaneSkeleton /> : null}
      {items?.length === 0 ? <Alert><AlertTitle>No kudos yet</AlertTitle><AlertDescription>Completed proposals will appear here when the community recognizes them.</AlertDescription></Alert> : null}
      {items?.length ? <section aria-label={tab === "prs" ? "Top proposals" : "Top contributors"} className="overflow-hidden rounded-2xl border bg-background">{items.map((item, index) => "author_username" in item ? <PrRow item={item} key={item.session_id} rank={index + 1} /> : <UserRow item={item} key={item.username} rank={index + 1} window={window} />)}</section> : null}
    </div></div>
  )
}

function historyType(kudos: boolean, votes: boolean): HistoryType {
  if (kudos === votes) return "all"
  return kudos ? "kudos" : "votes"
}

function HistoryMarker({ item }: { item: HistoryItem }) {
  if (item.type === "kudos") return <PlatformIcon className="text-muted-foreground" icon={ThumbsUp} />
  if (item.type === "bounty") return <PlatformIcon className="text-muted-foreground" icon={HandHeart} />
  return <PlatformIcon className="text-muted-foreground" icon={Vote} />
}

function historyTitle(item: HistoryItem) {
  if (item.type === "bounty") return `Pledged kudos on issue #${item.issue?.number ?? "?"}`
  if (item.type === "proposal_vote") return item.issue?.title || `Proposal #${item.issue?.number ?? "?"}`
  return item.pr?.title || `PR #${item.pr?.number ?? item.pr?.sessionId ?? "?"}`
}

function historyDetail(item: HistoryItem) {
  const appName = item.app.name || item.app.slug || "app"
  if (item.type === "kudos") return `Kudos given to @${item.pr?.author || "deleted user"} · ${appName}`
  if (item.type === "bounty") {
    if (item.status === "awarded") return `Bounty awarded to @${item.awarded?.username || "deleted user"} · ${appName}`
    if (item.status === "voided") return `Pledge returned · ${appName}`
    return `Open bounty · ${appName}`
  }
  if (item.type === "pr_vote") return `${item.vote === "yes" ? "Yes" : "No"} · current vote · @${item.pr?.author || "deleted user"} · ${appName}`
  return `${item.vote === "up" ? "Upvote" : "Downvote"} · current vote · ${appName}`
}

function historyLabel(item: HistoryItem) {
  if (item.type === "bounty") return "Bounty"
  if (item.type === "pr_vote") return item.vote === "yes" ? "Yes vote" : "No vote"
  if (item.type === "proposal_vote") return item.vote === "up" ? "Upvote" : "Downvote"
  return "Kudos"
}

function HistoryRow({ item }: { item: HistoryItem }) {
  const destination = item.pr?.sessionId
    ? appDevProposalPath(item.app.slug, item.pr.sessionId)
    : item.issue?.number
      ? appDevGitHubIssuePath(item.app.slug, item.issue.number)
      : appDevPath(item.app.slug)
  const title = historyTitle(item)

  return <StreamRow accessibleName={`View ${title}`} anchor={<HistoryMarker item={item} />} metadata={`${historyLabel(item)} · ${historyDetail(item)}`} state="default" title={title} to={destination} trailing={<time dateTime={item.created_at}>{formatDate(item.created_at)}</time>} />
}

/**
 * A signed-in user's private, read-only give-side ledger. Source links stay
 * inside the owned React routes; each detail surface independently decides
 * which mutation controls the viewer is authorized to use.
 */
export function LeaderboardHistory() {
  const [params, setParams] = useSearchParams()
  const kudosEnabled = params.get("kudos") !== "0"
  const votesEnabled = params.get("votes") !== "0"
  const filter = historyType(kudosEnabled, votesEnabled)
  const [history, setHistory] = useState<Awaited<ReturnType<typeof getMyHistory>> | null>(null)
  const [error, setError] = useState<{ message: string; unauthorized: boolean } | null>(null)
  const [paginationError, setPaginationError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setHistory(null)
    setError(null)
    setPaginationError(null)
    getMyHistory(filter, undefined, controller.signal)
      .then(setHistory)
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return
        setError({
          message: cause instanceof Error ? cause.message : "Unable to load your history",
          unauthorized: cause instanceof ApiRequestError && cause.status === 401,
        })
      })
    return () => controller.abort()
  }, [filter])

  const toggle = (which: "kudos" | "votes") => {
    const nextKudos = which === "kudos" ? !kudosEnabled : kudosEnabled
    const nextVotes = which === "votes" ? !votesEnabled : votesEnabled
    setParams({ kudos: nextKudos ? "1" : "0", votes: nextVotes ? "1" : "0" })
  }

  const loadMore = async () => {
    if (!history?.nextBefore || loadingMore) return
    setLoadingMore(true)
    setPaginationError(null)
    try {
      const page = await getMyHistory(filter, history.nextBefore)
      setHistory((current) => current ? { ...page, items: [...current.items, ...page.items] } : current)
    } catch (cause) {
      setPaginationError(cause instanceof Error ? cause.message : "Unable to load more history")
    } finally {
      setLoadingMore(false)
    }
  }

  return <div className="isolate flex w-full flex-1 flex-col" data-testid="leaderboard-history">
    <TopBar title="My history" />
    <p className="max-w-2xl text-pretty text-base text-muted-foreground sm:text-sm">Everything you’ve given — kudos, bounty pledges, and votes — newest first. Only you can see this.</p><div className="flex w-full flex-1 flex-col gap-6 px-4 py-4 antialiased sm:px-6">
    <div aria-label="History filters" className="flex flex-wrap gap-2" role="group">
      <Button aria-pressed={kudosEnabled} onClick={() => toggle("kudos")} size="sm" type="button" variant={kudosEnabled ? "secondary" : "outline"}><PlatformIcon data-icon="inline-start" icon={ThumbsUp} size="sm" />Kudos</Button>
      <Button aria-pressed={votesEnabled} onClick={() => toggle("votes")} size="sm" type="button" variant={votesEnabled ? "secondary" : "outline"}><PlatformIcon data-icon="inline-start" icon={Vote} size="sm" />Votes</Button>
    </div>
    {error ? <Alert variant={error.unauthorized ? "default" : "destructive"}><AlertTitle>{error.unauthorized ? "Sign in to view your history" : "History unavailable"}</AlertTitle><AlertDescription>{error.unauthorized ? "Your giving history is private to your signed-in account." : error.message}</AlertDescription></Alert> : null}
    {!history && !error ? <PaneSkeleton /> : null}
    {history?.items.length === 0 ? <Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={History} /></EmptyMedia><EmptyTitle>Nothing here yet</EmptyTitle><EmptyDescription>Kudos, bounty pledges, and votes you give will appear here.</EmptyDescription></EmptyHeader></Empty> : null}
    {history?.items.length ? <section aria-label="Your recognition history" className="overflow-hidden rounded-2xl border bg-background">{history.items.map((item, index) => <HistoryRow item={item} key={`${item.type}-${item.created_at}-${index}`} />)}</section> : null}
    {paginationError ? <Alert variant="destructive"><AlertTitle>Couldn’t load more history</AlertTitle><AlertDescription>{paginationError}</AlertDescription></Alert> : null}
    {history?.nextBefore ? <Button className="self-center" disabled={loadingMore} onClick={() => void loadMore()} variant="outline">{loadingMore ? "Loading…" : "Load more"}</Button> : null}
  </div></div>
}

function Rank({ value }: { value: number }) {
  return <span aria-label={`Rank ${value}`} className="text-sm font-medium tabular-nums">{value}</span>
}

function KudosValue({ value }: { value: number }) {
  return <span className="flex flex-col items-end"><strong className="text-base font-semibold text-foreground tabular-nums">{value}</strong><span className="text-xs">Kudos</span></span>
}

function PrRow({ item, rank }: { item: LeaderboardPr; rank: number }) {
  const title = item.pr_title || "Untitled proposal"
  return <StreamRow accessibleName={`View ${title}`} anchor={<Rank value={rank} />} metadata={`@${item.author_username || "unknown"} · ${item.app_name}`} secondaryAction={item.pr_url ? <ActionAnchor aria-label={`Open ${title} on GitHub`} className="pointer-coarse:min-h-12" href={item.pr_url} rel="noreferrer" size="icon" target="_blank" variant="ghost"><PlatformIcon icon={ExternalLink} /></ActionAnchor> : undefined} state="default" title={title} to={appDevProposalPath(item.app_slug, item.session_id)} trailing={<KudosValue value={item.kudos_count} />} />
}

function UserRow({ item, rank, window }: { item: LeaderboardUser; rank: number; window: LeaderboardWindow }) {
  const activity = item.active_apps?.length ? `Active on ${item.active_apps.map((app) => app.name).join(", ")}` : `${item.prs_kudosed || 0} kudosed proposals${item.prs_merged ? ` · ${item.prs_merged} merged` : ""}`
  return <StreamRow accessibleName={`View @${item.username}'s profile`} anchor={<Rank value={rank} />} metadata={activity} state="default" title={`@${item.username}`} to={leaderboardUserPath(item.username, window)} trailing={<KudosValue value={item.kudos_received_prs_merged} />} />
}

function statusLabel(status: string) {
  if (status === "merged") return "Merged"
  if (status === "merging") return "Merging"
  if (status === "archived") return "Closed"
  return "Open"
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(date)
}

function ProfilePrRow({ item }: { item: LeaderboardUserProfilePr }) {
  const title = item.pr_title || `PR #${item.pr_number || item.session_id}`
  const date = formatDate(item.created_at)
  const metadata = [statusLabel(item.status), item.app_name || item.app_slug, date].filter(Boolean).join(" · ")
  return <StreamRow accessibleName={`View ${title}`} anchor={<PlatformIcon icon={Award} />} metadata={metadata} secondaryAction={item.pr_url ? <ActionAnchor aria-label={`Open ${title} on GitHub`} className="pointer-coarse:min-h-12" href={item.pr_url} rel="noreferrer" size="icon" target="_blank" variant="ghost"><PlatformIcon icon={ExternalLink} /></ActionAnchor> : undefined} state="default" title={title} to={appDevProposalPath(item.app_slug, item.session_id)} trailing={<KudosValue value={item.kudos_count} />} />
}

export function LeaderboardUserProfile() {
  const { username = "" } = useParams()
  const [profile, setProfile] = useState<Awaited<ReturnType<typeof getLeaderboardUserProfile>> | null>(null)
  const [error, setError] = useState<{ message: string; notFound: boolean } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setProfile(null)
    setError(null)
    getLeaderboardUserProfile(username, undefined, controller.signal)
      .then(setProfile)
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return
        const message = cause instanceof Error ? cause.message : "Unable to load this profile"
        setError({ message, notFound: /404/.test(message) })
      })
    return () => controller.abort()
  }, [username])

  const loadMore = async () => {
    if (!profile?.nextBefore || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await getLeaderboardUserProfile(username, profile.nextBefore)
      setProfile((current) => current ? { ...page, items: [...current.items, ...page.items] } : current)
    } catch (cause) {
      setError({ message: cause instanceof Error ? cause.message : "Unable to load more proposals", notFound: false })
    } finally {
      setLoadingMore(false)
    }
  }

  return <div className="isolate flex w-full flex-1 flex-col" data-testid="leaderboard-profile">
    <TopBar title={`@${profile?.user.username || username}`} /><div className="flex w-full flex-1 flex-col gap-6 px-4 py-4 antialiased sm:px-6">
    {error ? <Alert variant={error.notFound ? "default" : "destructive"}><AlertTitle>{error.notFound ? "User not found" : "Profile unavailable"}</AlertTitle><AlertDescription>{error.notFound ? "This public profile may have been removed or renamed." : error.message}</AlertDescription></Alert> : null}
    {!profile && !error ? <PaneSkeleton /> : null}
    {profile ? <><div aria-label="Contributor recognition" className="flex flex-wrap gap-2"><Badge><PlatformIcon data-icon="inline-start" icon={Award} size="xs" />{profile.stats.kudos_merged} kudos on merged</Badge><Badge variant="secondary">{profile.stats.prs_merged} merged</Badge><Badge variant="outline">{profile.stats.prs_total} proposed</Badge></div>{profile.items.length === 0 ? <Alert><AlertTitle>No public proposals yet</AlertTitle><AlertDescription>Public proposals will appear here when this contributor creates one.</AlertDescription></Alert> : <section aria-label={`${profile.user.username}'s proposals`} className="overflow-hidden rounded-2xl border bg-background">{profile.items.map((item) => <ProfilePrRow item={item} key={item.session_id} />)}</section>}{profile.nextBefore ? <Button className="self-center" disabled={loadingMore} onClick={() => void loadMore()} variant="outline">{loadingMore ? "Loading…" : "Load more"}</Button> : null}</> : null}
  </div></div>
}
