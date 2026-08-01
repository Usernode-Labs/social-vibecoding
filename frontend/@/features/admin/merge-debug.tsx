import { ChevronDown, ChevronRight, ExternalLink, RefreshCw, ShieldAlert } from "lucide-react"
import { useEffect, useState } from "react"

import { ActionAnchor } from "@/components/action-link"
import { PlatformIcon } from "@/components/platform-icon"
import { TopBar } from "@/components/top-bar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { AdminAccessError, getAdminUser, getMergeDebugApps, getMergeRun, getMergeRuns, type MergeDebugApp, type MergeDebugStep, type MergeRun, type MergeRunsPage } from "@/lib/admin-api"

type State = { kind: "loading" } | { kind: "denied"; message: string } | { kind: "error"; message: string } | { kind: "ready"; apps: MergeDebugApp[]; page: MergeRunsPage }
type Filters = { app: string; prNumber: string; sessionId: string; outcome: string; kind: string }
const emptyFilters: Filters = { app: "", prNumber: "", sessionId: "", outcome: "", kind: "" }
const outcomes = ["running", "merged", "blocked", "conflict_resolving", "conflict_failed", "awaiting_github", "noop", "error", "pr_closed"]

function date(value?: string | null) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value)) : "Unknown time" }
function duration(run: MergeRun) { const start = run.started_at ? new Date(run.started_at).getTime() : 0; const end = run.ended_at ? new Date(run.ended_at).getTime() : Date.now(); const seconds = Math.max(0, Math.round((end - start) / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s` }
function variant(status?: string) { return status === "merged" ? "default" : status === "running" || status === "conflict_resolving" ? "secondary" : "outline" }

export function MergeDebugPage() {
  const [state, setState] = useState<State>({ kind: "loading" }); const [filters, setFilters] = useState<Filters>(emptyFilters); const [reload, setReload] = useState(0)
  const load = async (next = filters, append = false, cursor?: NonNullable<MergeRunsPage["nextCursor"]>) => {
    try { const page = await getMergeRuns({ ...next, before: cursor?.before, beforeId: cursor?.before_id }); setState((current) => current.kind === "ready" && append ? { ...current, page: { ...page, runs: [...current.page.runs, ...page.runs] } } : current.kind === "ready" ? { ...current, page } : current) } catch (cause) { setState({ kind: "error", message: cause instanceof Error ? cause.message : "Unable to load merge runs." }) }
  }
  useEffect(() => { const controller = new AbortController(); void (async () => { try { const [user, apps, page] = await Promise.all([getAdminUser(controller.signal), getMergeDebugApps(controller.signal), getMergeRuns({ ...filters, signal: controller.signal })]); void user; setState({ kind: "ready", apps: apps.apps, page }) } catch (cause) { if (cause instanceof DOMException && cause.name === "AbortError") return; setState(cause instanceof AdminAccessError ? { kind: "denied", message: cause.message } : { kind: "error", message: cause instanceof Error ? cause.message : "Unable to load merge runs." }) } })(); return () => controller.abort() }, [filters, reload])
  return <div className="isolate flex w-full flex-1 flex-col" data-testid="merge-debug"><TopBar action={state.kind === "ready" ? <Button onClick={() => setReload((value) => value + 1)} type="button" variant="outline">Refresh</Button> : undefined} title="Merge debug" /><div className="flex w-full flex-1 flex-col gap-6 px-4 py-4 antialiased sm:px-6">{state.kind === "loading" ? <><Skeleton className="h-24" /><Skeleton className="h-32" /></> : null}{state.kind === "denied" ? <Alert><PlatformIcon icon={ShieldAlert} /><AlertTitle>Admin access required</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}{state.kind === "error" ? <Alert variant="destructive"><AlertTitle>Merge diagnostics unavailable</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}{state.kind === "ready" ? <><DebugFilters apps={state.apps} filters={filters} onChange={setFilters} /><div className="flex justify-end"><ActionAnchor href="/debug">Open debug tools<PlatformIcon data-icon="inline-end" icon={ExternalLink} /></ActionAnchor></div><MergeRunList runs={state.page.runs} />{state.page.hasMore ? <Button className="self-center" onClick={() => void load(filters, true, state.page.nextCursor || undefined)} variant="outline">Load older</Button> : null}</> : null}</div></div>
}

function DebugFilters({ apps, filters, onChange }: { apps: MergeDebugApp[]; filters: Filters; onChange: (next: Filters) => void }) {
  const set = (key: keyof Filters, value: string) => onChange({ ...filters, [key]: value })
  return <section aria-label="Merge diagnostic filters" className="rounded-lg border p-3">
    <FieldGroup className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <Field className="gap-1">
        <FieldLabel htmlFor="merge-debug-app">App</FieldLabel>
        <Select onValueChange={(value) => set("app", value || "")} value={filters.app}>
          <SelectTrigger aria-label="Debug app" id="merge-debug-app"><SelectValue placeholder="All apps" /></SelectTrigger>
          <SelectContent><SelectGroup><SelectItem value="">All apps</SelectItem>{apps.map((app) => <SelectItem key={app.id} value={app.slug}>{app.name || app.slug}</SelectItem>)}</SelectGroup></SelectContent>
        </Select>
      </Field>
      <Field className="gap-1">
        <FieldLabel htmlFor="merge-debug-pr-number">PR #</FieldLabel>
        <Input aria-label="PR number" id="merge-debug-pr-number" inputMode="numeric" onChange={(event) => set("prNumber", event.target.value)} value={filters.prNumber} />
      </Field>
      <Field className="gap-1">
        <FieldLabel htmlFor="merge-debug-session-id">Session id</FieldLabel>
        <Input aria-label="Session id" id="merge-debug-session-id" inputMode="numeric" onChange={(event) => set("sessionId", event.target.value)} value={filters.sessionId} />
      </Field>
      <Field className="gap-1">
        <FieldLabel htmlFor="merge-debug-outcome">Outcome</FieldLabel>
        <Select onValueChange={(value) => set("outcome", value || "")} value={filters.outcome}>
          <SelectTrigger aria-label="Outcome" id="merge-debug-outcome"><SelectValue placeholder="Any outcome" /></SelectTrigger>
          <SelectContent><SelectGroup><SelectItem value="">Any outcome</SelectItem>{outcomes.map((value) => <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>)}</SelectGroup></SelectContent>
        </Select>
      </Field>
      <Field className="gap-1">
        <FieldLabel htmlFor="merge-debug-kind">Kind</FieldLabel>
        <Select onValueChange={(value) => set("kind", value || "")} value={filters.kind}>
          <SelectTrigger aria-label="Run kind" id="merge-debug-kind"><SelectValue placeholder="Any kind" /></SelectTrigger>
          <SelectContent><SelectGroup><SelectItem value="">Any kind</SelectItem><SelectItem value="merge">Merge</SelectItem><SelectItem value="conflict_resolution">Conflict resolution</SelectItem></SelectGroup></SelectContent>
        </Select>
      </Field>
    </FieldGroup>
  </section>
}

export function MergeRunList({ runs }: { runs: MergeRun[] }) { return !runs.length ? <Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={RefreshCw} /></EmptyMedia><EmptyTitle>No merge runs</EmptyTitle><EmptyDescription>No merge attempts match these filters.</EmptyDescription></EmptyHeader></Empty> : <section aria-label="Merge runs" className="space-y-3">{runs.map((run) => <MergeRunCard key={run.id} run={run} />)}</section> }

export function MergeRunCard({ run }: { run: MergeRun }) { const [open, setOpen] = useState(false); const [steps, setSteps] = useState<MergeDebugStep[] | null>(null); const [error, setError] = useState<string | null>(null); const toggle = async () => { if (!open && !steps) try { setSteps((await getMergeRun(run.id)).steps) } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load steps.") }; setOpen(!open) }; return <Card><CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><CardTitle className="text-lg">{run.app_name || run.app_slug || "Unknown app"} · {run.pr_number ? `PR #${run.pr_number}` : `Session ${run.session_id || "—"}`}</CardTitle><Badge variant={variant(run.status)}>{run.status || "unknown"}</Badge></div><CardDescription>{run.pr_title || "Untitled merge attempt"} · {run.kind?.replaceAll("_", " ") || "merge"} · {run.step_count ?? 0} steps · {date(run.started_at)} · {duration(run)}</CardDescription></div><Button aria-expanded={open} onClick={() => void toggle()} size="sm" variant="outline"><PlatformIcon data-icon="inline-start" icon={open ? ChevronDown : ChevronRight} />{open ? "Hide trace" : "View trace"}</Button></CardHeader>{open ? <CardContent>{error ? <Alert variant="destructive"><AlertTitle>Trace unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : <Trace steps={steps || []} />}</CardContent> : null}</Card> }
function Trace({ steps }: { steps: MergeDebugStep[] }) { return !steps.length ? <p className="text-sm text-muted-foreground">No steps recorded.</p> : <ol className="space-y-3 border-l pl-4">{steps.map((step) => <li className="relative text-sm" key={step.id}><span className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-muted-foreground" /><p className="font-mono text-xs text-muted-foreground">{step.phase || "step"} · {date(step.created_at)}</p><p>{step.message || "No message"}</p>{step.detail && Object.keys(step.detail).length ? <details className="mt-1"><summary className="cursor-pointer text-muted-foreground">Detail</summary><pre className="mt-2 overflow-auto rounded-md border bg-muted p-2 text-xs">{JSON.stringify(step.detail, null, 2)}</pre></details> : null}</li>)}</ol> }
