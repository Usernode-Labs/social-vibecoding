import { ExternalLink, ListTodo, ShieldAlert } from "lucide-react"
import { useCallback, useEffect, useState } from "react"

import { PlatformIcon } from "@/components/platform-icon"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { AdminAccessError, getAdminUser, getAllSubmittedFeatures, getSubmittedFeatures, type AdminUser, type SubmittedFeature, type SubmittedFeatureStatus } from "@/lib/admin-api"
import { isProductionReadOnlyReview } from "@/lib/runtime-mode"

type State =
  | { kind: "loading" }
  | { kind: "denied"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; user: AdminUser; features: SubmittedFeature[]; total: number }

const statuses: Array<{ value: SubmittedFeatureStatus; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "open", label: "Open" },
  { value: "completed", label: "Completed" },
  { value: "closed", label: "Closed" },
]

function formatDate(value?: string | null) {
  if (!value) return "Unknown date"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date)
}

function featureStatus(status?: string) {
  if (status === "completed") return "default"
  if (status === "open") return "secondary"
  return "outline"
}

function csvCell(value: unknown) {
  const text = value == null ? "" : String(value)
  return `"${text.replaceAll('"', '""')}"`
}

function csv(features: SubmittedFeature[]) {
  const rows = [
    ["Rank", "Title", "Status", "Description", "App", "App slug", "Submitted by", "Submitted", "GitHub issue", "Up votes", "Down votes"],
    ...features.map((feature, index) => [index + 1, feature.title, feature.status, feature.description, feature.app_name, feature.app_slug, feature.created_by_username, feature.created_at, feature.github_issue_number, feature.up_count ?? 0, feature.down_count ?? 0]),
  ]
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`
}

function downloadCsv(features: SubmittedFeature[], status: SubmittedFeatureStatus) {
  const url = URL.createObjectURL(new Blob([csv(features)], { type: "text/csv;charset=utf-8" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `submitted-features-${status}.csv`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function AdminFeaturesPage() {
  const [state, setState] = useState<State>({ kind: "loading" })
  const [status, setStatus] = useState<SubmittedFeatureStatus>("all")
  const [reloadToken, setReloadToken] = useState(0)
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    void (async () => {
      try {
        const [user, page] = await Promise.all([getAdminUser(controller.signal), getSubmittedFeatures(status, { signal: controller.signal })])
        if (!cancelled) setState({ kind: "ready", user, features: page.features, total: page.total })
      } catch (cause) {
        if (cancelled || (cause instanceof DOMException && cause.name === "AbortError")) return
        const message = cause instanceof Error ? cause.message : "Unable to load submitted features."
        if (!cancelled) setState(cause instanceof AdminAccessError ? { kind: "denied", message } : { kind: "error", message })
      }
    })()
    return () => { cancelled = true; controller.abort() }
  }, [reloadToken, status])

  const exportCsv = useCallback(async () => {
    setDownloading(true)
    setDownloadError(null)
    try {
      const features = await getAllSubmittedFeatures(status)
      downloadCsv(features, status)
    } catch (cause) {
      setDownloadError(cause instanceof Error ? cause.message : "Unable to download submitted features.")
    } finally {
      setDownloading(false)
    }
  }, [status])

  return <div className="isolate mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6" data-testid="admin-features">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-2"><h1 className="text-balance text-3xl font-semibold tracking-tight">Submitted features</h1><p className="text-base text-muted-foreground text-pretty">Cross-app feature requests ranked by community support.</p></div>
      {state.kind === "ready" ? <Button onClick={() => setReloadToken((value) => value + 1)} type="button" variant="outline">Refresh</Button> : null}
    </header>
    {state.kind === "loading" ? <div className="space-y-3"><Skeleton className="h-10 w-40" /><Skeleton className="h-36 w-full" /><Skeleton className="h-36 w-full" /></div> : null}
    {state.kind === "denied" ? <Alert><PlatformIcon icon={ShieldAlert} /><AlertTitle>Admin access required</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
    {state.kind === "error" ? <Alert variant="destructive"><AlertTitle>Submitted features unavailable</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
    {state.kind === "ready" ? <>
      {!state.user.canAdminWrite ? <Alert><PlatformIcon icon={ShieldAlert} /><AlertTitle>View-only administrator</AlertTitle><AlertDescription>You can inspect ranked feature requests and download this read-only report.</AlertDescription></Alert> : null}
      {isProductionReadOnlyReview ? <Alert><PlatformIcon icon={ShieldAlert} /><AlertTitle>Read-only</AlertTitle><AlertDescription>Feature requests cannot be changed here.</AlertDescription></Alert> : null}
      <section aria-label="Submitted feature controls" className="flex flex-wrap items-end justify-between gap-3">
        <label className="grid gap-1 text-sm font-medium" htmlFor="submitted-feature-status">Status
          <Select onValueChange={(value) => setStatus(value as SubmittedFeatureStatus)} value={status}>
            <SelectTrigger aria-label="Feature status" id="submitted-feature-status"><SelectValue /></SelectTrigger>
            <SelectContent>{statuses.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
        </label>
        <div className="flex flex-wrap gap-2"><Button disabled={downloading} onClick={() => void exportCsv()} type="button" variant="outline">{downloading ? "Preparing CSV…" : "Download CSV"}</Button><Button render={<a href="/admin-features" />} variant="outline">Open feature requests<PlatformIcon data-icon="inline-end" icon={ExternalLink} /></Button></div>
      </section>
      {downloadError ? <Alert variant="destructive"><AlertTitle>CSV unavailable</AlertTitle><AlertDescription>{downloadError}</AlertDescription></Alert> : null}
      <p className="text-sm text-muted-foreground">{state.total} {state.total === 1 ? "request" : "requests"}.</p>
      <SubmittedFeaturesList features={state.features} />
    </> : null}
  </div>
}

export function SubmittedFeaturesList({ features }: { features: SubmittedFeature[] }) {
  if (!features.length) return <Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={ListTodo} /></EmptyMedia><EmptyTitle>No submitted features</EmptyTitle><EmptyDescription>There are no feature requests in this status yet.</EmptyDescription></EmptyHeader></Empty>
  return <section aria-label="Submitted features" className="space-y-3">{features.map((feature, index) => <Card key={feature.id}>
    <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0 space-y-1"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">#{index + 1}</Badge><CardTitle className="text-lg">{feature.title}</CardTitle></div><CardDescription>{feature.app_name || "Unknown app"}{feature.app_slug ? ` · ${feature.app_slug}` : ""} · submitted by {feature.created_by_username || "Unknown member"} · {formatDate(feature.created_at)}</CardDescription></div><Badge variant={featureStatus(feature.status)}>{feature.status || "Unknown"}</Badge></CardHeader>
    <CardContent className="grid gap-3"><p className="text-sm text-foreground whitespace-pre-wrap">{feature.description || "No description provided."}</p><dl className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-3"><div><dt>Support</dt><dd className="mt-1 font-medium text-foreground tabular-nums">{feature.up_count ?? 0} up · {feature.down_count ?? 0} down</dd></div><div><dt>GitHub issue</dt><dd className="mt-1 font-medium text-foreground">{feature.github_issue_number ? `#${feature.github_issue_number}` : "Not linked"}</dd></div><div><dt>Kind</dt><dd className="mt-1 font-medium text-foreground">{feature.kind || "general"}</dd></div></dl></CardContent>
  </Card>)}</section>
}
