import { Activity, ExternalLink, ShieldAlert } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"

import { ActionAnchor, ActionLink } from "@/components/action-link"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Metric } from "@/components/metric"
import { TopBar } from "@/components/top-bar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { PlatformIcon } from "@/components/platform-icon"
import { AdminAccessError, getAdminOverview, getAdminUser, type AdminOverview, type AdminUser } from "@/lib/admin-api"

type State =
  | { kind: "loading" }
  | { kind: "denied"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; user: AdminUser; overview: AdminOverview }

const legacyTools = [
  { href: "/react/admin/users", label: "Users", react: true },
  { href: "/react/admin/codes", label: "Activation codes", react: true },
  { href: "/react/admin/limits", label: "Spend limits", react: true },
  { href: "/react/admin/features", label: "Submitted features", react: true },
  { href: "/react/admin/debug", label: "Merge debug", react: true },
  { href: "/react/admin/gallery", label: "Screenshot gallery", react: true },
  { href: "/dashboard", label: "Analytics dashboard" },
  { href: "/status", label: "Platform status" },
]

function formatMoney(cents?: number) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(Number(cents || 0) / 100)
}

function formatUptime(seconds?: number) {
  const minutes = Math.max(0, Math.round(Number(seconds || 0) / 60))
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function AdminOverviewPage() {
  const [state, setState] = useState<State>({ kind: "loading" })
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    void (async () => {
      try {
        const user = await getAdminUser(controller.signal)
        const overview = await getAdminOverview(controller.signal)
        if (!cancelled) setState({ kind: "ready", user, overview })
      } catch (cause) {
        if (cancelled || (cause instanceof DOMException && cause.name === "AbortError")) return
        const message = cause instanceof Error ? cause.message : "Unable to load operations."
        if (!cancelled) setState(cause instanceof AdminAccessError ? { kind: "denied", message } : { kind: "error", message })
      }
    })()
    return () => { cancelled = true; controller.abort() }
  }, [reloadToken])

  return <div className="isolate flex w-full flex-1 flex-col" data-testid="admin-overview">
    <TopBar action={state.kind === "ready" ? <Button onClick={() => setReloadToken((value) => value + 1)} type="button" variant="outline">Refresh</Button> : undefined} title="Operations" /><div className="flex w-full flex-1 flex-col gap-6 px-4 py-4 antialiased sm:px-6">
    {state.kind === "loading" ? <Loading /> : null}
    {state.kind === "denied" ? <Alert><PlatformIcon icon={ShieldAlert} /><AlertTitle>Admin access required</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
    {state.kind === "error" ? <Alert variant="destructive"><AlertTitle>Operations unavailable</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
    {state.kind === "ready" ? <AdminOperationsOverview user={state.user} overview={state.overview} /> : null}
  </div></div>
}

function Loading() {
  return <div className="grid gap-4 sm:grid-cols-3"><Skeleton className="h-32" /><Skeleton className="h-32" /><Skeleton className="h-32" /><Skeleton className="h-48 sm:col-span-3" /></div>
}

export function AdminOperationsOverview({ user, overview }: { user: AdminUser; overview: AdminOverview }) {
  const stuckApps = overview.stuckApps || []
  const orphanWorkers = overview.orphanWorkers || []
  const spenders = overview.llmToday?.users || []
  const isReadOnly = !user.canAdminWrite
  return <>
    {isReadOnly ? <Alert><PlatformIcon icon={ShieldAlert} /><AlertTitle>View-only administrator</AlertTitle><AlertDescription>You can inspect platform health. Mutating controls remain unavailable.</AlertDescription></Alert> : null}
    <dl aria-label="Operations summary" className="grid gap-4 rounded-4xl bg-container p-4 sm:grid-cols-3" data-surface="container">
      <Metric className="gap-2 [&_dd]:text-3xl" label={<span className="flex flex-col gap-1"><span>Stuck apps</span><span className="text-xs">Creating or error state</span></span>} numeric value={stuckApps.length} />
      <Metric className="gap-2 [&_dd]:text-3xl" label={<span className="flex flex-col gap-1"><span>LLM spend today</span><span className="text-xs">Current UTC day</span></span>} numeric value={formatMoney(overview.llmToday?.totalSpendCents)} />
      <Metric className="gap-2 [&_dd]:text-3xl" label={<span className="flex flex-col gap-1"><span>Orphan workers</span><span className="text-xs">Needs operator attention</span></span>} numeric value={orphanWorkers.length} />
    </dl>
    <section className="grid gap-4 lg:grid-cols-2">
      <ListCard title="Stuck apps" empty="No apps are stuck." items={stuckApps.map((app) => <div key={app.slug} className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-mono text-sm">{app.slug || "Unknown app"}</p><p className="text-sm text-muted-foreground">{app.dbStatus || "Unknown state"}{app.createdBy ? ` · created by ${app.createdBy}` : ""}</p></div><Badge variant="outline">{app.dbStatus || "Unknown"}</Badge></div>)} />
      <ListCard title="Orphan workers" empty="No orphan workers found." items={orphanWorkers.map((worker) => <div key={worker.name} className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-mono text-sm">{worker.name || "Unknown worker"}</p><p className="text-sm text-muted-foreground">{worker.appSlug ? `App ${worker.appSlug}` : "No associated app"}{worker.sessionArchived ? " · archived session" : ""}</p></div><Badge variant="outline">Up {formatUptime(worker.uptimeSeconds)}</Badge></div>)} />
      <ListCard title="Top LLM spenders today" empty="No LLM spend recorded today." items={spenders.slice(0, 5).map((spender, index) => <div key={`${spender.username}-${index}`} className="flex items-center justify-between gap-3"><span>{spender.username || "Unknown user"}</span><span className="font-mono text-sm text-muted-foreground">{formatMoney(spender.costCents)}</span></div>)} />
      <Card><CardHeader><CardTitle>Admin tools</CardTitle></CardHeader><CardContent className="flex flex-wrap gap-2">{legacyTools.map((tool) => tool.react
        ? <ActionLink key={tool.href} size="sm" to={tool.href.replace("/react", "")} variant="outline">{tool.label}</ActionLink>
        : <ActionAnchor href={tool.href} key={tool.href} size="sm" variant="outline">{tool.label}<PlatformIcon data-icon="inline-end" icon={ExternalLink} /></ActionAnchor>)}</CardContent></Card>
    </section>
  </>
}

function ListCard({ title, empty, items }: { title: string; empty: string; items: ReactNode[] }) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle></CardHeader><CardContent>{items.length ? <div className="space-y-3">{items.map((item, index) => <div key={index} className="border-b pb-3 last:border-0 last:pb-0">{item}</div>)}</div> : <Empty className="border-0 py-3"><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={Activity} /></EmptyMedia><EmptyTitle>All clear</EmptyTitle><EmptyDescription>{empty}</EmptyDescription></EmptyHeader></Empty>}</CardContent></Card>
}
