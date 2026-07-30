import { ArrowLeft, Eye, MessageCircle, RadioTower } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"

import { PlatformIcon } from "@/components/platform-icon"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { AppTopBar } from "@/features/apps/app-top-bar"
import { TopicDiscussionTranscript } from "@/features/dev/topic-discussion-transcript"
import { getApp, type AppDetail } from "@/lib/apps-api"
import { appDevGitHubIssuePath, appDevPath } from "@/lib/routes"
import { getSharedSessionDetail, type SharedSession } from "@/lib/shared-session-api"

const sharedSessionDateFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

function sessionTitle(session: SharedSession) {
  return session.session_title || session.pr_title || session.branch_name || `Session #${session.id}`
}

function formatSharedAt(iso: string | null | undefined) {
  if (!iso) return ""
  const date = new Date(iso)
  if (Number.isNaN(date.valueOf())) return ""
  return sharedSessionDateFormatter.format(date)
}

/**
 * Public metadata shell for a live shared session. The caller supplies the
 * independently authorized session-scoped discussion so Storybook can inspect
 * metadata and discussion states without coupling presentation to transport.
 */
export function SharedSessionDetailContent({ children, session, slug }: { children?: ReactNode; session: SharedSession; slug: string }) {
  const title = sessionTitle(session)
  const sharedAt = formatSharedAt(session.shared_at)
  const linkedIssues = session.linked_issues || []

  return <div className="flex w-full flex-col gap-6">
    <p className="text-base text-muted-foreground text-pretty">Follow the work and join its session-scoped discussion.</p>
    <Card>
      <CardHeader className="gap-3"><CardTitle className="text-balance text-2xl font-semibold tracking-tight">{title}</CardTitle><CardDescription>Shared by {session.username || "a collaborator"}{sharedAt ? ` · ${sharedAt}` : ""}</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2"><Badge variant="secondary"><PlatformIcon data-icon="inline-start" icon={RadioTower} size="xs" />{session.status === "paused" ? "Paused" : "Live"}</Badge><Badge variant="outline">Visible to everyone</Badge><Badge variant="outline"><PlatformIcon data-icon="inline-start" icon={MessageCircle} size="xs" />{Number(session.chat_count || 0)} discussion messages</Badge>{session.busy ? <Badge variant="outline">Working</Badge> : null}</div>
        {session.branch_name ? <p className="break-all font-mono text-sm text-muted-foreground">{session.branch_name}</p> : null}
        {linkedIssues.length ? <div className="flex flex-wrap gap-2" aria-label="Linked GitHub issues">{linkedIssues.map((number) => <Badge key={number} render={<Link to={appDevGitHubIssuePath(slug, number)} />} variant="outline">Issue #{number}</Badge>)}</div> : null}
      </CardContent>
      {session.staging_url ? <CardFooter><Button render={<a href={session.staging_url} rel="noreferrer" target="_blank" />} size="sm" variant="outline"><PlatformIcon data-icon="inline-start" icon={Eye} />Open live preview</Button></CardFooter> : null}
    </Card>
    {children}
  </div>
}

export function SharedSessionDetail() {
  const { sessionId = "", slug = "" } = useParams()
  const id = Number(sessionId)
  const [result, setResult] = useState<{ session: SharedSession | null } | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [app, setApp] = useState<AppDetail | null>(null)

  useEffect(() => {
    if (!Number.isSafeInteger(id) || id <= 0) { setResult({ session: null }); return }
    const controller = new AbortController()
    setResult(undefined); setError(null)
    getSharedSessionDetail(slug, id, controller.signal)
      .then((value) => setResult(value))
      .catch((cause: unknown) => { if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : "Unable to load the shared session") })
    return () => controller.abort()
  }, [id, slug])

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

  if (error) return <div className="flex flex-1 items-center justify-center p-6" data-testid="shared-session-detail-error"><Alert className="max-w-md" variant="destructive"><AlertTitle>Shared session unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert></div>
  if (result === undefined) return <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 px-4 py-8 sm:px-6"><Skeleton className="h-10 w-32" /><Skeleton className="h-56 w-full" /><Skeleton className="h-28 w-full" /></div>
  if (result.session === null) return <div className="flex flex-1 items-center justify-center p-6" data-testid="shared-session-detail-not-found"><Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={RadioTower} /></EmptyMedia><EmptyTitle>Shared session not found</EmptyTitle><EmptyDescription>It may no longer be shared, may have been archived, or you may no longer have access to this app.</EmptyDescription></EmptyHeader><Button render={<Link to={appDevPath(slug)} />} variant="outline"><PlatformIcon data-icon="inline-start" icon={ArrowLeft} />Back to Dev</Button></Empty></div>
  return <div className="isolate flex w-full flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6" data-testid="shared-session-detail">
    <AppTopBar app={app} backTo={appDevPath(slug)} fallbackTitle="Shared Dev session" label="Shared Dev session" mode="nested" />
    <SharedSessionDetailContent session={result.session} slug={slug}>
      <TopicDiscussionTranscript slug={slug} threadRef={id} threadType="session" />
    </SharedSessionDetailContent>
  </div>
}
