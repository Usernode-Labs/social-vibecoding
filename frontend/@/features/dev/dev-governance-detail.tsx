import { ArrowLeft, ExternalLink, Vote } from "lucide-react"
import { useEffect, useState } from "react"
import { useParams } from "react-router-dom"

import { ActionAnchor, ActionLink } from "@/components/action-link"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { PlatformIcon } from "@/components/platform-icon"
import { TopBar } from "@/components/top-bar"
import { AppTopBar } from "@/features/apps/app-top-bar"
import { DevVoteControls } from "@/features/dev/dev-vote-controls"
import { TopicDiscussionTranscript } from "@/features/dev/topic-discussion-transcript"
import { getApp, type AppDetail } from "@/lib/apps-api"
import { castGovernanceVote, getDevForum, getGovernanceIssueById, type DevIssue } from "@/lib/dev-forum-api"
import { isProductionReadOnlyReview } from "@/lib/runtime-mode"
import { appDevPath, legacyHash } from "@/lib/routes"

export function DevGovernanceDetail() {
  const { governanceId = "", slug = "" } = useParams()
  const [app, setApp] = useState<AppDetail | undefined>(undefined)
  const [item, setItem] = useState<DevIssue | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [voteError, setVoteError] = useState<string | null>(null)
  const [voting, setVoting] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setApp(undefined); setItem(undefined); setError(null); setVoteError(null)
    Promise.all([
      getApp(slug, controller.signal),
      getDevForum(slug, controller.signal).then(async ({ issues }) => {
        const cached = issues.find((issue) => issue.id === Number(governanceId))
        if (cached) return cached
        return (await getGovernanceIssueById(slug, governanceId, controller.signal)).issue
      }),
    ])
      .then(([{ app: loadedApp }, issue]) => {
        setApp(loadedApp)
        setItem(issue)
      })
      .catch((cause: unknown) => { if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : "Unable to load governance") })
    return () => controller.abort()
  }, [governanceId, refreshKey, slug])

  const back = appDevPath(slug)
  if (error) return <div className="flex flex-1 items-center justify-center p-6"><Alert className="max-w-md" variant="destructive"><AlertTitle>Governance item unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert></div>
  if (item === undefined || app === undefined) return <div className="flex w-full flex-1 flex-col gap-4 px-4 py-8 sm:px-6"><Skeleton className="h-10 w-32" /><Skeleton className="h-64 w-full" /></div>
  if (item === null) return <><TopBar title="Governance item not found" /><div className="flex flex-1 items-center justify-center p-6"><Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={Vote} /></EmptyMedia><EmptyTitle>Governance item not found</EmptyTitle><EmptyDescription>It may have been resolved or you may no longer have access to this app.</EmptyDescription></EmptyHeader><ActionLink to={back}><PlatformIcon data-icon="inline-start" icon={ArrowLeft} />Back to Dev</ActionLink></Empty></div></>

  const canVote = item.status === "open"
  const castVote = async (vote: "up" | "down") => {
    if (!canVote || voting || isProductionReadOnlyReview) return
    setVoting(true); setVoteError(null)
    try {
      await castGovernanceVote(item.id, vote)
      setRefreshKey((value) => value + 1)
    } catch (cause) {
      setVoteError(cause instanceof Error ? cause.message : "Your vote could not be recorded.")
    } finally {
      setVoting(false)
    }
  }

  return <div className="isolate flex w-full flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6" data-testid="governance-detail">
    <AppTopBar app={app} backTo={back} label={item.title} mode="nested" />
    <Card>
      <CardHeader><CardTitle className="flex flex-wrap items-center gap-2"><span className="text-balance">{item.title}</span><Badge variant="outline">{item.kind.replaceAll("_", " ")}</Badge></CardTitle><CardDescription>Governance item #{item.id}{item.created_by_username ? ` · proposed by ${item.created_by_username}` : ""}</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-5"><p className="whitespace-pre-wrap text-base leading-6 text-foreground sm:text-sm">{item.description || "No additional context was provided."}</p><div className="flex flex-wrap gap-2"><DevVoteControls disabled={!canVote || isProductionReadOnlyReview} kind="governance" noCount={item.down_count} onVote={(vote) => void castVote(vote as "up" | "down")} pending={voting} required={item.votes_required} selectedVote={item.my_vote} yesCount={item.up_count} /><Badge variant="secondary">{item.status}</Badge></div>{isProductionReadOnlyReview && canVote ? <p className="text-base text-muted-foreground sm:text-sm">Voting is disabled while this local React workspace reviews production data.</p> : null}{voteError ? <Alert variant="destructive"><AlertTitle>Vote not recorded</AlertTitle><AlertDescription>{voteError}</AlertDescription></Alert> : null}</CardContent>
      <CardFooter><ActionAnchor aria-label={`Open ${item.title} in legacy Dev for moderation and withdrawal`} href={legacyHash(`#app/${encodeURIComponent(slug)}/dev/governance/${item.id}`)}><PlatformIcon data-icon="inline-start" icon={ExternalLink} />More governance actions</ActionAnchor></CardFooter>
    </Card><TopicDiscussionTranscript slug={slug} threadRef={item.id} threadType="governance" />
  </div>
}
