import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

const firstPage = {
  unread: 4,
  hasMore: false,
  nextBefore: null,
  pendingInvites: [{ kind: "collab", appId: 9, appSlug: "recipebot", appName: "RecipeBot", invitedBy: "ava", createdAt: "2026-07-28T12:30:00.000Z" }],
  notifications: [
    { id: 1, kind: "mention", readAt: null, appId: 4, appSlug: "recipebot", appName: "RecipeBot", createdAt: "2026-07-28T12:00:00.000Z", messageContent: "Can we add a pantry filter?", sourceUsername: "ava" },
    { id: 2, kind: "session_done", readAt: null, appId: 4, appSlug: "recipebot", appName: "RecipeBot", createdAt: "2026-07-28T11:00:00.000Z", sessionId: 9, prTitle: "Finish recipe search" },
    { id: 3, kind: "reply", readAt: null, appId: 4, appSlug: "recipebot", appName: "RecipeBot", createdAt: "2026-07-28T10:00:00.000Z", messageContent: "A reply worth reading", sourceUsername: "sam" },
    { id: 4, kind: "collab_invite", readAt: null, appId: 9, appSlug: "recipebot", appName: "RecipeBot", createdAt: "2026-07-28T09:00:00.000Z" },
  ],
}

async function installNotificationSocket(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket
    type Handler = ((event: Event) => void) | null
    class NotificationSocket {
      static instances: NotificationSocket[] = []
      onopen: Handler = null
      onclose: Handler = null
      onerror: Handler = null
      onmessage: ((event: MessageEvent) => void) | null = null
      readonly url: string
      constructor(url: string) { this.url = url; NotificationSocket.instances.push(this); window.setTimeout(() => this.onopen?.(new Event("open")), 0) }
      close() { this.onclose?.(new Event("close")) }
      emit(payload: unknown) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) })) }
    }
    class WebSocketSpy {
      static CONNECTING = NativeWebSocket.CONNECTING
      static OPEN = NativeWebSocket.OPEN
      static CLOSING = NativeWebSocket.CLOSING
      static CLOSED = NativeWebSocket.CLOSED
      constructor(url: string | URL, protocols?: string | string[]) {
        if (String(url).includes("/ws/events")) return new NotificationSocket(String(url))
        return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols)
      }
    }
    Object.defineProperty(window, "WebSocket", { configurable: true, value: WebSocketSpy })
    Object.assign(window, { __notificationSockets: NotificationSocket.instances })
  })
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/notifications?limit=20", (route) => route.fulfill({ json: firstPage }))
  await page.route("**/api/notifications/read", (route) => route.fulfill({ json: { unread: 0 } }))
})

test("keeps bell, pending-invitation, and Work completion responsibilities distinct", async ({ page }) => {
  await page.goto("/react/notifications")
  await expect(page.getByTestId("notifications")).toContainText("Can we add a pantry filter?")
  await expect(page.getByTestId("notifications")).not.toContainText("Finish recipe search")
  await expect(page.getByRole("heading", { name: "Pending invitations" })).toBeVisible()
  await expect(page.getByTestId("notifications")).not.toContainText("collab invite")
  await expect(page.getByRole("link", { name: "Open activity: Can we add a pantry filter?" })).toHaveAttribute("href", "/react/apps/recipebot/dev/chat")
  await expect(page.getByTestId("notifications").locator('[data-status-role="attention"]')).toHaveCount(2)
  await expect(page.getByRole("img", { name: "RecipeBot, unread" })).toHaveCount(2)
})

test("routes identified proposal notifications into the owned React detail", async ({ page }) => {
  await page.route("**/api/notifications?limit=20", (route) => route.fulfill({ json: {
    unread: 1,
    hasMore: false,
    nextBefore: null,
    pendingInvites: [],
    notifications: [{ id: 18, kind: "pr_proposed", readAt: null, appId: 4, appSlug: "recipebot", appName: "RecipeBot", createdAt: "2026-07-28T12:00:00.000Z", sessionId: 42, prTitle: "Add pantry filters" }],
  } }))
  await page.goto("/react/notifications")
  await expect(page.getByRole("link", { name: "Open activity: Add pantry filters" })).toHaveAttribute("href", "/react/apps/recipebot/dev/proposals/42")
})

test("routes a scoped discussion notification to its existing React detail", async ({ page }) => {
  await page.route("**/api/notifications?limit=20", (route) => route.fulfill({ json: {
    unread: 1,
    hasMore: false,
    nextBefore: null,
    pendingInvites: [],
    notifications: [{ id: 20, kind: "reply", readAt: null, appId: 4, appSlug: "recipebot", appName: "RecipeBot", createdAt: "2026-07-28T12:00:00.000Z", threadType: "governance", threadRef: 13, messageContent: "A governance reply" }],
  } }))
  await page.goto("/react/notifications")
  await expect(page.getByRole("link", { name: "Open activity: A governance reply" })).toHaveAttribute("href", "/react/apps/recipebot/dev/governance/13")
})

test("keeps an incomplete proposal notification inside the owned React workspace", async ({ page }) => {
  await page.route("**/api/notifications?limit=20", (route) => route.fulfill({ json: {
    unread: 1,
    hasMore: false,
    nextBefore: null,
    pendingInvites: [],
    notifications: [{ id: 19, kind: "pr_proposed", readAt: null, appId: 4, appSlug: "recipebot", appName: "RecipeBot", createdAt: "2026-07-28T12:00:00.000Z", prTitle: "Proposal needs attention" }],
  } }))
  await page.goto("/react/notifications")
  await expect(page.getByRole("link", { name: "Open activity: Proposal needs attention" })).toHaveAttribute("href", "/react/apps/recipebot/dev")
})

test("marks only the opened bell notification as read in a normal environment", async ({ page }) => {
  const markReadBodies: unknown[] = []
  await page.route("**/api/notifications/read", async (route) => {
    markReadBodies.push(route.request().postDataJSON())
    await route.fulfill({ json: { unread: 1 } })
  })
  await page.goto("/react/notifications")
  await page.getByRole("link", { name: "Open activity: Can we add a pantry filter?" }).click()
  await expect.poll(() => markReadBodies).toEqual([{ id: 1 }])
})

test("marks every visible bell notification individually without clearing Work or actionable invitations", async ({ page }) => {
  const markReadBodies: unknown[] = []
  await page.route("**/api/notifications/read", async (route) => {
    markReadBodies.push(route.request().postDataJSON())
    await route.fulfill({ json: { unread: 1 } })
  })
  await page.goto("/react/notifications")
  await page.getByRole("button", { name: "Mark all read" }).click()
  await expect.poll(() => markReadBodies).toEqual([{ id: 1 }, { id: 3 }])
})

test("uses the canonical cursor and dedupes an older page", async ({ page }) => {
  await page.route("**/api/notifications?limit=20", (route) => route.fulfill({ json: { ...firstPage, pendingInvites: [], hasMore: true, nextBefore: { createdAt: "2026-07-28T10:00:00.000Z", id: 3 } } }))
  await page.route("**/api/notifications?limit=20&before=2026-07-28T10%3A00%3A00.000Z&before_id=3", (route) => route.fulfill({ json: {
    notifications: [firstPage.notifications[2], { id: 5, kind: "reaction", readAt: null, appId: 4, appSlug: "recipebot", appName: "RecipeBot", createdAt: "2026-07-28T09:00:00.000Z", messageContent: "A new reaction", sourceUsername: "mira" }],
    hasMore: false,
    nextBefore: null,
  } }))
  await page.goto("/react/notifications")
  await page.getByRole("button", { name: "Show older activity" }).click()
  await expect(page.getByTestId("notifications")).toContainText("A new reaction")
  await expect(page.getByText("A reply worth reading")).toHaveCount(1)
  await expect(page.getByRole("button", { name: "Show older activity" })).toHaveCount(0)
})

test("re-reads the first authoritative page on notification websocket events", async ({ page }) => {
  await installNotificationSocket(page)
  let reads = 0
  let liveMentionAvailable = false
  await page.route("**/api/notifications?limit=20", (route) => {
    reads += 1
    return route.fulfill({ json: { ...firstPage, pendingInvites: [], notifications: [{ ...firstPage.notifications[0], messageContent: liveMentionAvailable ? "A live mention arrived" : "Can we add a pantry filter?" }] } })
  })
  await page.goto("/react/notifications")
  await expect(page.getByTestId("notifications")).toContainText("Can we add a pantry filter?")
  liveMentionAvailable = true
  await page.evaluate(() => {
    const sockets = (window as unknown as { __notificationSockets: Array<{ emit: (value: unknown) => void }> }).__notificationSockets
    sockets.at(-1)?.emit({ type: "notification_new", id: 1 })
  })
  await expect(page.getByTestId("notifications")).toContainText("A live mention arrived")
  expect(reads).toBeGreaterThanOrEqual(2)
})

test("accepts collaborator invites through the canonical endpoint and routes into the app discussion", async ({ page }) => {
  await page.route("**/api/invites/9/accept", (route) => route.fulfill({ json: { ok: true, appSlug: "recipebot" } }))
  await page.goto("/react/notifications")
  await page.getByRole("button", { name: "Accept" }).click()
  await expect(page).toHaveURL(/\/react\/apps\/recipebot\/dev\/chat$/)
})

test("declines approver invites through their distinct existing contract", async ({ page }) => {
  let declineRequests = 0
  await page.route("**/api/notifications?limit=20", (route) => route.fulfill({ json: { ...firstPage, pendingInvites: declineRequests ? [] : [{ kind: "approver", appId: 10, appSlug: "recipebot", appName: "RecipeBot", invitedBy: "mira", createdAt: "2026-07-28T12:30:00.000Z" }] } }))
  await page.route("**/api/approver-invites/10/decline", async (route) => { declineRequests += 1; await route.fulfill({ json: { ok: true } }) })
  await page.goto("/react/notifications")
  await page.getByRole("button", { name: "Decline" }).click()
  await expect.poll(() => declineRequests).toBe(1)
  await expect(page.getByRole("heading", { name: "Pending invitations" })).toHaveCount(0)
})

test("shows a recoverable loading error", async ({ page }) => {
  await page.route("**/api/notifications?limit=20", (route) => route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } }))
  await page.goto("/react/notifications")
  await expect(page.getByRole("alert")).toContainText("Activity unavailable")
  await expect(page.getByRole("alert")).toContainText("Request failed (503)")
})

test("has no critical or serious accessibility violations", async ({ page }) => {
  await page.goto("/react/notifications")
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})
