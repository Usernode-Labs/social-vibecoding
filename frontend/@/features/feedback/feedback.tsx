import { ArrowLeft, ExternalLink, Lightbulb, Send, ShieldAlert } from "lucide-react"
import { useEffect, useRef, useState, type FormEvent } from "react"
import { Link, useSearchParams } from "react-router-dom"

import { PlatformIcon } from "@/components/platform-icon"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { getApp, type AppDetail } from "@/lib/apps-api"
import { getFeedbackTitlePreview, submitFeedback, type FeedbackTarget } from "@/lib/feedback-api"
import { isProductionReadOnlyReview } from "@/lib/runtime-mode"

type AppContext =
  | { kind: "none" }
  | { kind: "loading"; slug: string }
  | { kind: "ready"; app: AppDetail }
  | { kind: "unavailable"; slug: string }

function canTargetApp(app: AppDetail) {
  return !app.self_hosted && /github\.com\/[^/]+\/[^/]+/.test(app.repo_url || "")
}

export function Feedback() {
  const [searchParams] = useSearchParams()
  const requestedApp = searchParams.get("app")?.trim() || null
  const [appContext, setAppContext] = useState<AppContext>(() => requestedApp ? { kind: "loading", slug: requestedApp } : { kind: "none" })
  const [target, setTarget] = useState<FeedbackTarget>("platform")
  const [description, setDescription] = useState("")
  const [title, setTitle] = useState("")
  const [titleDirty, setTitleDirty] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState<{ url?: string; title?: string } | null>(null)
  const previewSequence = useRef(0)

  useEffect(() => {
    let cancelled = false
    if (!requestedApp) {
      setAppContext({ kind: "none" })
      setTarget("platform")
      return
    }
    setAppContext({ kind: "loading", slug: requestedApp })
    getApp(requestedApp).then(({ app }) => {
      if (cancelled) return
      setAppContext({ kind: "ready", app })
      setTarget(canTargetApp(app) ? "app" : "platform")
    }).catch(() => { if (!cancelled) setAppContext({ kind: "unavailable", slug: requestedApp }) })
    return () => { cancelled = true }
  }, [requestedApp])

  useEffect(() => {
    const normalized = description.trim()
    if (isProductionReadOnlyReview || titleDirty || normalized.length < 12 || submitting) return
    const controller = new AbortController()
    const sequence = ++previewSequence.current
    const timer = window.setTimeout(() => {
      void getFeedbackTitlePreview(normalized, controller.signal).then((generated) => {
        if (!controller.signal.aborted && sequence === previewSequence.current && generated) setTitle(generated)
      }).catch(() => undefined)
    }, 700)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [description, submitting, titleDirty])

  const appTarget = appContext.kind === "ready" && canTargetApp(appContext.app) ? appContext.app : null
  const chosenTarget: FeedbackTarget = target === "app" && appTarget ? "app" : "platform"

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const body = description.trim()
    if (!body || submitting || isProductionReadOnlyReview) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await submitFeedback({ description: body, title, target: chosenTarget, ...(chosenTarget === "app" && appTarget ? { appSlug: appTarget.slug } : {}) })
      setSubmitted(result)
      setDescription("")
      setTitle("")
      setTitleDirty(false)
      previewSequence.current += 1
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to send feedback")
    } finally {
      setSubmitting(false)
    }
  }

  return <main className="isolate mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6" data-testid="feedback">
    <header className="flex flex-col gap-3"><Button className="w-fit" render={<Link to={requestedApp ? `/apps/${encodeURIComponent(requestedApp)}` : "/"} />} size="sm" variant="ghost"><PlatformIcon data-icon="inline-start" icon={ArrowLeft} />Back</Button><div className="flex flex-col gap-2"><h2 className="text-balance text-3xl font-semibold tracking-tight">Send feedback</h2><p className="max-w-[60ch] text-base text-muted-foreground text-pretty">Report a problem or suggest an improvement. The existing feedback service files a GitHub issue with the target you choose.</p></div></header>
    {isProductionReadOnlyReview ? <Alert data-testid="feedback-production-review"><PlatformIcon icon={ShieldAlert} /><AlertTitle>Production review mode</AlertTitle><AlertDescription>Feedback is not submitted while this local review is read-only.</AlertDescription></Alert> : null}
    {appContext.kind === "loading" ? <Card><CardHeader><CardTitle>Checking feedback context</CardTitle><CardDescription>Loading the app target.</CardDescription></CardHeader><CardContent><Skeleton className="h-8 w-full" /></CardContent></Card> : null}
    {appContext.kind === "unavailable" ? <Alert><PlatformIcon icon={Lightbulb} /><AlertTitle>Sending platform feedback</AlertTitle><AlertDescription>The requested app is not available here, so feedback will be filed against Social Vibecoding instead.</AlertDescription></Alert> : null}
    <form onSubmit={submit}><Card><CardHeader><CardTitle>What should improve?</CardTitle><CardDescription>A title is optional. When left editable, the server may suggest one from your description; submitting never depends on that suggestion.</CardDescription></CardHeader><CardContent><FieldGroup><Field><FieldLabel>Feedback target</FieldLabel><ToggleGroup aria-label="Feedback target" disabled={isProductionReadOnlyReview} value={[chosenTarget]} variant="outline"><ToggleGroupItem onClick={() => setTarget("platform")} value="platform">Social Vibecoding</ToggleGroupItem><ToggleGroupItem disabled={!appTarget} onClick={() => setTarget("app")} value="app">{appTarget ? `This app (${appTarget.name})` : "This app"}</ToggleGroupItem></ToggleGroup><FieldDescription>{appTarget ? "App feedback files to the app’s connected GitHub repository. Platform feedback files to the Social Vibecoding repository." : "An app target is available only for an open, non-self-hosted app with a connected GitHub repository."}</FieldDescription></Field><Field><FieldLabel htmlFor="feedback-title">Title <span className="text-muted-foreground">(optional)</span></FieldLabel><Input disabled={submitting || isProductionReadOnlyReview} id="feedback-title" maxLength={200} onChange={(event) => { setTitle(event.target.value); setTitleDirty(event.target.value.trim().length > 0) }} placeholder="Describe the issue briefly" value={title} /><FieldDescription>Up to 200 characters.</FieldDescription></Field><Field data-invalid={!!error}><FieldLabel htmlFor="feedback-description">Feedback</FieldLabel><Textarea disabled={submitting || isProductionReadOnlyReview} id="feedback-description" maxLength={2000} onChange={(event) => setDescription(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} placeholder="Describe the issue or suggestion…" required value={description} /><FieldDescription>{description.length}/2000 characters. Press Command or Control + Enter to submit.</FieldDescription>{error ? <FieldError>{error}</FieldError> : null}</Field></FieldGroup></CardContent><CardFooter className="flex flex-wrap justify-end gap-2"><Button disabled={!description.trim() || submitting || isProductionReadOnlyReview} type="submit"><PlatformIcon data-icon="inline-start" icon={Send} />{submitting ? "Submitting…" : "Submit feedback"}</Button></CardFooter></Card></form>
    {submitted ? <Alert data-testid="feedback-success"><PlatformIcon icon={Lightbulb} /><AlertTitle>Thanks for the feedback</AlertTitle><AlertDescription className="flex flex-wrap items-center gap-2">{submitted.title ? `Filed “${submitted.title}”.` : "Your feedback was filed."}{submitted.url ? <Button render={<a href={submitted.url} rel="noreferrer" target="_blank" />} size="sm" variant="outline">View issue<PlatformIcon data-icon="inline-end" icon={ExternalLink} /></Button> : null}</AlertDescription></Alert> : null}
  </main>
}
