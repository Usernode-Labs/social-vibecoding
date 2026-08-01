import { Archive, CheckCircle2, ChevronRight, Eye, EyeOff, MessagesSquare, MoreHorizontal, OctagonX, Pause, Play, RefreshCw, RotateCcw, Send } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom"

import { PlatformIcon } from "@/components/platform-icon"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { AppTopBar } from "@/features/apps/app-top-bar"
import { DevConversation, type ConversationMessage } from "@/features/dev/dev-conversation"
import { DevComposer, type DevSuggestionGroup } from "@/features/dev/dev-composer"
import { DevSessionActivity } from "@/features/dev/dev-session-activity"
import { DevBuildTimeline } from "@/features/dev/dev-build-timeline"
import { DevVisualEvidence } from "@/features/dev/dev-visual-evidence"
import { devSessionFixture } from "@/features/dev/dev-session-fixture"
import { useDevSessionStream } from "@/features/dev/use-dev-session-stream"
import { useDevSessionStatus } from "@/features/dev/use-dev-session-status"
import { getApp, type AppDetail } from "@/lib/apps-api"
import { changeDevSessionLifecycle, getDevSession, promoteDevSession, recheckDevSession, setDevSessionVisibility, stopDevTurn, type DevSessionLifecycleAction, type DevSessionResponse } from "@/lib/dev-chat-api"
import { appDevPath } from "@/lib/routes"
import { isProductionReadOnlyReview } from "@/lib/runtime-mode"

function sessionTitle(session: DevSessionResponse["session"]) {
  return session.session_title || session.pr_title || session.branch_name || `Session #${session.id}`
}

const starterQuickReplies = [
  "What issues are open right now?",
  "Change the colors",
  "Add a new feature",
  "Fix something that's broken",
]

function currentQuickReplies(
  messages: ConversationMessage[],
  status: string | undefined,
  streaming: boolean,
) {
  if (streaming || (status !== "active" && status !== "promoted")) return []
  let sawConversationMessage = false
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const candidates = message.metadata?.quickReplies
    if (Array.isArray(candidates)) {
      const replies = candidates
        .filter((candidate): candidate is string => typeof candidate === "string")
        .map((candidate) => candidate.trim())
        .filter(Boolean)
        .slice(0, 4)
      if (replies.length) return replies
    }
    if (message.role === "user" || message.role === "assistant") {
      sawConversationMessage = true
      break
    }
  }
  return sawConversationMessage ? [] : starterQuickReplies
}

function currentSuggestions(
  messages: ConversationMessage[],
  status: string | undefined,
  streaming: boolean,
): DevSuggestionGroup[] {
  if (streaming || (status !== "active" && status !== "promoted")) return []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === "system") continue
    if (message.role !== "assistant" || !Array.isArray(message.metadata?.suggestions)) return []
    return message.metadata.suggestions.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return []
      const row = candidate as Record<string, unknown>
      if (!Array.isArray(row.answers)) return []
      const answers = row.answers
        .filter((answer): answer is string => typeof answer === "string")
        .map((answer) => answer.trim())
        .filter(Boolean)
        .slice(0, 6)
      if (!answers.length) return []
      return [{
        question: typeof row.question === "string" ? row.question.trim() : "",
        answers,
      }]
    }).slice(0, 5)
  }
  return []
}

export function DevSession() {
  const { slug = "", sessionId = "" } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [data, setData] = useState<DevSessionResponse | null>(null)
  const [app, setApp] = useState<AppDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lifecycleError, setLifecycleError] = useState<string | null>(null)
  const [lifecycleNotice, setLifecycleNotice] = useState<string | null>(null)
  const [lifecycleAction, setLifecycleAction] = useState<DevSessionLifecycleAction | null>(null)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<string | null>(null)
  const [promoting, setPromoting] = useState(false)
  const [promoteError, setPromoteError] = useState<string | null>(null)
  const [promoteOpen, setPromoteOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [unarchiveOpen, setUnarchiveOpen] = useState(false)
  const [visibilityUpdating, setVisibilityUpdating] = useState(false)
  const [visibilityError, setVisibilityError] = useState<string | null>(null)
  const [rechecking, setRechecking] = useState(false)
  const [recheckOpen, setRecheckOpen] = useState(false)
  const [recheckError, setRecheckError] = useState<string | null>(null)
  const [recheckNotice, setRecheckNotice] = useState<string | null>(null)
  const useFixture = import.meta.env.DEV && searchParams.get("fixture") === "conversation"

  const reload = useCallback(() => {
    if (useFixture) return
    return getDevSession(sessionId).then((response) => {
      setData(response)
      setError(null)
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Unable to refresh this development session")
    })
  }, [sessionId, useFixture])
  const { buildLines, estimate, liveMessages, streamState } = useDevSessionStream({
    enabled: !useFixture && Boolean(data),
    messages: data?.messages || [],
    onComplete: reload,
    sessionId,
  })
  const sessionStatus = useDevSessionStatus(sessionId, !useFixture && Boolean(data))

  const updateLifecycle = async (action: DevSessionLifecycleAction) => {
    if (!data || lifecycleAction || isProductionReadOnlyReview) return
    setLifecycleAction(action)
    setLifecycleError(null)
    setLifecycleNotice(null)
    try {
      const result = await changeDevSessionLifecycle(sessionId, action)
      if (result.keptPromoted) {
        setLifecycleNotice("The worker was freed. This session stays promoted while its proposal remains open for voting.")
      } else if (result.alreadyPaused) {
        setLifecycleNotice("This session was already paused.")
      } else if (action === "unarchive") {
        setLifecycleNotice(result.ccPurged
          ? "Session restored. Retained files had expired, so the next turn will start fresh."
          : result.prReopened
            ? "Session restored and its pull request was reopened."
            : "Session restored. Resume it when you are ready to continue.")
      }
      if (action === "archive") {
        setArchiveOpen(false)
        navigate(appDevPath(slug))
        return
      }
      await reload()
    } catch (cause) {
      setLifecycleError(cause instanceof Error ? cause.message : `Unable to ${action} this session`)
    } finally {
      setLifecycleAction(null)
    }
  }

  const stopTurn = async () => {
    if (stopping || isProductionReadOnlyReview || sessionStatus?.phase === "mayor2") return
    setStopping(true)
    setStopError(null)
    try {
      const result = await stopDevTurn(sessionId)
      if (!result.stopped && result.reason === "wrap-up cannot be stopped") {
        setStopError("Builder is finishing the change summary and cannot be stopped at this stage.")
      }
    } catch (cause) {
      setStopError(cause instanceof Error ? cause.message : "Unable to stop the current Dev turn")
    } finally {
      setStopping(false)
    }
  }

  const promote = async () => {
    if (promoting || isProductionReadOnlyReview) return
    setPromoting(true)
    setPromoteError(null)
    try {
      await promoteDevSession(sessionId)
      await reload()
    } catch (cause) {
      setPromoteError(cause instanceof Error ? cause.message : "Unable to propose this session")
    } finally {
      setPromoting(false)
      // Keep an API failure in the page-level live region rather than
      // trapping it behind the confirmation dialog's modal semantics.
      setPromoteOpen(false)
    }
  }

  const updateVisibility = async () => {
    // An archived row has no live shared-session surface. Keep this guard in
    // the action itself as well as the archived-state UI so a stale render can
    // never send a share/unshare mutation after the server archived it.
    if (!data || data.session.status === "archived" || visibilityUpdating || isProductionReadOnlyReview) return
    const visible = !data.session.shared_at
    setVisibilityUpdating(true)
    setVisibilityError(null)
    try {
      await setDevSessionVisibility(sessionId, visible)
      await reload()
    } catch (cause) {
      setVisibilityError(cause instanceof Error ? cause.message : "Unable to update this session's visibility")
    } finally {
      setVisibilityUpdating(false)
    }
  }

  const recheck = async () => {
    if (!data || rechecking || isProductionReadOnlyReview) return
    setRechecking(true)
    setRecheckError(null)
    setRecheckNotice(null)
    try {
      await recheckDevSession(sessionId)
      setRecheckOpen(false)
      setRecheckNotice("Checks are running again. This session will refresh when results are ready.")
      await reload()
    } catch (cause) {
      setRecheckError(cause instanceof Error ? cause.message : "Unable to start the check run.")
      setRecheckOpen(false)
    } finally {
      setRechecking(false)
    }
  }

  useEffect(() => {
    if (useFixture) {
      setData(devSessionFixture)
      setError(null)
      return
    }
    const controller = new AbortController()
    let cancelled = false
    getDevSession(sessionId, controller.signal).then((response) => {
      if (cancelled) return
      if (response.session.app_slug !== slug) throw new Error("This session does not belong to the selected app")
      setData(response)
    }).catch((cause: unknown) => {
      if (cancelled || (cause instanceof DOMException && cause.name === "AbortError")) return
      setError(cause instanceof Error ? cause.message : "Unable to load this development session")
    })
    return () => { cancelled = true; controller.abort() }
  }, [sessionId, slug, useFixture])

  useEffect(() => {
    const controller = new AbortController()
    setApp(null)
    void getApp(slug, controller.signal)
      .then(({ app: nextApp }) => {
        if (!controller.signal.aborted) setApp(nextApp)
      })
      .catch(() => {
        if (!controller.signal.aborted) setApp(null)
      })
    return () => controller.abort()
  }, [slug])

  const canPause = data?.session.status === "active" || data?.session.status === "promoted"
  const canResume = data?.session.status === "paused"
  const canArchive = data?.session.status === "active" || data?.session.status === "paused" || data?.session.status === "promoted"
  const canUnarchive = data?.session.status === "archived"
  const canStop = Boolean(sessionStatus?.busy) && sessionStatus?.phase !== "mayor2"
  // The worker-status probe deliberately gates promotion. The server would
  // still decide authoritatively, but avoiding a proposal while Builder is
  // running keeps the visible lifecycle truthful and prevents accidental
  // half-finished changes from being sent to a vote.
  const canPromote = data?.session.status === "active" && sessionStatus?.busy === false
  const canRecheck = (data?.session.status === "promoted" || data?.session.status === "merging")
    && data.session.check_state !== "passing"
    && data.session.check_state !== "skipped"
  const pauseLabel = data?.session.status === "promoted" ? "Free worker" : "Pause session"
  const isShared = Boolean(data?.session.shared_at)
  // An archived session is a recoverable record, not a writable conversation.
  // Its sole React mutation is the explicitly-confirmed restore transition.
  const composerDisabled = isProductionReadOnlyReview || canUnarchive
  const composerStreaming = streamState === "streaming"
  const quickReplies = currentQuickReplies(liveMessages, data?.session.status, streamState === "streaming")
  const suggestions = currentSuggestions(liveMessages, data?.session.status, streamState === "streaming")

  return <div className="isolate flex w-full flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6" data-testid="dev-session">
    <AppTopBar app={data ? app : null} backTo={appDevPath(slug)} fallbackTitle="Dev session" label={data ? sessionTitle(data.session) : ""} mode="nested" showClose={false} />
    {error ? <Alert variant="destructive"><AlertTitle>Session unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    {!data && !error ? <><Skeleton className="h-20 w-full" /><Skeleton className="min-h-96 w-full" /></> : null}
    {data ? <>
      {useFixture ? <Alert><AlertTitle>Fixture data</AlertTitle></Alert> : null}
      {isProductionReadOnlyReview ? <Alert><AlertTitle>Read-only</AlertTitle><AlertDescription>Session actions and messages are unavailable.</AlertDescription></Alert> : null}
      {canRecheck ? <Alert>
        <PlatformIcon icon={data.session.check_state === "failing" || data.session.check_state === "error" ? OctagonX : RefreshCw} />
        <AlertTitle>{data.session.check_state === "pending" ? "Checks are still running" : "Checks need attention"}</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">{data.session.check_state === "pending" ? "The latest run hasn’t finished. Run checks again if it appears stuck." : data.session.check_error_detail || "Rebuild the preview if needed, then run the proposal checks again."}<AlertDialog open={recheckOpen} onOpenChange={setRecheckOpen}><AlertDialogTrigger disabled={isProductionReadOnlyReview || rechecking} render={<Button size="sm" variant="outline" />}><PlatformIcon data-icon="inline-start" icon={rechecking ? RefreshCw : CheckCircle2} className={rechecking ? "animate-spin" : undefined} />{rechecking ? "Starting checks…" : "Re-run checks"}</AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Run the proposal checks again?</AlertDialogTitle><AlertDialogDescription>This may rebuild the staging preview before the checks run.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={rechecking}>Cancel</AlertDialogCancel><AlertDialogAction disabled={rechecking} onClick={() => void recheck()}>{rechecking ? "Starting…" : "Re-run checks"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></AlertDescription>
      </Alert> : null}
      {recheckError ? <Alert variant="destructive"><AlertTitle>Checks were not started</AlertTitle><AlertDescription>{recheckError}</AlertDescription></Alert> : null}
      {recheckNotice ? <Alert><AlertTitle>Checks started</AlertTitle><AlertDescription>{recheckNotice}</AlertDescription></Alert> : null}
      {canUnarchive ? <Alert>
        <AlertTitle>This session is archived</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">Restore it to paused when you are ready to continue. Its pull request may not reopen, and expired retained files will make the next turn start fresh.<AlertDialog open={unarchiveOpen} onOpenChange={setUnarchiveOpen}><AlertDialogTrigger disabled={isProductionReadOnlyReview || Boolean(lifecycleAction)} render={<Button size="sm" />}><PlatformIcon data-icon="inline-start" icon={RotateCcw} />Restore session</AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Restore this archived session?</AlertDialogTitle><AlertDialogDescription>This returns the session to paused. Its pull request may not reopen. If retained files have expired, the next turn starts fresh.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={lifecycleAction === "unarchive"}>Cancel</AlertDialogCancel><AlertDialogAction disabled={lifecycleAction === "unarchive"} onClick={() => void updateLifecycle("unarchive")}>{lifecycleAction === "unarchive" ? "Restoring…" : "Restore session"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></AlertDescription>
      </Alert> : null}
      {lifecycleError ? <Alert variant="destructive"><AlertTitle>Session update failed</AlertTitle><AlertDescription>{lifecycleError}</AlertDescription></Alert> : null}
      {stopError ? <Alert variant="destructive"><AlertTitle>Turn update failed</AlertTitle><AlertDescription>{stopError}</AlertDescription></Alert> : null}
      {promoteError ? <Alert variant="destructive"><AlertTitle>Proposal not created</AlertTitle><AlertDescription>{promoteError}</AlertDescription></Alert> : null}
      {visibilityError ? <Alert variant="destructive"><AlertTitle>Session visibility was not updated</AlertTitle><AlertDescription>{visibilityError}</AlertDescription></Alert> : null}
      {lifecycleNotice ? <Alert><AlertTitle>Session updated</AlertTitle><AlertDescription>{lifecycleNotice}</AlertDescription></Alert> : null}
      <div className="grid min-h-0 gap-6 xl:grid-cols-4 xl:items-start" data-slot="development-workspace">
        <aside aria-label="Session details" className="flex min-w-0 flex-col gap-4 xl:col-start-4 xl:row-start-1 xl:sticky xl:top-4" data-slot="dev-session-rail">
          <div className="overflow-hidden rounded-xl border bg-muted/30">
            <div className="flex flex-col gap-3 p-4">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Session</p>
              <dl className="flex flex-col gap-2 text-sm">
                <div className="flex items-center justify-between gap-3"><dt className="text-muted-foreground">State</dt><dd><Badge variant={data.session.status === "active" ? "secondary" : "outline"}>{data.session.status}</Badge></dd></div>
                <div className="flex items-center justify-between gap-3"><dt className="text-muted-foreground">Branch</dt><dd className="min-w-0 truncate font-mono text-xs" title={data.session.branch_name || "No branch"}>{data.session.branch_name || "No branch"}</dd></div>
                <div className="flex items-center justify-between gap-3"><dt className="text-muted-foreground">Visibility</dt><dd>{isShared ? "Everyone" : "Private"}</dd></div>
              </dl>
            </div>
            <nav aria-label="Session views" className="divide-y border-y">
              <Link className="flex min-h-11 items-center justify-between gap-3 px-4 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/30" to={`/apps/${encodeURIComponent(slug)}/dev/sessions/${encodeURIComponent(sessionId)}/spec`}>Spec<PlatformIcon icon={ChevronRight} size="xs" /></Link>
              <Link className="flex min-h-11 items-center justify-between gap-3 px-4 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/30" to={`/apps/${encodeURIComponent(slug)}/dev/sessions/${encodeURIComponent(sessionId)}/preview`}>Preview<PlatformIcon icon={ChevronRight} size="xs" /></Link>
            </nav>
            <div className="flex flex-col gap-1 p-2">
              {!canUnarchive ? <Button className="w-full justify-start" disabled={isProductionReadOnlyReview || visibilityUpdating} onClick={() => void updateVisibility()} type="button" variant="ghost"><PlatformIcon data-icon="inline-start" icon={isShared ? EyeOff : Eye} />{visibilityUpdating ? "Updating…" : isShared ? "Make private" : "Make visible"}</Button> : null}
              {canPromote ? <AlertDialog open={promoteOpen} onOpenChange={setPromoteOpen}><AlertDialogTrigger disabled={isProductionReadOnlyReview || promoting} render={<Button className="w-full justify-start" variant="ghost" />}><PlatformIcon data-icon="inline-start" icon={Send} />Propose change</AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Propose these changes for voting?</AlertDialogTitle><AlertDialogDescription>This publishes the current session as a proposal and starts the normal review lifecycle.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={promoting}>Cancel</AlertDialogCancel><AlertDialogAction disabled={promoting} onClick={() => void promote()}>{promoting ? "Proposing…" : "Propose change"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog> : null}
              {canStop ? <Button className="w-full justify-start" disabled={isProductionReadOnlyReview || stopping} onClick={() => void stopTurn()} type="button" variant="ghost"><PlatformIcon data-icon="inline-start" icon={OctagonX} />{stopping ? "Stopping…" : "Stop turn"}</Button> : null}
              {canPause ? <Button className="w-full justify-start" disabled={isProductionReadOnlyReview || Boolean(lifecycleAction)} onClick={() => void updateLifecycle("pause")} type="button" variant="ghost"><PlatformIcon data-icon="inline-start" icon={Pause} />{lifecycleAction === "pause" ? (data.session.status === "promoted" ? "Freeing…" : "Pausing…") : pauseLabel}</Button> : null}
              {canResume ? <Button className="w-full justify-start" disabled={isProductionReadOnlyReview || Boolean(lifecycleAction)} onClick={() => void updateLifecycle("resume")} type="button"><PlatformIcon data-icon="inline-start" icon={Play} />{lifecycleAction === "resume" ? "Resuming…" : "Resume session"}</Button> : null}
              {canArchive ? <details className="group" data-slot="dev-session-overflow"><summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-4xl px-3 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"><PlatformIcon icon={MoreHorizontal} size="sm" />More session actions</summary><div className="pt-1"><AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}><AlertDialogTrigger disabled={isProductionReadOnlyReview || Boolean(lifecycleAction)} render={<Button className="w-full justify-start" variant="ghost" />}><PlatformIcon data-icon="inline-start" icon={Archive} />Archive session</AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Archive this session?</AlertDialogTitle><AlertDialogDescription>This stops its worker, closes its pull request, and frees the session slot. You can restore it here for a limited time.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={lifecycleAction === "archive"}>Cancel</AlertDialogCancel><AlertDialogAction disabled={lifecycleAction === "archive"} onClick={() => void updateLifecycle("archive")} variant="destructive">{lifecycleAction === "archive" ? "Archiving…" : "Archive session"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></div></details> : null}
            </div>
          </div>
          <DevSessionActivity status={sessionStatus} />
        </aside>
        <main className="flex min-w-0 flex-col gap-4 xl:col-span-3 xl:col-start-1 xl:row-start-1" data-slot="dev-session-conversation-column">
          <DevBuildTimeline estimate={estimate} liveLines={buildLines} messages={data.messages} />
          <DevVisualEvidence visuals={data.session.visuals} />
          {liveMessages.length ? <DevConversation messages={liveMessages} sessionId={sessionId} streamState={streamState} /> : <Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={MessagesSquare} /></EmptyMedia><EmptyTitle>{canUnarchive ? "Restore this session to continue" : "No messages yet"}</EmptyTitle><EmptyDescription>{canUnarchive ? "Archived sessions preserve their history but cannot receive a new Builder turn until restored." : "Start this session with Builder below."}</EmptyDescription></EmptyHeader></Empty>}
          <DevComposer disabled={composerDisabled} onTurnStarted={reload} quickReplies={quickReplies} sessionId={sessionId} streaming={composerStreaming} suggestions={suggestions} />
        </main>
      </div>
    </> : null}
  </div>
}
