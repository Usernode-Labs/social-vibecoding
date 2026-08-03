import { CircleAlert, RadioTower, Server, TriangleAlert } from "lucide-react"
import { useEffect, useState } from "react"

import { PlatformIcon } from "@/components/platform-icon"
import { Metric } from "@/components/metric"
import { TopBar } from "@/components/top-bar"
import { StatusDot } from "@/components/status-dot"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { nodePresentationStatus } from "@/features/platform/node-presentation-status"
import { servicePresentationStatus, type KnownServiceLifecycleState } from "@/features/platform/service-presentation-status"
import { getNodeStatusSnapshot, type ExplorerStatusSnapshot, type NodeStatusSnapshot, type NodeStatusSnapshotFull } from "@/lib/node-status-api"

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; snapshot: NodeStatusSnapshotFull }

function humanDuration(milliseconds?: number | null) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function formatAt(timestamp?: number | null) {
  return timestamp ? new Date(timestamp).toLocaleTimeString() : "Not reported"
}

function NodeSnapshot({ node }: { node: NodeStatusSnapshot | null | undefined }) {
  if (!node) return <Card><CardHeader><CardTitle>Node</CardTitle><CardDescription>Node data unavailable</CardDescription></CardHeader></Card>
  const height = node.bestTipHeight == null ? "Not reported" : node.peerBestTipHeight == null ? node.bestTipHeight.toLocaleString() : `${node.bestTipHeight.toLocaleString()} / ${node.peerBestTipHeight.toLocaleString()}`
  return <Card><CardHeader><div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-start gap-2"><PlatformIcon icon={Server} /><CardTitle>Node</CardTitle></div><StatusDot subject="Node" {...nodePresentationStatus(node.status)} /></div></CardHeader><CardContent className="space-y-4"><dl className="grid gap-3 text-base sm:grid-cols-2 sm:text-sm"><Metric label="Peers" value={String(node.peers ?? "Not reported")} /><Metric label="Chain height" value={height} numeric /><Metric label="First synced" value={node.hasBeenSynced ? "Yes" : "Not yet"} /><Metric label="UTXO database" value={node.hasFullUtxoDb === true ? "Full" : node.hasFullUtxoDb === false ? "Partial" : "Not reported"} /></dl>{node.hasFullUtxoDb === false ? <Alert><PlatformIcon icon={TriangleAlert} /><AlertTitle>Partial UTXO database</AlertTitle><AlertDescription>The node may not observe every incoming transaction until the full UTXO database is available.</AlertDescription></Alert> : null}{node.error ? <Alert variant="destructive"><PlatformIcon icon={CircleAlert} /><AlertTitle>Node unavailable</AlertTitle><AlertDescription>{node.error}</AlertDescription></Alert> : null}</CardContent></Card>
}

function ExplorerSnapshot({ explorer }: { explorer: ExplorerStatusSnapshot | null | undefined }) {
  if (!explorer) return <Card><CardHeader><CardTitle>Explorer</CardTitle><CardDescription>Explorer data unavailable</CardDescription></CardHeader></Card>
  return <Card><CardHeader><div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-start gap-2"><PlatformIcon icon={RadioTower} /><div><CardTitle>Explorer</CardTitle><CardDescription>{explorer.host || "Explorer endpoint"}</CardDescription></div></div><StatusDot subject="Explorer" {...servicePresentationStatus(explorer.status)} /></div></CardHeader><CardContent className="space-y-4"><dl className="grid gap-3 text-base sm:grid-cols-2 sm:text-sm"><Metric label="Chain" value={explorer.chainId || "Not reported"} /><Metric label="Latency" value={explorer.latencyMs == null ? "Not reported" : `${explorer.latencyMs}ms`} numeric /><Metric label="Connected once" value={explorer.hasBeenOk ? "Yes" : "Not yet"} /></dl>{explorer.error ? <Alert variant="destructive"><PlatformIcon icon={CircleAlert} /><AlertTitle>Explorer unavailable</AlertTitle><AlertDescription><span>The explorer did not respond.</span><span className="mt-1 block text-muted-foreground">Technical detail: {explorer.error}</span></AlertDescription></Alert> : null}</CardContent></Card>
}

function servicePresentation(value: unknown): { detail?: string; state: KnownServiceLifecycleState | string } {
  if (!value || typeof value !== "object") return { state: "unknown" }
  const source = value as Record<string, unknown>
  if (typeof source.enabled === "boolean") return { state: source.enabled ? "enabled" : "disabled" }
  if (typeof source.loaded === "boolean") return source.loaded ? { detail: `${typeof source.count === "number" ? source.count.toLocaleString() : ""} records loaded`.trim(), state: "loaded" } : { state: "not-loaded" }
  if (typeof source.status === "string") return { state: source.status }
  return { state: "unknown" }
}

function serviceTitle(name: string) {
  return name.replace(/([A-Z])/g, " $1").replace(/^./, (character) => character.toUpperCase())
}

function humanizeEnum(value?: string | null) {
  const words = value?.trim().replaceAll(/[-_]+/g, " ") || "Unknown"
  return `${words.slice(0, 1).toLocaleUpperCase()}${words.slice(1)}`
}

export function NodeStatusContent({ snapshot }: { snapshot: NodeStatusSnapshotFull }) {
  const server = snapshot.server
  const services = Object.entries(snapshot.services || {})
  return <><section aria-label="Status overview" className="grid gap-4 sm:grid-cols-3"><Card><CardHeader><CardDescription>Environment</CardDescription><CardTitle>{humanizeEnum(server?.mode)}</CardTitle></CardHeader></Card><Card><CardHeader><CardDescription>Uptime</CardDescription><CardTitle className="tabular-nums">{humanDuration(server?.uptimeMs)}</CardTitle></CardHeader></Card><Card><CardHeader><CardDescription>Updated</CardDescription><CardTitle className="tabular-nums">{formatAt(snapshot.at)}</CardTitle></CardHeader></Card></section><section aria-label="Chain services" className="grid gap-4 lg:grid-cols-2"><NodeSnapshot node={snapshot.node} /><ExplorerSnapshot explorer={snapshot.explorer} /></section>{services.length ? <section aria-labelledby="chain-services-heading" className="space-y-3"><h3 className="text-xl font-semibold" id="chain-services-heading">Chain-dependent services</h3><div className="grid gap-4 sm:grid-cols-2">{services.map(([name, service]) => { const title = serviceTitle(name); const presentation = servicePresentation(service); return <Card key={name} size="sm"><CardHeader><CardTitle>{title}</CardTitle><StatusDot detail={presentation.detail} subject={title} {...servicePresentationStatus(presentation.state)} /></CardHeader></Card> })}</div></section> : null}</>
}

export function NodeStatusPage() {
  const [state, setState] = useState<State>({ kind: "loading" })
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    const refresh = async () => {
      try {
        const snapshot = await getNodeStatusSnapshot(controller.signal)
        if (!cancelled) setState({ kind: "ready", snapshot })
      } catch (cause) {
        if (cancelled || (cause instanceof DOMException && cause.name === "AbortError")) return
        setState({ kind: "error", message: cause instanceof Error ? cause.message : "Unable to load node status." })
      }
    }
    void refresh()
    const interval = window.setInterval(() => { void refresh() }, 2_000)
    return () => { cancelled = true; controller.abort(); window.clearInterval(interval) }
  }, [refreshKey])

  return <div className="isolate flex w-full flex-1 flex-col" data-testid="node-status">
    <TopBar action={<Button onClick={() => setRefreshKey((value) => value + 1)} size="sm" type="button" variant="outline">Refresh</Button>} title="Node" /><div className="flex w-full flex-1 flex-col gap-6 px-4 py-4 antialiased sm:px-6">
    {state.kind === "loading" ? <div className="grid gap-4 sm:grid-cols-3"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-56 sm:col-span-3" /></div> : null}
    {state.kind === "error" ? <Alert variant="destructive"><PlatformIcon icon={CircleAlert} /><AlertTitle>Status unavailable</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
    {state.kind === "ready" ? <NodeStatusContent snapshot={state.snapshot} /> : null}
  </div></div>
}
