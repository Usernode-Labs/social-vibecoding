import { Gauge, RefreshCw, Vote } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { PlatformIcon } from "@/components/platform-icon"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { appDevGovernancePath, appDevProposalPath, appDevSessionPath } from "@/lib/routes"
import { subscribeSessionUpdates, type SessionEventsConnectionState } from "@/lib/session-events"
import { getWorkSnapshot, type WorkGovernance, type WorkProposal, type WorkSession, type WorkSnapshot } from "@/lib/work-api"

function sessionTitle(session: WorkSession) {
  return session.session_title || session.pr_title || session.branch_name || `Session #${session.id}`
}

function WorkSkeleton() {
  return <div className="space-y-3">{Array.from({ length: 3 }, (_, index) => <Skeleton className="h-24 w-full" key={index} />)}</div>
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
        setError(cause instanceof Error ? cause.message : "Unable to load your work")
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
    <div className="isolate mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6" data-testid="work">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2"><h1 className="text-balance text-3xl font-semibold tracking-tight">Your work</h1><p className="text-base text-muted-foreground text-pretty">Sessions and proposals across the apps you build.</p></div>
        <Button aria-label="Refresh your work" onClick={() => setRefreshKey((value) => value + 1)} type="button" variant="outline"><PlatformIcon data-icon="inline-start" icon={RefreshCw} />Refresh</Button>
      </header>
      {sessionEventsState !== "connected" ? <p className="text-sm text-muted-foreground" role="status">{sessionEventsState === "connecting" ? "Connecting to live session updates." : sessionEventsState === "unavailable" ? "Live session updates are unavailable. This page will keep refreshing periodically." : "Live session updates are reconnecting. This page will keep refreshing periodically."}</p> : null}
      {error ? <Alert variant="destructive"><AlertTitle>Your work is unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
      {!snapshot && !error ? <WorkSkeleton /> : null}
      {isEmpty ? <Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={Gauge} /></EmptyMedia><EmptyTitle>No work in progress</EmptyTitle><EmptyDescription>Open an app and start a Dev session when you are ready to build.</EmptyDescription></EmptyHeader></Empty> : null}
      {snapshot?.proposals.length ? <section className="space-y-3"><h3 className="text-lg font-medium">Your proposals</h3>{snapshot.proposals.map((proposal) => <ProposalRow key={proposal.id} proposal={proposal} />)}</section> : null}
      {snapshot?.governance.length ? <section className="space-y-3"><h3 className="text-lg font-medium">Governance proposals</h3>{snapshot.governance.map((proposal) => <GovernanceRow key={proposal.id} proposal={proposal} />)}</section> : null}
      {sessions.length ? <section className="space-y-3"><h3 className="text-lg font-medium">Your sessions</h3>{sessions.map((session) => <SessionRow key={session.id} session={session} />)}</section> : null}
    </div>
  )
}

function SessionRow({ session }: { session: WorkSession }) {
  const state = session.busy ? "Working" : session.status === "paused" ? "Paused" : session.status === "promoted" ? "In vote" : "Active"
  return <Card><CardHeader className="grid-cols-[1fr_auto] gap-3"><div className="min-w-0"><CardTitle className="truncate">{sessionTitle(session)}</CardTitle><CardDescription>{session.app_name}</CardDescription></div><Badge variant={session.busy ? "secondary" : "outline"}>{session.busy ? <PlatformIcon className="animate-spin" data-icon="inline-start" icon={RefreshCw} size="xs" /> : null}{state}</Badge></CardHeader><CardContent><Button render={<Link aria-label={`View ${sessionTitle(session)} session`} to={appDevSessionPath(session.app_slug, session.id)} />} size="sm" variant="outline">View session</Button></CardContent></Card>
}

function ProposalRow({ proposal }: { proposal: WorkProposal }) {
  const votesRequired = proposal.votes_required || proposal.majority || 1
  const title = proposal.pr_title || `Proposal #${proposal.pr_number || proposal.id}`
  return <Card><CardHeader className="grid-cols-[1fr_auto] gap-3"><div className="min-w-0"><CardTitle className="truncate">{title}</CardTitle><CardDescription>{proposal.app_name}</CardDescription></div><Badge><PlatformIcon data-icon="inline-start" icon={Vote} size="xs" />{proposal.yes_count} / {votesRequired}</Badge></CardHeader><CardContent><Button render={<Link aria-label={`View ${title} proposal`} to={appDevProposalPath(proposal.app_slug, proposal.id)} />} size="sm" variant="outline">View proposal</Button></CardContent></Card>
}

function GovernanceRow({ proposal }: { proposal: WorkGovernance }) {
  const votesRequired = proposal.votes_required || proposal.majority || 1
  return <Card><CardHeader className="grid-cols-[1fr_auto] gap-3"><div className="min-w-0"><CardTitle className="truncate">{proposal.title}</CardTitle><CardDescription>{proposal.app_name}</CardDescription></div><Badge><PlatformIcon data-icon="inline-start" icon={Vote} size="xs" />{proposal.up_count} / {votesRequired}</Badge></CardHeader><CardContent><Button render={<Link aria-label={`View ${proposal.title} governance item`} to={appDevGovernancePath(proposal.app_slug, proposal.id)} />} size="sm" variant="outline">View governance</Button></CardContent></Card>
}
