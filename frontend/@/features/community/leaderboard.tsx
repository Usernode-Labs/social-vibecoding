import { ArrowLeft, Award, ChevronRight, ExternalLink, HandHeart, History, ThumbsUp, UsersRound, Vote } from "lucide-react"
import { useEffect, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { PlatformIcon } from "@/components/platform-icon"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
    <div className="isolate mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6" data-testid="leaderboard">
      <header className="space-y-2">
        <h1 className="text-balance text-3xl font-semibold tracking-tight">Kudos leaderboard</h1>
        <p className="max-w-2xl text-base text-muted-foreground text-pretty">Recognize proposals and the people building the platform.</p>
      </header>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <div aria-label="Leaderboard view" className="flex gap-1" role="group">
          <Button aria-pressed={tab === "prs"} onClick={() => select("prs", window)} type="button" variant={tab === "prs" ? "secondary" : "ghost"}>Top PRs</Button>
          <Button aria-pressed={tab === "users"} onClick={() => select("users", window)} type="button" variant={tab === "users" ? "secondary" : "ghost"}>Top users</Button>
        </div>
        <div aria-label="Leaderboard period" className="flex gap-1" role="group">
          <Button aria-pressed={window === "all"} onClick={() => select(tab, "all")} size="sm" type="button" variant={window === "all" ? "secondary" : "outline"}>All-time</Button>
          <Button aria-pressed={window === "week"} onClick={() => select(tab, "week")} size="sm" type="button" variant={window === "week" ? "secondary" : "outline"}>This week</Button>
        </div>
        <Button render={<Link to={leaderboardHistoryPath()} />} size="sm" variant="ghost"><PlatformIcon data-icon="inline-start" icon={History} size="sm" />My history</Button>
      </div>
      {error ? <Alert variant="destructive"><AlertTitle>Leaderboard unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
      {!items && !error ? <PaneSkeleton /> : null}
      {items?.length === 0 ? <Alert><AlertTitle>No kudos yet</AlertTitle><AlertDescription>Completed proposals will appear here when the community recognizes them.</AlertDescription></Alert> : null}
      {items?.map((item, index) => "author_username" in item ? <PrRow item={item} key={item.session_id} rank={index + 1} /> : <UserRow item={item} key={item.username} rank={index + 1} window={window} />)}
    </div>
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

function historyBadge(item: HistoryItem) {
  if (item.type === "bounty") return <Badge variant="secondary">Bounty</Badge>
  if (item.type === "pr_vote") return <Badge variant={item.vote === "yes" ? "secondary" : "outline"}>{item.vote === "yes" ? "Yes" : "No"}</Badge>
  if (item.type === "proposal_vote") return <Badge variant={item.vote === "up" ? "secondary" : "outline"}>{item.vote === "up" ? "Upvote" : "Downvote"}</Badge>
  return <Badge variant="secondary">Kudos</Badge>
}

function HistoryRow({ item }: { item: HistoryItem }) {
  const destination = item.pr?.sessionId
    ? appDevProposalPath(item.app.slug, item.pr.sessionId)
    : item.issue?.number
      ? appDevGitHubIssuePath(item.app.slug, item.issue.number)
      : appDevPath(item.app.slug)
  const title = historyTitle(item)

  return <Card size="sm">
    <CardHeader className="grid-cols-[auto_1fr_auto] gap-3">
      <HistoryMarker item={item} />
      <div className="min-w-0"><CardTitle className="truncate">{title}</CardTitle><CardDescription className="mt-1">{historyDetail(item)}</CardDescription></div>
      <div className="flex flex-col items-end gap-1.5"><time className="shrink-0 text-sm text-muted-foreground" dateTime={item.created_at}>{formatDate(item.created_at)}</time>{historyBadge(item)}</div>
    </CardHeader>
    <CardContent>
      <Button className="w-full" render={<Link aria-label={`View ${title}`} to={destination} />} size="sm" variant="outline">View source<PlatformIcon data-icon="inline-end" icon={ChevronRight} size="sm" /></Button>
    </CardContent>
  </Card>
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

  return <div className="isolate mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6" data-testid="leaderboard-history">
    <header className="flex flex-col gap-3">
      <Button className="w-fit" render={<Link to="/community/leaderboard" />} variant="ghost"><PlatformIcon data-icon="inline-start" icon={ArrowLeft} />Kudos leaderboard</Button>
      <div className="flex flex-col gap-2"><h1 className="text-balance text-3xl font-semibold tracking-tight">My history</h1><p className="max-w-2xl text-base text-muted-foreground text-pretty">Everything you’ve given — kudos, bounty pledges, and votes — newest first. Only you can see this.</p></div>
    </header>
    <div aria-label="History filters" className="flex flex-wrap gap-2" role="group">
      <Button aria-pressed={kudosEnabled} onClick={() => toggle("kudos")} size="sm" type="button" variant={kudosEnabled ? "secondary" : "outline"}><PlatformIcon data-icon="inline-start" icon={ThumbsUp} size="sm" />Kudos</Button>
      <Button aria-pressed={votesEnabled} onClick={() => toggle("votes")} size="sm" type="button" variant={votesEnabled ? "secondary" : "outline"}><PlatformIcon data-icon="inline-start" icon={Vote} size="sm" />Votes</Button>
    </div>
    {error ? <Alert variant={error.unauthorized ? "default" : "destructive"}><AlertTitle>{error.unauthorized ? "Sign in to view your history" : "History unavailable"}</AlertTitle><AlertDescription>{error.unauthorized ? "Your giving history is private to your signed-in account." : error.message}</AlertDescription></Alert> : null}
    {!history && !error ? <PaneSkeleton /> : null}
    {history?.items.length === 0 ? <Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={History} /></EmptyMedia><EmptyTitle>Nothing here yet</EmptyTitle><EmptyDescription>Kudos, bounty pledges, and votes you give will appear here.</EmptyDescription></EmptyHeader></Empty> : null}
    {history?.items.length ? <section aria-label="Your recognition history" className="flex flex-col gap-3">{history.items.map((item, index) => <HistoryRow item={item} key={`${item.type}-${item.created_at}-${index}`} />)}</section> : null}
    {paginationError ? <Alert variant="destructive"><AlertTitle>Couldn’t load more history</AlertTitle><AlertDescription>{paginationError}</AlertDescription></Alert> : null}
    {history?.nextBefore ? <Button className="self-center" disabled={loadingMore} onClick={() => void loadMore()} variant="outline">{loadingMore ? "Loading…" : "Load more"}</Button> : null}
  </div>
}

function Rank({ value }: { value: number }) {
  return <span aria-label={`Rank ${value}`} className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium tabular-nums">{value}</span>
}

function PrRow({ item, rank }: { item: LeaderboardPr; rank: number }) {
  return (
    <Card>
      <CardHeader className="grid-cols-[auto_1fr_auto] gap-3">
        <Rank value={rank} />
        <div className="min-w-0"><CardTitle className="truncate">{item.pr_title || "Untitled proposal"}</CardTitle><CardDescription>by @{item.author_username || "unknown"} · {item.app_name}</CardDescription></div>
        <Badge><PlatformIcon data-icon="inline-start" icon={Award} size="xs" />{item.kudos_count}</Badge>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button render={<Link aria-label={`View ${item.pr_title || "proposal"}`} to={appDevProposalPath(item.app_slug, item.session_id)} />} size="sm" variant="outline">View details</Button>
        {item.pr_url ? <Button render={<a aria-label={`Open ${item.pr_title || "proposal"} on GitHub`} href={item.pr_url} rel="noreferrer" target="_blank" />} size="sm" variant="ghost"><PlatformIcon data-icon="inline-start" icon={ExternalLink} size="sm" />GitHub</Button> : null}
      </CardContent>
    </Card>
  )
}

function UserRow({ item, rank, window }: { item: LeaderboardUser; rank: number; window: LeaderboardWindow }) {
  return (
    <Card>
      <CardHeader className="grid-cols-[auto_1fr_auto] gap-3">
        <Rank value={rank} />
        <div className="min-w-0"><CardTitle className="truncate">@{item.username}</CardTitle><CardDescription>{item.prs_kudosed || 0} kudosed proposals{item.prs_merged ? ` · ${item.prs_merged} merged` : ""}</CardDescription></div>
        <Badge><PlatformIcon data-icon="inline-start" icon={Award} size="xs" />{item.kudos_received_prs_merged}</Badge>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        {item.active_apps?.length ? <span className="flex min-w-0 items-start gap-2"><PlatformIcon className="mt-0.5 text-muted-foreground" icon={UsersRound} /><span className="text-sm text-muted-foreground">Active on {item.active_apps.map((app) => app.name).join(", ")}</span></span> : <span className="text-sm text-muted-foreground">View their public proposals and recognition.</span>}
        <Button aria-label={`View @${item.username}'s profile`} render={<Link to={leaderboardUserPath(item.username, window)} />} size="sm" variant="outline">View profile</Button>
      </CardContent>
    </Card>
  )
}

function StatusBadge({ status }: { status: string }) {
  if (status === "merged") return <Badge variant="secondary">Merged</Badge>
  if (status === "merging") return <Badge variant="outline">Merging</Badge>
  if (status === "archived") return <Badge variant="outline">Closed</Badge>
  return <Badge variant="outline">Open</Badge>
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(date)
}

function ProfilePrRow({ item }: { item: LeaderboardUserProfilePr }) {
  const title = item.pr_title || `PR #${item.pr_number || item.session_id}`
  return <Card size="sm"><CardHeader className="grid-cols-[1fr_auto] gap-3"><div className="min-w-0 space-y-1"><CardTitle className="truncate">{title}</CardTitle><CardDescription className="flex flex-wrap items-center gap-x-1.5 gap-y-1"><StatusBadge status={item.status} /><span>{item.app_name || item.app_slug}</span>{formatDate(item.created_at) ? <><span aria-hidden="true">·</span><span>{formatDate(item.created_at)}</span></> : null}</CardDescription></div><Badge><PlatformIcon data-icon="inline-start" icon={Award} size="xs" />{item.kudos_count}</Badge></CardHeader><CardContent className="flex flex-wrap gap-2"><Button render={<Link aria-label={`View ${title}`} to={appDevProposalPath(item.app_slug, item.session_id)} />} size="sm" variant="outline">View details</Button>{item.pr_url ? <Button render={<a href={item.pr_url} rel="noreferrer" target="_blank" />} size="sm" variant="ghost"><PlatformIcon data-icon="inline-start" icon={ExternalLink} size="sm" />GitHub</Button> : null}</CardContent></Card>
}

export function LeaderboardUserProfile() {
  const { username = "" } = useParams()
  const [params] = useSearchParams()
  const window = validWindow(params.get("window"))
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

  const back = `/community/leaderboard?tab=users&window=${window}`
  return <div className="isolate mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6" data-testid="leaderboard-profile">
    <Button className="w-fit" render={<Link to={back} />} variant="ghost"><PlatformIcon data-icon="inline-start" icon={ArrowLeft} />Top users</Button>
    {error ? <Alert variant={error.notFound ? "default" : "destructive"}><AlertTitle>{error.notFound ? "User not found" : "Profile unavailable"}</AlertTitle><AlertDescription>{error.notFound ? "This public profile may have been removed or renamed." : error.message}</AlertDescription></Alert> : null}
    {!profile && !error ? <PaneSkeleton /> : null}
    {profile ? <><header className="space-y-2"><h1 className="text-balance text-3xl font-semibold tracking-tight">@{profile.user.username}</h1><p className="max-w-2xl text-base text-muted-foreground text-pretty">Public proposals this contributor has made, newest first.</p></header><div aria-label="Contributor recognition" className="flex flex-wrap gap-2"><Badge><PlatformIcon data-icon="inline-start" icon={Award} size="xs" />{profile.stats.kudos_merged} kudos on merged</Badge><Badge variant="secondary">{profile.stats.prs_merged} merged</Badge><Badge variant="outline">{profile.stats.prs_total} proposed</Badge></div>{profile.items.length === 0 ? <Alert><AlertTitle>No public proposals yet</AlertTitle><AlertDescription>Public proposals will appear here when this contributor creates one.</AlertDescription></Alert> : <section aria-label={`${profile.user.username}'s proposals`} className="space-y-3">{profile.items.map((item) => <ProfilePrRow item={item} key={item.session_id} />)}</section>}{profile.nextBefore ? <Button className="self-center" disabled={loadingMore} onClick={() => void loadMore()} variant="outline">{loadingMore ? "Loading…" : "Load more"}</Button> : null}</> : null}
  </div>
}
