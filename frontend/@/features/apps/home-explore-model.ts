import type { AppRecord } from "@/lib/apps-api"
import {
  isBellNotification,
  type Notification,
  type NotificationsPage,
  type PendingInvite,
} from "@/lib/notifications-api"

export type HomeActivityItem = {
  id: string
  title: string
  detail: string
}

export function isHomeApp(app: AppRecord) {
  return (app.is_collaborator && !app.your_apps_hidden) || app.is_favorited
}

export function orderedHomeApps(apps: readonly AppRecord[]) {
  return apps
    .filter(isHomeApp)
    .sort(
      (left, right) =>
        (left.favorite_order ?? Number.MAX_SAFE_INTEGER) -
        (right.favorite_order ?? Number.MAX_SAFE_INTEGER)
    )
}

export function matchesAppQuery(app: AppRecord, query: string) {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return true
  return [app.name, app.slug, app.tagline, app.description].some((value) =>
    value?.toLocaleLowerCase().includes(normalizedQuery)
  )
}

function notificationTitle(notification: Notification) {
  return (
    notification.prTitle ||
    notification.messageContent ||
    notification.kind.replaceAll("_", " ")
  )
}

function notificationDetail(notification: Notification) {
  const source = notification.sourceUsername
    ? `@${notification.sourceUsername}`
    : null
  return [notification.appName, source].filter(Boolean).join(" · ")
}

function inviteItem(invite: PendingInvite): HomeActivityItem {
  const title =
    invite.kind === "approver"
      ? "Approver invitation"
      : "Collaborator invitation"
  const appName = invite.appName || invite.appSlug
  return {
    id: `invite:${invite.kind}:${invite.appId}`,
    title,
    detail: invite.invitedBy
      ? `@${invite.invitedBy} invited you to ${appName}.`
      : `You were invited to ${appName}.`,
  }
}

/**
 * Mirrors the Notifications route's responsibility split: actionable invites
 * come first, followed by unread bell rows in server order. Work completion
 * rows and duplicate invitation notifications remain excluded.
 */
export function homeActivityItems(page: NotificationsPage) {
  const invites = (page.pendingInvites ?? []).map(inviteItem)
  const unreadBellItems = page.notifications
    .filter(
      (notification) =>
        isBellNotification(notification) && notification.readAt === null
    )
    .map((notification) => ({
      id: `notification:${notification.id}`,
      title: notificationTitle(notification),
      detail: notificationDetail(notification),
    }))
  return [...invites, ...unreadBellItems].slice(0, 3)
}
