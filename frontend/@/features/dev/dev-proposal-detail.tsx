import { ArrowLeft, Award, ExternalLink, Vote } from "lucide-react"
import { useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { PlatformIcon } from "@/components/platform-icon"
import { DevVoteControls } from "@/features/dev/dev-vote-controls"
import { TopicDiscussionTranscript } from "@/features/dev/topic-discussion-transcript"
import { castProposalVote, getDevForum, getDevProposalById, type DevProposal } from "@/lib/dev-forum-api"
import { giveProposalKudos, retractProposalKudos } from "@/lib/kudos-api"
import { isProductionReadOnlyReview } from "@/lib/runtime-mode"
import { appDevPath, legacyHash } from "@/lib/routes"

function title(proposal: DevProposal) { return proposal.pr_title || proposal.pr_title_fallback || `Proposal #${proposal.pr_number || proposal.id}` }

export function DevProposalDetail() {
  const { proposalId = "", slug = "" } = useParams()
  const [proposal, setProposal] = useState<DevProposal | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [voteError, setVoteError] = useState<string | null>(null)
  const [voting, setVoting] = useState(false)
  const [kudosError, setKudosError] = useState<string | null>(null)
  const [kudosNotice, setKudosNotice] = useState<string | null>(null)
  const [kudosUpdating, setKudosUpdating] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    setProposal(undefined); setError(null); setVoteError(null)
    getDevForum(slug, controller.signal)
      .then(async ({ proposals }) => {
        const cached = proposals.find((item) => item.id === Number(proposalId))
        if (cached) return cached
        return (await getDevProposalById(slug, proposalId, controller.signal)).proposal
      })
      .then((item) => setProposal(item))
      .catch((cause: unknown) => { if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : "Unable to load proposal") })
    return () => controller.abort()
  }, [proposalId, refreshKey, slug])
  const back = appDevPath(slug)
  if (error) return <div className="flex flex-1 items-center justify-center p-6"><Alert className="max-w-md" variant="destructive"><AlertTitle>Proposal unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert></div>
  if (proposal === undefined) return <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-8 sm:px-6"><Skeleton className="h-10 w-32" /><Skeleton className="h-64 w-full" /></div>
  if (proposal === null) return <div className="flex flex-1 items-center justify-center p-6"><Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={Vote} /></EmptyMedia><EmptyTitle>Proposal not found</EmptyTitle><EmptyDescription>It may have merged, been withdrawn, or you may no longer have access to this app.</EmptyDescription></EmptyHeader><Button render={<Link to={back} />} variant="outline"><PlatformIcon data-icon="inline-start" icon={ArrowLeft} />Back to Dev</Button></Empty></div>
  const proposalTitle = title(proposal)
  const canVote = ["promoted", "merging"].includes(proposal.status)
  const canKudos = ["promoted", "merging", "merged"].includes(proposal.status)
  const castVote = async (vote: "yes" | "no") => {
    if (!canVote || voting || isProductionReadOnlyReview) return
    setVoting(true); setVoteError(null)
    try {
      await castProposalVote(proposal.id, vote)
      setRefreshKey((value) => value + 1)
    } catch (cause) {
      setVoteError(cause instanceof Error ? cause.message : "Your vote could not be recorded.")
    } finally {
      setVoting(false)
    }
  }
  const updateKudos = async () => {
    if (!canKudos || kudosUpdating || isProductionReadOnlyReview) return
    setKudosUpdating(true); setKudosError(null); setKudosNotice(null)
    try {
      const result = proposal.my_kudos_direct
        ? await retractProposalKudos(proposal.id)
        : await giveProposalKudos(proposal.id)
      setKudosNotice(result.remaining === null || result.limit === null
        ? proposal.my_kudos_direct ? "Kudos retracted." : "Kudos recorded."
        : proposal.my_kudos_direct
          ? `Kudos retracted. ${result.remaining} of ${result.limit} weekly recognition slots remain.`
          : `Kudos recorded. ${result.remaining} of ${result.limit} weekly recognition slots remain.`)
      setRefreshKey((value) => value + 1)
    } catch (cause) {
      setKudosError(cause instanceof Error ? cause.message : "Kudos could not be updated.")
    } finally {
      setKudosUpdating(false)
    }
  }
  return <div className="isolate mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6" data-testid="proposal-detail">
    <Button className="w-fit" render={<Link to={back} />} variant="ghost"><PlatformIcon data-icon="inline-start" icon={ArrowLeft} />App Dev</Button>
    <Card><CardHeader><CardTitle className="flex flex-wrap items-center gap-2"><h1 className="text-balance">{proposalTitle}</h1><Badge variant={proposal.status === "merging" ? "secondary" : "outline"}>{proposal.status === "merged" ? "Merged" : proposal.status === "merging" ? "Merging" : "In vote"}</Badge></CardTitle><CardDescription>Proposal #{proposal.pr_number || proposal.id}{proposal.username ? ` · proposed by ${proposal.username}` : ""}</CardDescription></CardHeader><CardContent className="flex flex-col gap-5"><p className="whitespace-pre-wrap text-base leading-6 text-foreground sm:text-sm">{proposal.pr_summary_md || "No proposal summary was provided."}</p><DevVoteControls disabled={!canVote || isProductionReadOnlyReview} kind="proposal" noCount={proposal.no_count} onVote={(vote) => void castVote(vote as "yes" | "no")} pending={voting} required={proposal.votes_required} selectedVote={proposal.my_vote} yesCount={proposal.yes_count} />{isProductionReadOnlyReview && canVote ? <p className="text-base text-muted-foreground sm:text-sm">Voting is disabled while this local React workspace reviews production data.</p> : null}{voteError ? <Alert variant="destructive"><AlertTitle>Vote not recorded</AlertTitle><AlertDescription>{voteError}</AlertDescription></Alert> : null}{kudosError ? <Alert variant="destructive"><AlertTitle>Kudos not updated</AlertTitle><AlertDescription>{kudosError}</AlertDescription></Alert> : null}{kudosNotice ? <Alert><AlertTitle>Recognition updated</AlertTitle><AlertDescription>{kudosNotice}</AlertDescription></Alert> : null}{proposal.pr_url ? <Badge render={<a href={proposal.pr_url} rel="noreferrer" target="_blank" />} variant="secondary">View PR</Badge> : null}</CardContent><CardFooter className="flex flex-wrap gap-2">{canKudos ? <Button aria-pressed={Boolean(proposal.my_kudos_direct)} disabled={isProductionReadOnlyReview || kudosUpdating} onClick={() => void updateKudos()} type="button" variant={proposal.my_kudos_direct ? "outline" : "secondary"}><PlatformIcon data-icon="inline-start" icon={Award} />{kudosUpdating ? "Updating…" : proposal.my_kudos_direct ? "Retract kudos" : "Give kudos"}{proposal.kudos_count ? <span className="tabular-nums">{proposal.kudos_count}</span> : null}</Button> : null}<Button render={<a aria-label={`Open ${proposalTitle} in legacy Dev for force-merge and moderation`} href={legacyHash(`#app/${encodeURIComponent(slug)}/dev/proposals/${proposal.id}`)} />} variant="outline"><PlatformIcon data-icon="inline-start" icon={ExternalLink} />More proposal actions</Button></CardFooter></Card>
  <TopicDiscussionTranscript slug={slug} threadRef={proposal.id} threadType="session" /></div>
}
