import { ArrowLeft, ExternalLink, FlaskConical, RefreshCw, TriangleAlert } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"

import { useDevConsoleFrame } from "@/hooks/use-dev-console-frame"
import { DevConsoleTrigger } from "@/components/dev-console-provider"
import { PlatformIcon } from "@/components/platform-icon"
import { TopBar } from "@/components/top-bar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { getIframeToken, waitForHostedTls } from "@/lib/apps-api"
import { resolveDevHost } from "@/lib/dev-host"
import { ensureDevStaging, getDevSession, type DevSession } from "@/lib/dev-chat-api"
import { isProductionReadOnlyReview } from "@/lib/runtime-mode"

function safeTestingPath(value: string | null | undefined) {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : null
}

function previewSource(stagingUrl: string | null | undefined, token: string | null, path: string | null) {
  if (!stagingUrl) return null
  try {
    const base = new URL(resolveDevHost(stagingUrl))
    const source = new URL(path || "/", base)
    if (source.origin !== base.origin) return null
    if (token) source.searchParams.set("token", token)
    return source.toString()
  } catch { return null }
}

async function waitForPreviewUrl(sessionId: string, initial: DevSession, alive: () => boolean) {
  let current = initial
  const started = Date.now()
  while (alive() && Date.now() - started < 180000) {
    if (current.staging_url) return current
    await new Promise((resolve) => window.setTimeout(resolve, 3000))
    current = (await getDevSession(sessionId)).session
  }
  return current
}

/**
 * Full-screen responsive staging preview. Normal migration environments retain
 * the server-owned rebuild endpoint and cert-readiness wait. Production review
 * mode intentionally opens only an already-live preview: rebuilding creates
 * containers, writes session state, and starts capture work.
 */
export function StagingPreview() {
  const { slug = "", sessionId = "" } = useParams()
  const navigate = useNavigate()
  const iframe = useRef<HTMLIFrameElement>(null)
  const [session, setSession] = useState<DevSession | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [frameRevision, setFrameRevision] = useState(0)
  const [state, setState] = useState<"loading" | "rebuilding" | "provisioning" | "ready" | "error">("loading")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const load = async () => {
      try {
        const initial = await getDevSession(sessionId, controller.signal)
        if (initial.session.app_slug !== slug) throw new Error("This session does not belong to the selected app")
        if (cancelled) return
        setSession(initial.session)
        let resolved = initial.session
        if (isProductionReadOnlyReview) {
          if (!resolved.staging_url) throw new Error("No preview is available for this session.")
        } else {
          const ensured = await ensureDevStaging(sessionId, controller.signal)
          if (ensured.status === "unavailable") throw new Error(ensured.reason === "demo" ? "Live previews can’t be rebuilt in this demo environment." : "This preview isn’t available right now.")
          resolved = { ...initial.session, staging_url: ensured.url || initial.session.staging_url }
          if (ensured.status === "rebuilding") {
            setState("rebuilding")
            resolved = await waitForPreviewUrl(sessionId, resolved, () => !cancelled)
          }
        }
        if (!resolved.staging_url) throw new Error("The preview couldn’t be rebuilt.")
        if (cancelled) return
        setSession(resolved)
        setState("provisioning")
        if (!await waitForHostedTls(resolved.staging_url, { alive: () => !cancelled, resolveHost: resolveDevHost })) {
          throw new Error("The secure preview is taking longer than expected. Return to the session and try again in a moment.")
        }
        const iframeToken = await getIframeToken(slug, controller.signal)
        if (cancelled) return
        setToken(iframeToken)
        setState("ready")
      } catch (cause) {
        if (cancelled || (cause instanceof DOMException && cause.name === "AbortError")) return
        setError(cause instanceof Error ? cause.message : "Unable to open staging preview")
        setState("error")
      }
    }
    void load()
    return () => { cancelled = true; controller.abort() }
  }, [sessionId, slug])

  const source = useMemo(() => previewSource(session?.staging_url, token, safeTestingPath(session?.testing_path)), [session, token])
  useDevConsoleFrame(slug, iframe, state === "ready" && Boolean(source), frameRevision)
  const testingInstructions = session?.testing_md?.trim() || null
  const back = `/apps/${encodeURIComponent(slug)}/dev/sessions/${encodeURIComponent(sessionId)}`
  const topBar = { onBack: () => navigate(back), title: "Staging preview" }
  if (error) return <><TopBar {...topBar} /><div className="flex flex-1 items-center justify-center" data-slot="staging-preview-surface" data-state="error"><Alert className="max-w-md" variant="destructive"><PlatformIcon icon={TriangleAlert} /><AlertTitle>Preview unavailable</AlertTitle><AlertDescription className="flex flex-wrap items-center gap-3">{error}<Button render={<Link to={back} />} variant="outline"><PlatformIcon data-icon="inline-start" icon={ArrowLeft} />Return to session</Button></AlertDescription></Alert></div></>
  if (state !== "ready" || !source) return <><TopBar {...topBar} /><div className="flex flex-1 items-center justify-center" data-slot="staging-preview-surface" data-state={state}><Card className="w-full max-w-md"><CardHeader><CardTitle className="flex items-center gap-2"><PlatformIcon icon={state === "rebuilding" ? RefreshCw : FlaskConical} size="sm" />{state === "rebuilding" ? "Spinning the preview back up…" : "Provisioning secure preview…"}</CardTitle></CardHeader><CardContent className="flex flex-col gap-4 text-muted-foreground"><p>{state === "rebuilding" ? "Rebuilding from this session’s latest changes. This usually takes 20–60 seconds." : "Preparing preview."}</p><Skeleton className="h-8 w-full" /><Button className="w-fit" render={<Link to={back} />} variant="outline"><PlatformIcon data-icon="inline-start" icon={ArrowLeft} />Return to session</Button></CardContent></Card></div></>
  return <div className="isolate flex w-full flex-1 flex-col" data-slot="staging-preview-surface" data-state="ready" data-testid="staging-preview">
    <TopBar
      {...topBar}
      action={<>
        <div className="status-surface rounded-full border" data-slot="staged-console-control" data-status-tone="info"><DevConsoleTrigger /></div>
        <Button render={<a href={source} rel="noreferrer" target="_blank" />} size="sm" variant="outline"><PlatformIcon data-icon="inline-start" icon={ExternalLink} />Open externally</Button>
      </>}
    /><div className="status-surface flex min-h-0 flex-1 flex-col border bg-[var(--status-surface)] p-1 sm:p-2" data-slot="staged-content-boundary" data-status-tone="info">
      <div className="flex min-h-8 shrink-0 items-center gap-2 px-2"><Badge variant="outline">Staged</Badge><span className="text-xs text-current/80">Review environment</span></div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-background">
        {testingInstructions ? <div className="shrink-0 border-b px-4" data-slot="staging-preview-instructions"><Accordion><AccordionItem value="testing"><AccordionTrigger>How to test this change</AccordionTrigger><AccordionContent><pre className="whitespace-pre-wrap font-sans text-sm text-muted-foreground">{testingInstructions}</pre></AccordionContent></AccordionItem></Accordion></div> : null}
        <iframe allow="clipboard-write; pointer-lock" className="min-h-0 flex-1 border-0" data-slot="staging-preview-frame" onLoad={() => setFrameRevision((revision) => revision + 1)} ref={iframe} sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-pointer-lock" src={source} title="Staging preview" />
      </div>
    </div></div>
}
