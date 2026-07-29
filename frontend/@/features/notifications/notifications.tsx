import { Bell, CheckCheck, CircleDot, Handshake, RefreshCw, Scale, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"

import { PlatformIcon } from "@/components/platform-icon"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { subscribeNotificationEvents, type NotificationEventsConnectionState } from "@/lib/notification-events"
import { acceptInvite, declineInvite, getNotificationsPage, isBellNotification, markBellNotificationsRead, markNotificationRead, type Notification, type NotificationCursor, type PendingInvite } from "@/lib/notifications-api"
import { appDevChatPath, appDevGitHubIssuePath, appDevGovernancePath, appDevPath, appDevProposalPath, appDevSessionPath } from "@/lib/routes"
import { isProductionReadOnlyReview } from "@/lib/runtime-mode"

type NotificationData = {
  items: Notification[]
  unread: number
  invites: PendingInvite[]
  hasMore: boolean
  nextBefore: NotificationCursor | null
}

type NotificationsContentProps = {
  data: NotificationData | null
  error: string | null
  inviteError: string | null
  loadMoreError: string | null
  loadingMore: boolean
  liveState: NotificationEventsConnectionState
  markingAll: boolean
  mutatingInvite: string | null
  onOpen: (notification: Notification) => void
  onRefresh: () => void
  onLoadMore: () => void
  onMarkAll: () => void
  onInviteAction: (invite: PendingInvite, action: "accept" | "decline") => void
}

function notificationHref(notification: Notification) {
  if (!notification.appSlug) return "/react/notifications"
  if (notification.kind === "session_done" && notification.sessionId) return appDevSessionPath(notification.appSlug, notification.sessionId)
  if (notification.kind === "auto_solve_done" && notification.headlessIssueNumber) return appDevGitHubIssuePath(notification.appSlug, notification.headlessIssueNumber)
  const discussionKinds = new Set(["mention", "reply", "reaction"])
  if (discussionKinds.has(notification.kind) && Number.isInteger(notification.threadRef) && (notification.threadRef || 0) > 0) {
    if (notification.threadType === "issue") return appDevGitHubIssuePath(notification.appSlug, notification.threadRef!)
    if (notification.threadType === "session") return appDevProposalPath(notification.appSlug, notification.threadRef!)
    if (notification.threadType === "governance") return appDevGovernancePath(notification.appSlug, notification.threadRef!)
  }
  const proposalKinds = new Set(["pr_proposed", "stale_pr", "kudos", "check_failed"])
  if (proposalKinds.has(notification.kind) && notification.sessionId) return appDevProposalPath(notification.appSlug, notification.sessionId)
  // Older notifications can lack the identifier required by a detail route.
  // Keep them inside the owned React workspace without guessing an identity.
  if (proposalKinds.has(notification.kind) || notification.kind === "auto_solve_done") {
    return appDevPath(notification.appSlug)
  }
  return appDevChatPath(notification.appSlug)
}

function notificationCopy(notification: Notification) {
  if (notification.prTitle) return notification.prTitle
  if (notification.messageContent) return notification.messageContent
  return notification.kind.replaceAll("_", " ")
}

function inviteKey(invite: PendingInvite) {
  return `${invite.kind}:${invite.appId}`
}

function mergeById(current: Notification[], incoming: Notification[]) {
  const byId = new Map<number, Notification>()
  for (const notification of current) byId.set(notification.id, notification)
  for (const notification of incoming) byId.set(notification.id, notification)
  return [...byId.values()].sort((a, b) => {
    const time = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    return time || b.id - a.id
  })
}

function NotificationsSkeleton() {
  return <div className="flex flex-col gap-3" aria-label="Loading notifications" role="status"><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /></div>
}

export function NotificationsContent({ data, error, inviteError, loadMoreError, loadingMore, liveState, markingAll, mutatingInvite, onOpen, onRefresh, onLoadMore, onMarkAll, onInviteAction }: NotificationsContentProps) {
  const bellItems = useMemo(() => data?.items.filter(isBellNotification) || [], [data?.items])
  const unread = bellItems.filter((notification) => !notification.readAt).length
  const groups = useMemo(() => {
    const buckets = new Map<string, Notification[]>()
    for (const notification of bellItems) {
      const key = notification.appId === null ? "general" : String(notification.appId)
      buckets.set(key, [...(buckets.get(key) || []), notification])
    }
    return [...buckets.values()]
  }, [bellItems])

  return <main className="isolate mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6" data-testid="notifications">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex flex-col gap-2"><h2 className="text-balance text-3xl font-semibold tracking-tight">Notifications</h2><p className="text-base text-muted-foreground text-pretty">Mentions, replies, votes, and invitations. Finished Dev work stays in Your work.</p></div>
      <div className="flex gap-2">
        <Button aria-label="Refresh notifications" onClick={onRefresh} size="icon" type="button" variant="outline"><PlatformIcon icon={RefreshCw} /></Button>
        <Button disabled={!unread || markingAll || isProductionReadOnlyReview} onClick={onMarkAll} type="button" variant="outline"><PlatformIcon data-icon="inline-start" icon={CheckCheck} />Mark all read</Button>
      </div>
    </header>
    {isProductionReadOnlyReview ? <Alert><PlatformIcon icon={Bell} /><AlertTitle>Production review mode</AlertTitle><AlertDescription>Notifications and invitations can be reviewed here, but no read, accept, or decline request is made.</AlertDescription></Alert> : null}
    {liveState !== "connected" ? <p className="text-sm text-muted-foreground" role="status">{liveState === "connecting" ? "Connecting to live notifications." : liveState === "unavailable" ? "Live notifications are unavailable. Use refresh to re-read the latest updates." : "Live notifications are reconnecting."}</p> : null}
    {error ? <Alert variant="destructive"><PlatformIcon icon={Bell} /><AlertTitle>Notifications unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    {inviteError ? <Alert variant="destructive"><PlatformIcon icon={Handshake} /><AlertTitle>Invitation was not updated</AlertTitle><AlertDescription>{inviteError}</AlertDescription></Alert> : null}
    {!data && !error ? <NotificationsSkeleton /> : null}
    {data?.invites.length ? <InviteSection invites={data.invites} mutatingInvite={mutatingInvite} onInviteAction={onInviteAction} /> : null}
    {data && !bellItems.length && !data.invites.length ? <Empty><EmptyHeader><EmptyMedia variant="icon"><PlatformIcon icon={Bell} /></EmptyMedia><EmptyTitle>You are all caught up</EmptyTitle><EmptyDescription>New messages and community activity will appear here. Finished sessions are shown in Your work.</EmptyDescription></EmptyHeader></Empty> : null}
    {groups.map((group) => <NotificationGroup group={group} key={group[0]?.appId ?? "general"} onOpen={onOpen} />)}
    {data?.hasMore ? <div className="flex flex-col items-center gap-2"><Button disabled={loadingMore} onClick={onLoadMore} type="button" variant="outline"><PlatformIcon className={loadingMore ? "animate-spin" : undefined} data-icon="inline-start" icon={RefreshCw} />{loadingMore ? "Loading older notifications…" : "Show older notifications"}</Button>{loadMoreError ? <p className="text-sm text-destructive" role="status">{loadMoreError}</p> : null}</div> : null}
  </main>
}

function InviteSection({ invites, mutatingInvite, onInviteAction }: { invites: PendingInvite[]; mutatingInvite: string | null; onInviteAction: (invite: PendingInvite, action: "accept" | "decline") => void }) {
  return <section aria-labelledby="pending-invites-heading" className="flex flex-col gap-3"><div className="flex flex-col gap-1"><h3 className="text-lg font-medium" id="pending-invites-heading">Pending invitations</h3><p className="text-sm text-muted-foreground">These are still actionable membership invitations, not ordinary read messages.</p></div>{invites.map((invite) => {
    const busy = mutatingInvite === inviteKey(invite)
    const approver = invite.kind === "approver"
    return <Card key={inviteKey(invite)} size="sm"><CardHeader><CardTitle className="flex items-center gap-2"><PlatformIcon icon={approver ? Scale : Handshake} />{approver ? "Approver invitation" : "Collaborator invitation"}</CardTitle><CardDescription>{invite.invitedBy ? `@${invite.invitedBy} invited you to ${approver ? "be an approver on" : "collaborate on"} ${invite.appName || invite.appSlug}.` : `You were invited to ${approver ? "be an approver on" : "collaborate on"} ${invite.appName || invite.appSlug}.`}</CardDescription></CardHeader><CardFooter className="flex flex-wrap gap-2"><Button disabled={busy || isProductionReadOnlyReview} onClick={() => onInviteAction(invite, "accept")} type="button"><PlatformIcon data-icon="inline-start" icon={Handshake} />{busy ? "Updating…" : "Accept"}</Button><Button disabled={busy || isProductionReadOnlyReview} onClick={() => onInviteAction(invite, "decline")} type="button" variant="outline"><PlatformIcon data-icon="inline-start" icon={X} />Decline</Button></CardFooter></Card>
  })}</section>
}

function NotificationGroup({ group, onOpen }: { group: Notification[]; onOpen: (notification: Notification) => void }) {
  const heading = group[0]?.appName || "General"
  return <section aria-labelledby={`notification-group-${group[0]?.appId ?? "general"}`} className="flex flex-col gap-2"><h3 className="text-lg font-medium" id={`notification-group-${group[0]?.appId ?? "general"}`}>{heading}</h3>{group.map((notification) => {
    const href = notificationHref(notification)
    const label = `Open notification: ${notificationCopy(notification)}`
    return <Card key={notification.id} size="sm"><CardHeader><CardTitle className="truncate text-base">{notificationCopy(notification)}</CardTitle><CardDescription>{notification.sourceUsername ? `@${notification.sourceUsername} · ` : ""}{notification.kind.replaceAll("_", " ")}</CardDescription><CardAction>{!notification.readAt ? <Badge><PlatformIcon data-icon="inline-start" icon={CircleDot} size="xs" />New</Badge> : null}</CardAction></CardHeader><CardFooter><Button onClick={() => onOpen(notification)} render={<Link aria-label={label} to={href} />} size="sm" variant="outline">Open</Button></CardFooter></Card>
  })}</section>
}

export function Notifications() {
  const navigate = useNavigate()
  const [data, setData] = useState<NotificationData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [markingAll, setMarkingAll] = useState(false)
  const [mutatingInvite, setMutatingInvite] = useState<string | null>(null)
  const [liveState, setLiveState] = useState<NotificationEventsConnectionState>("connecting")

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    setError(null)
    setLoadMoreError(null)
    getNotificationsPage(null, controller.signal).then((page) => {
      if (cancelled) return
      setData({ items: mergeById([], page.notifications), unread: page.unread || 0, invites: page.pendingInvites || [], hasMore: page.hasMore, nextBefore: page.nextBefore })
    }).catch((cause: unknown) => {
      if (cancelled || (cause instanceof DOMException && cause.name === "AbortError")) return
      setError(cause instanceof Error ? cause.message : "Unable to load notifications")
    })
    return () => { cancelled = true; controller.abort() }
  }, [refreshKey])

  useEffect(() => {
    let queuedRefresh: number | null = null
    const unsubscribe = subscribeNotificationEvents({
      onConnectionStateChange: setLiveState,
      onNotificationChange: () => {
        // The socket may replay or overlap a page fetch. Re-read the first
        // cursor page and use id dedupe rather than trusting partial event
        // payloads or incrementing a client-side unread counter.
        if (queuedRefresh !== null) return
        queuedRefresh = window.setTimeout(() => {
          queuedRefresh = null
          setRefreshKey((current) => current + 1)
        }, 100)
      },
    })
    return () => {
      if (queuedRefresh !== null) window.clearTimeout(queuedRefresh)
      unsubscribe()
    }
  }, [])

  const refresh = useCallback(() => setRefreshKey((current) => current + 1), [])
  const openNotification = useCallback(async (notification: Notification) => {
    if (notification.readAt || isProductionReadOnlyReview) return
    setData((current) => current ? { ...current, items: current.items.map((item) => item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item) } : current)
    try { await markNotificationRead(notification.id) } catch { refresh() }
  }, [refresh])
  const markAll = useCallback(async () => {
    if (!data || isProductionReadOnlyReview) return
    const bellItems = data.items.filter(isBellNotification)
    setMarkingAll(true)
    try {
      await markBellNotificationsRead(bellItems)
      setData((current) => current ? { ...current, items: current.items.map((item) => isBellNotification(item) ? { ...item, readAt: item.readAt || new Date().toISOString() } : item) } : current)
    } catch { refresh() } finally { setMarkingAll(false) }
  }, [data, refresh])
  const loadMore = useCallback(async () => {
    if (!data?.hasMore || !data.nextBefore || loadingMore) return
    setLoadingMore(true)
    setLoadMoreError(null)
    try {
      const page = await getNotificationsPage(data.nextBefore)
      setData((current) => current ? { ...current, items: mergeById(current.items, page.notifications), hasMore: page.hasMore, nextBefore: page.nextBefore } : current)
    } catch (cause: unknown) { setLoadMoreError(cause instanceof Error ? cause.message : "Unable to load older notifications") } finally { setLoadingMore(false) }
  }, [data, loadingMore])
  const actOnInvite = useCallback(async (invite: PendingInvite, action: "accept" | "decline") => {
    if (isProductionReadOnlyReview) return
    setMutatingInvite(inviteKey(invite))
    setInviteError(null)
    try {
      if (action === "accept") {
        const result = await acceptInvite(invite)
        setData((current) => current ? { ...current, invites: current.invites.filter((item) => inviteKey(item) !== inviteKey(invite)) } : current)
        refresh()
        navigate(appDevChatPath(result.appSlug || invite.appSlug))
        return
      }
      await declineInvite(invite)
      setData((current) => current ? { ...current, invites: current.invites.filter((item) => inviteKey(item) !== inviteKey(invite)) } : current)
      refresh()
    } catch (cause: unknown) { setInviteError(cause instanceof Error ? cause.message : "Unable to update this invitation"); refresh() } finally { setMutatingInvite(null) }
  }, [navigate, refresh])

  return <NotificationsContent data={data} error={error} inviteError={inviteError} liveState={liveState} loadMoreError={loadMoreError} loadingMore={loadingMore} markingAll={markingAll} mutatingInvite={mutatingInvite} onInviteAction={(invite, action) => void actOnInvite(invite, action)} onLoadMore={() => void loadMore()} onMarkAll={() => void markAll()} onOpen={(notification) => void openNotification(notification)} onRefresh={refresh} />
}
