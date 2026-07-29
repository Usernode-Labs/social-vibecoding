import { Activity, ExternalLink, ShieldAlert } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { PlatformIcon } from "@/components/platform-icon"
import { AdminAccessError, getAdminOverview, getAdminUser, type AdminOverview, type AdminUser } from "@/lib/admin-api"
import { Link } from "react-router-dom"

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

  return <div className="isolate mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6" data-testid="admin-overview">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <h1 className="text-balance text-3xl font-semibold tracking-tight">Operations</h1>
      {state.kind === "ready" ? <Button onClick={() => setReloadToken((value) => value + 1)} type="button" variant="outline">Refresh</Button> : null}
    </header>
    {state.kind === "loading" ? <Loading /> : null}
    {state.kind === "denied" ? <Alert><PlatformIcon icon={ShieldAlert} /><AlertTitle>Admin access required</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
    {state.kind === "error" ? <Alert variant="destructive"><AlertTitle>Operations unavailable</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
    {state.kind === "ready" ? <AdminOperationsOverview user={state.user} overview={state.overview} /> : null}
  </div>
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
    <section aria-label="Operations summary" className="grid gap-4 sm:grid-cols-3">
      <Metric title="Stuck apps" value={stuckApps.length} description="Creating or error state" />
      <Metric title="LLM spend today" value={formatMoney(overview.llmToday?.totalSpendCents)} description="Current UTC day" />
      <Metric title="Orphan workers" value={orphanWorkers.length} description="Needs operator attention" />
    </section>
    <section className="grid gap-4 lg:grid-cols-2">
      <ListCard title="Stuck apps" empty="No apps are stuck." items={stuckApps.map((app) => <div key={app.slug} className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-mono text-sm">{app.slug || "Unknown app"}</p><p className="text-sm text-muted-foreground">{app.dbStatus || "Unknown state"}{app.createdBy ? ` · created by ${app.createdBy}` : ""}</p></div><Badge variant="outline">{app.dbStatus || "Unknown"}</Badge></div>)} />
      <ListCard title="Orphan workers" empty="No orphan workers found." items={orphanWorkers.map((worker) => <div key={worker.name} className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-mono text-sm">{worker.name || "Unknown worker"}</p><p className="text-sm text-muted-foreground">{worker.appSlug ? `App ${worker.appSlug}` : "No associated app"}{worker.sessionArchived ? " · archived session" : ""}</p></div><Badge variant="outline">Up {formatUptime(worker.uptimeSeconds)}</Badge></div>)} />
      <ListCard title="Top LLM spenders today" empty="No LLM spend recorded today." items={spenders.slice(0, 5).map((spender, index) => <div key={`${spender.username}-${index}`} className="flex items-center justify-between gap-3"><span>{spender.username || "Unknown user"}</span><span className="font-mono text-sm text-muted-foreground">{formatMoney(spender.costCents)}</span></div>)} />
      <Card><CardHeader><CardTitle>Admin tools</CardTitle></CardHeader><CardContent className="flex flex-wrap gap-2">{legacyTools.map((tool) => <Button key={tool.href} render={tool.react ? <Link to={tool.href.replace("/react", "")} /> : <a href={tool.href} />} size="sm" variant="outline">{tool.label}{tool.react ? null : <PlatformIcon data-icon="inline-end" icon={ExternalLink} size="sm" />}</Button>)}</CardContent></Card>
    </section>
  </>
}

function Metric({ title, value, description }: { title: string; value: string | number; description: string }) {
  return <Card><CardHeader><CardDescription>{title}</CardDescription><CardTitle className="text-3xl tabular-nums">{value}</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground">{description}</CardContent></Card>
}

function ListCard({ title, empty, items }: { title: string; empty: string; items: ReactNode[] }) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle></CardHeader><CardContent>{items.length ? <div className="space-y-3">{items.map((item, index) => <div key={index} className="border-b pb-3 last:border-0 last:pb-0">{item}</div>)}</div> : <Empty className="border-0 py-3"><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={Activity} /></EmptyMedia><EmptyTitle>All clear</EmptyTitle><EmptyDescription>{empty}</EmptyDescription></EmptyHeader></Empty>}</CardContent></Card>
}
