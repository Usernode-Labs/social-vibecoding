import { Gauge, RefreshCw, Vote } from "lucide-react"
import { type ReactNode, useEffect, useMemo, useState } from "react"

import { PlatformIcon } from "@/components/platform-icon"
import { StreamRow } from "@/components/stream-row"
import { TopBar } from "@/components/top-bar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { appDevGovernancePath, appDevProposalPath, appDevSessionPath } from "@/lib/routes"
import { subscribeSessionUpdates, type SessionEventsConnectionState } from "@/lib/session-events"
import { getWorkSnapshot, type WorkGovernance, type WorkProposal, type WorkSession, type WorkSnapshot } from "@/lib/work-api"

function sessionTitle(session: WorkSession) {
  return session.session_title || session.pr_title || session.branch_name || `Session #${session.id}`
}

function WorkSkeleton() {
  return <div className="flex flex-col gap-3">{Array.from({ length: 3 }, (_, index) => <Skeleton className="h-24 w-full" key={index} />)}</div>
}

function WorkSection({ children, count, title }: { children: ReactNode; count: number; title: string }) {
  return <section aria-labelledby={`work-${title.toLocaleLowerCase().replaceAll(" ", "-")}`} className="flex flex-col gap-3"><h2 className="text-lg font-medium" id={`work-${title.toLocaleLowerCase().replaceAll(" ", "-")}`}>{title} <span className="text-muted-foreground">· {count}</span></h2><div className="overflow-hidden rounded-2xl border bg-background">{children}</div></section>
}

export function Work() {
  const [snapshot, setSnapshot] = useState<WorkSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [sessionEventsState, setSessionEventsState] = useState<SessionEventsConnectionState>("connecting")

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    setError(null)
    getWorkSnapshot(controller.signal)
      .then((next) => { if (!cancelled) setSnapshot(next) })
      .catch((cause: unknown) => {
        if (cancelled || (cause instanceof DOMException && cause.name === "AbortError")) return
        setError(cause instanceof Error ? cause.message : "Work didn't load")
      })
    return () => { cancelled = true; controller.abort() }
  }, [refreshKey])

  useEffect(() => {
    let queuedRefresh: number | null = null
    const unsubscribe = subscribeSessionUpdates({
      onConnectionStateChange: setSessionEventsState,
      onSessionUpdate: () => {
        // A session_update is intentionally partial. Coalesce bursts and
        // re-read the server-authorized Work snapshot instead of guessing at
        // status, ownership, proposal placement, or active-session limits.
        if (queuedRefresh !== null) return
        queuedRefresh = window.setTimeout(() => {
          queuedRefresh = null
          setRefreshKey((value) => value + 1)
        }, 100)
      },
    })
    return () => {
      if (queuedRefresh !== null) window.clearTimeout(queuedRefresh)
      unsubscribe()
    }
  }, [])

  const hasBusySession = snapshot?.sessions.some((session) => session.busy) ?? false
  useEffect(() => {
    // A turn start/finish is not guaranteed to broadcast session_update. The
    // legacy Work drawer polls while work is active and whenever its global
    // socket is disconnected; preserve that bounded fallback here.
    if (!hasBusySession && sessionEventsState === "connected") return
    const timer = window.setInterval(() => setRefreshKey((value) => value + 1), 15000)
    return () => window.clearInterval(timer)
  }, [hasBusySession, sessionEventsState])

  const sessions = useMemo(() => {
    const proposalIds = new Set(snapshot?.proposals.map((proposal) => proposal.id))
    return snapshot?.sessions.filter((session) => !proposalIds.has(session.id)) || []
  }, [snapshot])
  const isEmpty = snapshot && sessions.length === 0 && snapshot.proposals.length === 0 && snapshot.governance.length === 0

  return (
    <div className="isolate flex w-full flex-1 flex-col" data-testid="work">
      <TopBar action={<Button aria-label="Refresh work" onClick={() => setRefreshKey((value) => value + 1)} type="button" variant="outline">Refresh</Button>} title="Work" /><div className="flex w-full flex-1 flex-col gap-6 px-4 py-4 antialiased sm:px-6">
      {sessionEventsState !== "connected" ? <p className="text-sm text-muted-foreground" role="status">{sessionEventsState === "connecting" ? "Connecting to live updates" : sessionEventsState === "unavailable" ? "Live updates unavailable. Refreshing periodically." : "Reconnecting to live updates"}</p> : null}
      {error ? <Alert variant="destructive"><AlertTitle>Work unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
      {!snapshot && !error ? <WorkSkeleton /> : null}
      {isEmpty ? <Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={Gauge} /></EmptyMedia><EmptyTitle>No work in progress</EmptyTitle><EmptyDescription>Open an app and start building.</EmptyDescription></EmptyHeader></Empty> : null}
      {snapshot?.proposals.length ? <WorkSection count={snapshot.proposals.length} title="Proposals">{snapshot.proposals.map((proposal) => <ProposalRow key={proposal.id} proposal={proposal} />)}</WorkSection> : null}
      {snapshot?.governance.length ? <WorkSection count={snapshot.governance.length} title="Governance proposals">{snapshot.governance.map((proposal) => <GovernanceRow key={proposal.id} proposal={proposal} />)}</WorkSection> : null}
      {sessions.length ? <WorkSection count={sessions.length} title="Sessions">{sessions.map((session) => <SessionRow key={session.id} session={session} />)}</WorkSection> : null}
    </div></div>
  )
}

function SessionRow({ session }: { session: WorkSession }) {
  const state = session.busy ? "Working" : session.status === "paused" ? "Paused" : session.status === "promoted" ? "In vote" : "Active"
  return <StreamRow accessibleName={`View ${sessionTitle(session)} session`} anchor={<PlatformIcon className={session.busy ? "animate-spin" : undefined} icon={session.busy ? RefreshCw : Gauge} />} metadata={session.app_name} state="default" title={sessionTitle(session)} to={appDevSessionPath(session.app_slug, session.id)} trailing={state} />
}

function ProposalRow({ proposal }: { proposal: WorkProposal }) {
  const votesRequired = proposal.votes_required || proposal.majority || 1
  const title = proposal.pr_title || `Proposal #${proposal.pr_number || proposal.id}`
  return <StreamRow accessibleName={`View ${title} proposal`} anchor={<PlatformIcon icon={Vote} />} metadata={proposal.app_name} state="default" title={title} to={appDevProposalPath(proposal.app_slug, proposal.id)} trailing={`${proposal.yes_count} / ${votesRequired} votes`} />
}

function GovernanceRow({ proposal }: { proposal: WorkGovernance }) {
  const votesRequired = proposal.votes_required || proposal.majority || 1
  return <StreamRow accessibleName={`View ${proposal.title} governance item`} anchor={<PlatformIcon icon={Vote} />} metadata={proposal.app_name} state="default" title={proposal.title} to={appDevGovernancePath(proposal.app_slug, proposal.id)} trailing={`${proposal.up_count} / ${votesRequired} votes`} />
}
