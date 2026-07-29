import { CircleAlert, RadioTower, RefreshCw, Server, TriangleAlert } from "lucide-react"
import { useEffect, useState } from "react"

import { PlatformIcon } from "@/components/platform-icon"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
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

function statusVariant(status?: string | null): "default" | "secondary" | "destructive" | "outline" {
  if (status === "Synced" || status === "ok") return "secondary"
  if (status === "unreachable" || status === "bad_response") return "destructive"
  return "outline"
}

function statusTitle(status?: string | null) {
  return status || "unknown"
}

function NodeSnapshot({ node }: { node: NodeStatusSnapshot | null | undefined }) {
  if (!node) return <Card><CardHeader><CardTitle>Node</CardTitle><CardDescription>No sidecar probe data is currently available.</CardDescription></CardHeader></Card>
  const height = node.bestTipHeight == null ? "Not reported" : node.peerBestTipHeight == null ? node.bestTipHeight.toLocaleString() : `${node.bestTipHeight.toLocaleString()} / ${node.peerBestTipHeight.toLocaleString()}`
  return <Card><CardHeader><div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-start gap-2"><PlatformIcon icon={Server} /><div><CardTitle>Node</CardTitle><CardDescription>Local sidecar status, read from the platform cache.</CardDescription></div></div><Badge variant={statusVariant(node.status)}>{statusTitle(node.status)}</Badge></div></CardHeader><CardContent className="space-y-4"><dl className="grid gap-3 text-base sm:grid-cols-2 sm:text-sm"><Metric label="Peers" value={String(node.peers ?? "Not reported")} /><Metric label="Chain height" value={height} numeric /><Metric label="First synced" value={node.hasBeenSynced ? "Yes" : "Not yet"} /><Metric label="UTXO database" value={node.hasFullUtxoDb === true ? "Full" : node.hasFullUtxoDb === false ? "Partial" : "Not reported"} /></dl>{node.hasFullUtxoDb === false ? <Alert><PlatformIcon icon={TriangleAlert} /><AlertTitle>Partial UTXO database</AlertTitle><AlertDescription>The node may not observe every incoming transaction. This status is reported by the sidecar; resolving it remains an operator action.</AlertDescription></Alert> : null}{node.error ? <Alert variant="destructive"><PlatformIcon icon={CircleAlert} /><AlertTitle>Node probe failed</AlertTitle><AlertDescription>{node.error}</AlertDescription></Alert> : null}</CardContent></Card>
}

function ExplorerSnapshot({ explorer }: { explorer: ExplorerStatusSnapshot | null | undefined }) {
  if (!explorer) return <Card><CardHeader><CardTitle>Explorer</CardTitle><CardDescription>No explorer probe data is currently available.</CardDescription></CardHeader></Card>
  return <Card><CardHeader><div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-start gap-2"><PlatformIcon icon={RadioTower} /><div><CardTitle>Explorer</CardTitle><CardDescription>{explorer.host || "Configured explorer endpoint"}</CardDescription></div></div><Badge variant={statusVariant(explorer.status)}>{statusTitle(explorer.status)}</Badge></div></CardHeader><CardContent className="space-y-4"><dl className="grid gap-3 text-base sm:grid-cols-2 sm:text-sm"><Metric label="Chain" value={explorer.chainId || "Not reported"} /><Metric label="Latency" value={explorer.latencyMs == null ? "Not reported" : `${explorer.latencyMs}ms`} numeric /><Metric label="Connected once" value={explorer.hasBeenOk ? "Yes" : "Not yet"} /></dl>{explorer.error ? <Alert variant="destructive"><PlatformIcon icon={CircleAlert} /><AlertTitle>Explorer probe failed</AlertTitle><AlertDescription>{explorer.error}</AlertDescription></Alert> : null}</CardContent></Card>
}

function Metric({ label, value, numeric = false }: { label: string; value: string; numeric?: boolean }) {
  return <div><dt className="text-muted-foreground">{label}</dt><dd className={numeric ? "mt-1 font-medium tabular-nums" : "mt-1 font-medium"}>{value}</dd></div>
}

function serviceDescription(value: unknown) {
  if (!value || typeof value !== "object") return "No details reported."
  const source = value as Record<string, unknown>
  if (typeof source.enabled === "boolean") return source.enabled ? "Enabled" : "Disabled"
  if (typeof source.loaded === "boolean") return source.loaded ? `${typeof source.count === "number" ? source.count.toLocaleString() : ""} records loaded`.trim() : "Not loaded"
  return "Status reported by the platform."
}

export function NodeStatusContent({ snapshot }: { snapshot: NodeStatusSnapshotFull }) {
  const server = snapshot.server
  const services = Object.entries(snapshot.services || {})
  return <><section aria-label="Status overview" className="grid gap-4 sm:grid-cols-3"><Card><CardHeader><CardDescription>Environment</CardDescription><CardTitle>{server?.mode || "Unknown"}</CardTitle></CardHeader></Card><Card><CardHeader><CardDescription>Uptime</CardDescription><CardTitle className="tabular-nums">{humanDuration(server?.uptimeMs)}</CardTitle></CardHeader></Card><Card><CardHeader><CardDescription>Last platform snapshot</CardDescription><CardTitle className="tabular-nums">{formatAt(snapshot.at)}</CardTitle></CardHeader></Card></section><section aria-label="Chain services" className="grid gap-4 lg:grid-cols-2"><NodeSnapshot node={snapshot.node} /><ExplorerSnapshot explorer={snapshot.explorer} /></section>{services.length ? <section aria-labelledby="chain-services-heading" className="space-y-3"><div className="space-y-1"><h3 className="text-xl font-semibold" id="chain-services-heading">Chain-dependent services</h3><p className="text-base text-muted-foreground sm:text-sm">Background services that depend on chain data.</p></div><div className="grid gap-4 sm:grid-cols-2">{services.map(([name, service]) => <Card key={name} size="sm"><CardHeader><CardTitle>{name.replace(/([A-Z])/g, " $1").replace(/^./, (character) => character.toUpperCase())}</CardTitle><CardDescription>{serviceDescription(service)}</CardDescription></CardHeader></Card>)}</div></section> : null}</>
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

  return <main className="isolate mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6" data-testid="node-status">
    <header className="flex flex-wrap items-start justify-between gap-4"><div className="space-y-2"><h2 className="text-balance text-3xl font-semibold tracking-tight">Node status</h2><p className="max-w-[56ch] text-base text-muted-foreground text-pretty">A read-only view of cached platform, node, and explorer health. It refreshes every two seconds.</p></div><Button onClick={() => setRefreshKey((value) => value + 1)} size="sm" type="button" variant="outline"><PlatformIcon data-icon="inline-start" icon={RefreshCw} />Refresh</Button></header>
    {state.kind === "loading" ? <div className="grid gap-4 sm:grid-cols-3"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-56 sm:col-span-3" /></div> : null}
    {state.kind === "error" ? <Alert variant="destructive"><PlatformIcon icon={CircleAlert} /><AlertTitle>Status unavailable</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
    {state.kind === "ready" ? <NodeStatusContent snapshot={state.snapshot} /> : null}
  </main>
}
