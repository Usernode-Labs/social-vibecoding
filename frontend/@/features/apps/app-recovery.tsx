import { LoaderCircle, Wrench } from "lucide-react"
import { useEffect, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"

import { PlatformIcon } from "@/components/platform-icon"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { AppContextChrome, appContextState } from "@/features/apps/app-context-chrome"
import { getApp, retryFailedApp, type AppDetail } from "@/lib/apps-api"
import { appDetailsPath } from "@/lib/routes"
import { isProductionReadOnlyReview } from "@/lib/runtime-mode"

type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; app: AppDetail }

/**
 * Deliberately narrow recovery route. It does not expose app deletion,
 * secrets, redeploy, or configuration changes: the existing retry endpoint
 * only transitions a failed app back to the server-owned creation worker.
 */
export function AppRecovery() {
  const { slug = "" } = useParams()
  const navigate = useNavigate()
  const [state, setState] = useState<State>({ kind: "loading" })
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setState({ kind: "loading" }); setRetryError(null)
    void getApp(slug, controller.signal).then(({ app }) => {
      if (!controller.signal.aborted) setState({ kind: "ready", app })
    }).catch((cause: unknown) => {
      if (controller.signal.aborted || (cause instanceof DOMException && cause.name === "AbortError")) return
      setState({ kind: "error", message: cause instanceof Error ? cause.message : "Unable to load this app." })
    })
    return () => controller.abort()
  }, [slug])

  const app = state.kind === "ready" ? state.app : null
  const canRetry = Boolean(app?.can_manage) && app?.status === "error" && !isProductionReadOnlyReview && !retrying
  async function retry() {
    if (!app || !canRetry) return
    setRetrying(true); setRetryError(null)
    try {
      await retryFailedApp(app.slug)
      navigate(appDetailsPath(app.slug), { replace: true })
    } catch (cause) { setRetryError(cause instanceof Error ? cause.message : "Unable to retry the app.") } finally { setRetrying(false) }
  }

  return <div className="isolate flex w-full flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6" data-testid="app-recovery">
    {state.kind === "loading" ? <><Skeleton className="h-40 w-full" /><Skeleton className="h-10 w-36" /></> : null}
    {state.kind === "error" ? <Alert variant="destructive"><AlertTitle>App unavailable</AlertTitle><AlertDescription>{state.message}</AlertDescription></Alert> : null}
    {app ? <AppContextChrome app={app} backTo={appDetailsPath(app.slug)} label="Repair app setup" mode="nested" state={appContextState(app)} /> : null}
    {app && app.status !== "error" ? <Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={Wrench} /></EmptyMedia><EmptyTitle>This app does not need setup repair</EmptyTitle><EmptyDescription>Only an app currently in the failed state can be retried.</EmptyDescription></EmptyHeader></Empty> : null}
    {app && app.status === "error" ? <Card><CardHeader><CardTitle className="flex flex-wrap items-center gap-2"><span className="text-balance">{app.name}</span><Badge variant="outline">Setup failed</Badge></CardTitle><CardDescription>Retry setup from the last failed step.</CardDescription></CardHeader><CardContent className="space-y-3">{isProductionReadOnlyReview ? <Alert data-testid="app-recovery-production-review"><AlertTitle>Read-only</AlertTitle><AlertDescription>Setup retry is unavailable.</AlertDescription></Alert> : null}{app.lastFailure?.reason ? <Alert variant="destructive"><AlertTitle>Latest failure</AlertTitle><AlertDescription>{app.lastFailure.reason}</AlertDescription></Alert> : <p className="text-sm text-muted-foreground">No failure reason is available.</p>}{!app.can_manage ? <Alert><AlertTitle>Manager access required</AlertTitle><AlertDescription>Only the app creator, an app administrator, or a write administrator can retry setup.</AlertDescription></Alert> : null}{retryError ? <Alert variant="destructive"><AlertTitle>Retry was not started</AlertTitle><AlertDescription>{retryError}</AlertDescription></Alert> : null}</CardContent><CardFooter><Button disabled={!canRetry} onClick={() => void retry()} type="button">{retrying ? <PlatformIcon className="animate-spin" data-icon="inline-start" icon={LoaderCircle} /> : null}{retrying ? "Starting retry…" : "Retry setup"}</Button></CardFooter></Card> : null}
  </div>
}
