import { Activity, AppWindow, CircleAlert, Container, GitPullRequest, RefreshCw, Server, TriangleAlert, UsersRound, Wrench } from "lucide-react"
import { useEffect, useState } from "react"

import { PlatformIcon } from "@/components/platform-icon"
import { TopBar } from "@/components/top-bar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { getOperationalStatus, type OperationalApp, type OperationalNodeStatus, type OperationalStatus, type OperationalWorker, type StuckSession } from "@/lib/status-api"

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; snapshot: OperationalStatus }

function formatDuration(seconds?: number) {
  if (seconds == null || !Number.isFinite(seconds)) return "Not reported"
  const value = Math.max(0, Math.floor(seconds))
  if (value < 60) return `${value}s`
  const minutes = Math.floor(value / 60)
  if (minutes < 60) return `${minutes}m ${value % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function statusVariant(status?: string | null): "default" | "secondary" | "destructive" | "outline" {
  if (status === "running" || status === "Synced") return "secondary"
  if (status === "missing" || status === "unreachable" || status === "error") return "destructive"
  return "outline"
}

function Metric({ label, value, icon: Icon }: { label: string; value: string; icon: typeof AppWindow }) {
  return <Card size="sm"><CardHeader><div className="flex items-start justify-between gap-3"><div><CardDescription>{label}</CardDescription><CardTitle className="mt-1 text-2xl tabular-nums">{value}</CardTitle></div><PlatformIcon icon={Icon} /></div></CardHeader></Card>
}

function NodeCard({ node }: { node?: OperationalNodeStatus | null }) {
  if (!node) return <Card><CardHeader><CardTitle>Node</CardTitle><CardDescription>No node snapshot is currently available.</CardDescription></CardHeader></Card>
  const height = node.bestTipHeight == null ? "Not reported" : node.peerBestTipHeight == null ? node.bestTipHeight.toLocaleString() : `${node.bestTipHeight.toLocaleString()} / ${node.peerBestTipHeight.toLocaleString()}`
  return <Card><CardHeader><div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-start gap-2"><PlatformIcon icon={Server} /><div><CardTitle>Node</CardTitle><CardDescription>Cached sidecar health reported by the platform.</CardDescription></div></div><Badge variant={statusVariant(node.status)}>{node.status || "unknown"}</Badge></div></CardHeader><CardContent className="flex flex-col gap-3"><dl className="grid gap-3 text-sm sm:grid-cols-3"><MetricLine label="Peers" value={String(node.peers ?? "Not reported")} /><MetricLine label="Chain height" value={height} /><MetricLine label="Ledger" value={node.hasFullUtxoDb === false ? "Partial" : node.hasFullUtxoDb === true ? "Full" : "Not reported"} /></dl>{node.hasFullUtxoDb === false ? <Alert><PlatformIcon icon={TriangleAlert} /><AlertTitle>Partial ledger mode</AlertTitle><AlertDescription>The node may not observe every incoming transaction. Resolving it remains an operator action.</AlertDescription></Alert> : null}{node.error ? <Alert variant="destructive"><PlatformIcon icon={CircleAlert} /><AlertTitle>Node probe failed</AlertTitle><AlertDescription>{node.error}</AlertDescription></Alert> : null}</CardContent></Card>
}

function MetricLine({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 font-medium tabular-nums">{value}</dd></div>
}

function AppRow({ app }: { app: OperationalApp }) {
  const state = app.prod?.state || app.dbStatus || "unknown"
  return <li className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0"><p className="truncate font-medium">{app.name || app.slug || "Unnamed app"}</p><p className="text-sm text-muted-foreground">{app.openSessions ?? 0} sessions · {app.openIssues ?? 0} issues</p></div><Badge variant={statusVariant(state)}>{state}</Badge></li>
}

function WorkerRow({ worker }: { worker: OperationalWorker }) {
  const label = worker.appSlug ? `${worker.appSlug}${worker.sessionId == null ? "" : ` · session ${worker.sessionId}`}` : worker.sessionId == null ? "Worker" : `Session ${worker.sessionId}`
  return <li className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0"><p className="truncate font-medium">{label}</p><p className="text-sm text-muted-foreground">{worker.workerMode || worker.state || "unknown"} · {formatDuration(worker.uptimeSeconds)}</p></div><Badge variant={worker.orphan ? "destructive" : statusVariant(worker.state)}>{worker.orphan ? "orphan" : worker.state || "unknown"}</Badge></li>
}

function StuckRow({ session }: { session: StuckSession }) {
  return <li className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-medium">{session.appSlug || "Unknown app"} · session {session.id ?? "?"}</p><p className="text-sm text-muted-foreground">{session.branchName || "No branch reported"} · {formatDuration(session.ageSeconds)}</p></div><Badge variant="outline">stuck</Badge></li>
}

function StatusList({ title, description, icon: Icon, children }: { title: string; description: string; icon: typeof Wrench; children: React.ReactNode }) {
  return <Card><CardHeader><div className="flex items-start gap-2"><PlatformIcon icon={Icon} /><div><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></div></div></CardHeader><CardContent><ul className="flex flex-col gap-3">{children}</ul></CardContent></Card>
}

export function StatusContent({ snapshot }: { snapshot: OperationalStatus }) {
  const summary = snapshot.summary || {}
  const apps = snapshot.apps || []
  const workers = snapshot.workers || []
  const stuck = snapshot.stuckSessions || []
  const drift = snapshot.driftContainers || []
  return <><section aria-label="Operational summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Metric icon={AppWindow} label="Production apps" value={`${summary.prodRunning ?? 0} / ${summary.apps ?? 0}`} /><Metric icon={Container} label="Staging" value={`${summary.stagingRunning ?? 0} / ${summary.stagingCap ?? 0}`} /><Metric icon={Activity} label="Workers" value={String(summary.workersInFlight ?? summary.workersRunning ?? 0)} /><Metric icon={GitPullRequest} label="Stuck sessions" value={String(summary.stuckSessions ?? 0)} /></section>{snapshot.deployProgress?.deploying ? <Alert><PlatformIcon icon={RefreshCw} /><AlertTitle>Deploy in progress</AlertTitle><AlertDescription>Platform changes may take a minute to become available.</AlertDescription></Alert> : null}<section className="grid gap-4 xl:grid-cols-2"><NodeCard node={snapshot.node} /><StatusList description="Current production containers, as reported by the public snapshot." icon={AppWindow} title="Apps">{apps.length ? apps.map((app, index) => <AppRow app={app} key={app.slug || `${app.name}-${index}`} />) : <li className="text-sm text-muted-foreground">No apps reported.</li>}</StatusList><StatusList description="Worker identity and active progress text are intentionally not shown here." icon={Wrench} title="Workers">{workers.length ? workers.map((worker, index) => <WorkerRow key={`${worker.appSlug || "worker"}-${worker.sessionId || index}`} worker={worker} />) : <li className="text-sm text-muted-foreground">No workers running.</li>}</StatusList><StatusList description="Sessions that need attention. This page does not provide operator actions." icon={UsersRound} title="Stuck sessions">{stuck.length ? stuck.map((session, index) => <StuckRow key={`${session.appSlug || "session"}-${session.id || index}`} session={session} />) : <li className="text-sm text-muted-foreground">None reported.</li>}</StatusList></section>{drift.length ? <Alert variant="destructive"><PlatformIcon icon={TriangleAlert} /><AlertTitle>Container drift detected</AlertTitle><AlertDescription>{drift.map((item) => `${item.kind || "container"}: ${item.expected || "expected container missing"}`).join(" · ")}</AlertDescription></Alert> : null}<p className="text-sm text-muted-foreground">Sensitive host capacity, database, spend, event, model, and live worker-progress diagnostics remain outside this read-only React view.</p></>
}

export function StatusPage() {
  const [state, setState] = useState<State>({ kind: "loading" })
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    const refresh = async () => {
      try {
        const snapshot = await getOperationalStatus(controller.signal)
        if (!cancelled) setState({ kind: "ready", snapshot })
      } catch (cause) {
        if (cancelled || (cause instanceof DOMException && cause.name === "AbortError")) return
        setState({ kind: "error", message: cause instanceof Error ? cause.message : "Unable to load platform status." })
      }
    }
    void refresh()
    const interval = window.setInterval(() => { void refresh() }, 5_000)
    return () => { cancelled = true; controller.abort(); window.clearInterval(interval) }
  }, [refreshKey])

  return <div className="isolate flex w-full flex-1 flex-col" data-testid="operational-status"><TopBar action={<Button onClick={() => setRefreshKey((value) => value + 1)} size="sm" type="button" variant="outline"><PlatformIcon data-icon="inline-start" icon={RefreshCw} />Refresh</Button>} title="Platform status" /><div className="flex w-full flex-1 flex-col gap-6 px-4 py-4 antialiased sm:px-6"><p className="max-w-2xl text-pretty text-base text-muted-foreground sm:text-sm">A public, read-only operational snapshot. It refreshes every five seconds and never exposes privileged controls.</p>{state.kind === "loading" ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-72 sm:col-span-2 xl:col-span-4" /></div> : null}{state.kind === "error" ? <Alert variant="destructive"><PlatformIcon icon={CircleAlert} /><AlertTitle>Status unavailable</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}{state.kind === "ready" ? <StatusContent snapshot={state.snapshot} /> : null}</div></div>
}
