import { ExternalLink, Lightbulb } from "lucide-react"
import { useEffect, useRef, useState, type FormEvent } from "react"
import { useSearchParams } from "react-router-dom"

import { ActionAnchor } from "@/components/action-link"
import { PlatformIcon } from "@/components/platform-icon"
import { TopBar } from "@/components/top-bar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
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

  return <div className="isolate flex w-full flex-1 flex-col" data-testid="feedback">
    <TopBar title="Send feedback" /><div className="flex w-full flex-1 flex-col gap-6 px-4 py-4 antialiased sm:px-6">
    {isProductionReadOnlyReview ? <Alert data-testid="feedback-production-review"><AlertTitle>Read-only</AlertTitle><AlertDescription>Feedback submission is unavailable.</AlertDescription></Alert> : null}
    {appContext.kind === "loading" ? <Card><CardHeader><CardTitle>Checking feedback context</CardTitle></CardHeader><CardContent><Skeleton className="h-8 w-full" /></CardContent></Card> : null}
    {appContext.kind === "unavailable" ? <Alert><PlatformIcon icon={Lightbulb} /><AlertTitle>Sending platform feedback</AlertTitle><AlertDescription>The requested app is not available here, so feedback will be filed against Social Vibecoding instead.</AlertDescription></Alert> : null}
    <FeedbackFormView
      appTarget={appTarget}
      description={description}
      disabled={isProductionReadOnlyReview}
      error={error}
      onDescriptionChange={setDescription}
      onSubmit={submit}
      onTargetChange={setTarget}
      onTitleChange={(value) => { setTitle(value); setTitleDirty(value.trim().length > 0) }}
      submitting={submitting}
      target={chosenTarget}
      title={title}
    />
    {submitted ? <Alert data-testid="feedback-success"><PlatformIcon icon={Lightbulb} /><AlertTitle>Thanks for the feedback</AlertTitle><AlertDescription className="flex flex-wrap items-center gap-2">{submitted.title ? `Filed “${submitted.title}”.` : "Your feedback was filed."}{submitted.url ? <ActionAnchor href={submitted.url} rel="noreferrer" size="sm" target="_blank">View issue<PlatformIcon data-icon="inline-end" icon={ExternalLink} /></ActionAnchor> : null}</AlertDescription></Alert> : null}
  </div></div>
}

export function FeedbackFormView({
  appTarget,
  description,
  disabled,
  error,
  onDescriptionChange,
  onSubmit,
  onTargetChange,
  onTitleChange,
  submitting,
  target,
  title,
}: {
  appTarget: AppDetail | null
  description: string
  disabled: boolean
  error: string | null
  onDescriptionChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onTargetChange: (target: FeedbackTarget) => void
  onTitleChange: (value: string) => void
  submitting: boolean
  target: FeedbackTarget
  title: string
}) {
  return <form aria-label="Send feedback" onSubmit={onSubmit}><Card><CardHeader><CardTitle>What should improve?</CardTitle></CardHeader><CardContent><FieldGroup><Field><FieldLabel>Feedback target</FieldLabel><ToggleGroup aria-label="Feedback target" disabled={disabled} value={[target]} variant="outline"><ToggleGroupItem onClick={() => onTargetChange("platform")} value="platform">Social Vibecoding</ToggleGroupItem><ToggleGroupItem disabled={!appTarget} onClick={() => onTargetChange("app")} value="app">{appTarget ? `This app (${appTarget.name})` : "This app"}</ToggleGroupItem></ToggleGroup><FieldDescription>{appTarget ? "App feedback files to the app’s connected GitHub repository. Platform feedback files to the Social Vibecoding repository." : "An app target is available only for an open, non-self-hosted app with a connected GitHub repository."}</FieldDescription></Field><Field><FieldLabel htmlFor="feedback-title">Title <span className="text-muted-foreground">(optional)</span></FieldLabel><Input disabled={submitting || disabled} id="feedback-title" maxLength={200} onChange={(event) => onTitleChange(event.target.value)} placeholder="Describe the issue briefly" value={title} /><FieldDescription>Title is optional. We may suggest one as you type.</FieldDescription></Field><Field data-invalid={!!error}><FieldLabel htmlFor="feedback-description">Feedback</FieldLabel><Textarea disabled={submitting || disabled} id="feedback-description" maxLength={2000} onChange={(event) => onDescriptionChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} placeholder="Describe the issue or suggestion…" required value={description} /><FieldDescription>{description.length}/2000 characters. Press Command or Control + Enter to submit.</FieldDescription>{error ? <FieldError>{error}</FieldError> : null}</Field></FieldGroup></CardContent><CardFooter className="flex flex-wrap justify-end gap-2"><Button disabled={!description.trim() || submitting || disabled} type="submit">{submitting ? "Submitting…" : "Submit feedback"}</Button></CardFooter></Card></form>
}
