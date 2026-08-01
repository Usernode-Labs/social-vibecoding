import { ExternalLink, Image, ShieldAlert } from "lucide-react"
import { useCallback, useEffect, useState, type FormEvent } from "react"
import { Link } from "react-router-dom"

import { ActionAnchor } from "@/components/action-link"
import { PlatformIcon } from "@/components/platform-icon"
import { TopBar } from "@/components/top-bar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { gallerySurfaceKeys, type GallerySurfaceReadiness } from "@/features/admin/gallery-media-readiness"
import { GalleryVisualEvidence } from "@/features/admin/gallery-visual-evidence"
import { AdminAccessError, getAdminUser } from "@/lib/admin-api"
import { appDevPath, appDevProposalPath } from "@/lib/routes"
import { galleryProblems, getGalleryApps, getGalleryProposals, getGalleryStats, type GalleryApp, type GalleryFilters, type GalleryPage, type GalleryProposal, type GalleryStats } from "@/lib/gallery-api"

type AccessState =
  | { kind: "loading" }
  | { kind: "denied"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready" }

type PageState = { page: GalleryPage | null; loading: boolean; error: string | null }

const emptyFilters: GalleryFilters = { app: "", problem: "" }
const pageLimit = 20
const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" })

function date(value?: string | null) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "Date not reported"
  return dateFormatter.format(new Date(value))
}

function captureState(state?: string | null): { label: string; variant: "secondary" | "destructive" | "outline" } {
  if (state === "captured") return { label: "Captured", variant: "secondary" }
  if (state === "partial") return { label: "Partial", variant: "outline" }
  if (state === "console_only") return { label: "No visual change expected", variant: "outline" }
  if (state === "failed") return { label: "Capture failed", variant: "destructive" }
  return { label: "Outcome unknown", variant: "outline" }
}

export function GalleryFiltersPanel({ apps, disabled, draft, onChange, onSubmit }: { apps: GalleryApp[]; disabled: boolean; draft: GalleryFilters; onChange: (next: GalleryFilters) => void; onSubmit: () => void }) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onSubmit()
  }
  return <form aria-label="Screenshot gallery filters" className="rounded-lg border p-4" onSubmit={submit}><FieldGroup className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"><Field><FieldLabel>App</FieldLabel><Select disabled={disabled} onValueChange={(value) => onChange({ ...draft, app: value || "" })} value={draft.app || ""}><SelectTrigger aria-label="Filter by app"><SelectValue placeholder="All apps" /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="">All apps</SelectItem>{apps.map((app) => <SelectItem key={app.id} value={app.slug || String(app.id)}>{app.name || app.slug || `App ${app.id}`}{app.proposal_count == null ? "" : ` (${app.proposal_count})`}</SelectItem>)}</SelectGroup></SelectContent></Select></Field><Field><FieldLabel>Capture problem</FieldLabel><Select disabled={disabled} onValueChange={(value) => onChange({ ...draft, problem: value as GalleryFilters["problem"] })} value={draft.problem || ""}><SelectTrigger aria-label="Filter by capture problem"><SelectValue placeholder="Any capture outcome" /></SelectTrigger><SelectContent><SelectGroup>{galleryProblems.map((problem) => <SelectItem key={problem.value || "all"} value={problem.value}>{problem.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field><Field className="self-end"><Button disabled={disabled} type="submit">Apply filters</Button></Field></FieldGroup></form>
}

function GalleryStatsStrip({ stats }: { stats: GalleryStats }) {
  const total = stats.total || 0
  const items = [
    ["Matching proposals", total],
    ["Complete", stats.complete || 0],
    ["Missing recording", stats.missing_recording || 0],
    ["Missing before", stats.missing_before || 0],
    ["Fallback before", stats.before_fell_back || 0],
    ["Front page only", stats.root_only || 0],
    ["Failed or skipped", stats.failed_or_skipped || 0],
    ...(stats.unknown_state ? [["Outcome not recorded", stats.unknown_state]] : []),
  ]
  return <dl aria-label="Capture reliability summary" className="grid gap-x-5 gap-y-3 rounded-lg border px-4 py-3 text-base/7 sm:grid-cols-2 sm:text-sm/6 lg:grid-cols-4">{items.map(([label, value]) => <div key={label as string}><dt className="truncate text-muted-foreground">{label}</dt><dd className="mt-0.5 font-medium tabular-nums">{value as number}</dd></div>)}</dl>
}

function GalleryProposalCard({ proposal }: { proposal: GalleryProposal }) {
  const [readySurfaceKeys, setReadySurfaceKeys] = useState<ReadonlySet<string>>(() => new Set())
  const mediaSurfaceKeys = gallerySurfaceKeys(proposal.visuals)
  const state = captureState(proposal.captureState)
  const appLabel = proposal.appName || proposal.appSlug || `App ${proposal.appId || "unknown"}`
  const mediaReady = mediaSurfaceKeys.length > 0 && mediaSurfaceKeys.every((key) => readySurfaceKeys.has(key))
  const showCaptureState = proposal.captureState !== "captured" || mediaReady
  const updateSurfaceReadiness = useCallback((surfaceId: string, readiness: GallerySurfaceReadiness) => setReadySurfaceKeys((current) => {
    const ready = readiness === "ready"
    if (current.has(surfaceId) === ready) return current
    const next = new Set(current)
    if (ready) next.add(surfaceId)
    else next.delete(surfaceId)
    return next
  }), [])
  return <article><Card><CardHeader className="gap-3"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><CardTitle className="text-balance text-xl tracking-tight">{proposal.title || `Proposal ${proposal.id}`}</CardTitle><CardDescription>{appLabel} · {date(proposal.mergedAt)}</CardDescription></div>{showCaptureState ? <Badge data-testid={`gallery-capture-state-${proposal.id}`} variant={state.variant}>{state.label}</Badge> : null}</div><div className="flex flex-wrap gap-2"><Button render={proposal.appSlug ? <Link to={appDevPath(proposal.appSlug)} /> : <span />} size="sm" variant="outline" disabled={!proposal.appSlug}>Improve app</Button><Button render={proposal.appSlug ? <Link to={appDevProposalPath(proposal.appSlug, proposal.id)} /> : <span />} size="sm" variant="outline" disabled={!proposal.appSlug}>Open proposal</Button>{proposal.prUrl ? <ActionAnchor href={proposal.prUrl} rel="noopener noreferrer" size="sm" target="_blank">{proposal.prNumber == null ? "Open pull request" : `PR #${proposal.prNumber}`}<PlatformIcon data-icon="inline-end" icon={ExternalLink} /></ActionAnchor> : null}</div>{proposal.captureReason ? <CardDescription>{proposal.captureReason}</CardDescription> : null}</CardHeader><CardContent><GalleryVisualEvidence onSurfaceReadinessChange={updateSurfaceReadiness} visuals={proposal.visuals} /></CardContent></Card></article>
}

function GalleryProposalList({ proposals }: { proposals: GalleryProposal[] }) {
  if (!proposals.length) return <Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={Image} /></EmptyMedia><EmptyTitle>No merged proposals match these filters</EmptyTitle><EmptyDescription>Try a different app or capture-problem filter.</EmptyDescription></EmptyHeader></Empty>
  return <section aria-label="Merged proposal captures" className="flex flex-col gap-4">{proposals.map((proposal) => <GalleryProposalCard key={proposal.id} proposal={proposal} />)}</section>
}

function GalleryContent() {
  const [apps, setApps] = useState<GalleryApp[]>([])
  const [appsError, setAppsError] = useState<string | null>(null)
  const [draft, setDraft] = useState<GalleryFilters>(emptyFilters)
  const [filters, setFilters] = useState<GalleryFilters>(emptyFilters)
  const [reload, setReload] = useState(0)
  const [pageState, setPageState] = useState<PageState>({ page: null, loading: true, error: null })
  const [stats, setStats] = useState<GalleryStats | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void getGalleryApps(controller.signal).then((payload) => { setApps(payload.apps || []); setAppsError(null) }).catch((cause) => {
      if (cause instanceof DOMException && cause.name === "AbortError") return
      setAppsError(cause instanceof Error ? cause.message : "Unable to load app filters.")
    })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    setPageState((current) => ({ ...current, loading: true, error: null }))
    setOlderError(null)
    void (async () => {
      const [pageResult, statsResult] = await Promise.allSettled([
        getGalleryProposals({ ...filters, limit: pageLimit }, controller.signal),
        getGalleryStats(filters, controller.signal),
      ])
      if (cancelled) return
      if (pageResult.status === "fulfilled") setPageState({ page: pageResult.value, loading: false, error: null })
      else if (!(pageResult.reason instanceof DOMException && pageResult.reason.name === "AbortError")) setPageState({ page: null, loading: false, error: pageResult.reason instanceof Error ? pageResult.reason.message : "Unable to load screenshot gallery." })
      if (statsResult.status === "fulfilled") { setStats(statsResult.value.stats || null); setStatsError(null) }
      else if (!(statsResult.reason instanceof DOMException && statsResult.reason.name === "AbortError")) { setStats(null); setStatsError("Capture reliability summary is unavailable.") }
    })()
    return () => { cancelled = true; controller.abort() }
  }, [filters, reload])

  async function loadOlder() {
    const cursor = pageState.page?.nextCursor
    if (!cursor || loadingOlder) return
    setLoadingOlder(true)
    setOlderError(null)
    try {
      const next = await getGalleryProposals({ ...filters, limit: pageLimit, before: cursor.before, beforeId: cursor.before_id })
      setPageState((current) => current.page ? { page: { ...next, proposals: [...current.page.proposals, ...next.proposals] }, loading: false, error: null } : current)
    } catch (cause) {
      setOlderError(cause instanceof Error ? cause.message : "Unable to load older proposals.")
    } finally {
      setLoadingOlder(false)
    }
  }

  return <div className="isolate flex w-full flex-1 flex-col" data-testid="admin-gallery"><TopBar action={<div className="flex flex-wrap gap-2"><ActionAnchor href="/gallery" size="sm" variant="outline">Open gallery<PlatformIcon data-icon="inline-end" icon={ExternalLink} /></ActionAnchor><Button onClick={() => setReload((value) => value + 1)} size="sm" type="button" variant="outline">Refresh</Button></div>} title="Screenshot gallery" /><div className="flex w-full flex-1 flex-col gap-6 px-4 py-4 antialiased sm:px-6"><GalleryFiltersPanel apps={apps} disabled={pageState.loading} draft={draft} onChange={setDraft} onSubmit={() => setFilters(draft)} />{appsError ? <p className="text-base/7 text-muted-foreground sm:text-sm/6" role="status">App filters are unavailable. You can still review all proposals.</p> : null}{stats ? <GalleryStatsStrip stats={stats} /> : null}{statsError ? <p className="text-base/7 text-muted-foreground sm:text-sm/6" role="status">{statsError}</p> : null}{pageState.loading && !pageState.page ? <div className="flex flex-col gap-4"><Skeleton className="h-28" /><Skeleton className="h-96" /><Skeleton className="h-96" /></div> : null}{pageState.error ? <Alert variant="destructive"><PlatformIcon icon={ShieldAlert} /><AlertTitle>Screenshot gallery unavailable</AlertTitle><AlertDescription>{pageState.error}</AlertDescription></Alert> : null}{pageState.page ? <><GalleryProposalList proposals={pageState.page.proposals} />{pageState.page.hasMore ? <div className="flex flex-col items-center gap-3"><Button disabled={loadingOlder} onClick={() => void loadOlder()} type="button" variant="outline">{loadingOlder ? "Loading older proposals…" : "Load older"}</Button>{olderError ? <p className="text-base/7 text-muted-foreground sm:text-sm/6" role="status">Older proposals could not be loaded.</p> : null}</div> : null}</> : null}</div></div>
}

export function GalleryPage() {
  const [access, setAccess] = useState<AccessState>({ kind: "loading" })
  useEffect(() => {
    const controller = new AbortController()
    void getAdminUser(controller.signal).then(() => setAccess({ kind: "ready" })).catch((cause) => {
      if (cause instanceof DOMException && cause.name === "AbortError") return
      setAccess(cause instanceof AdminAccessError ? { kind: "denied", message: cause.message } : { kind: "error", message: cause instanceof Error ? cause.message : "Unable to verify gallery access." })
    })
    return () => controller.abort()
  }, [])
  if (access.kind === "ready") return <GalleryContent />
  return <div className="isolate flex w-full flex-1 flex-col" data-testid="admin-gallery"><TopBar title="Screenshot gallery" /><div className="flex w-full flex-1 flex-col gap-6 px-4 py-4 antialiased sm:px-6">{access.kind === "loading" ? <div className="flex flex-col gap-4"><Skeleton className="h-24" /><Skeleton className="h-72" /></div> : null}{access.kind === "denied" ? <Alert><PlatformIcon icon={ShieldAlert} /><AlertTitle>Admin access required</AlertTitle><AlertDescription>{access.message}</AlertDescription></Alert> : null}{access.kind === "error" ? <Alert variant="destructive"><AlertTitle>Screenshot gallery unavailable</AlertTitle><AlertDescription>{access.message}</AlertDescription></Alert> : null}</div></div>
}
