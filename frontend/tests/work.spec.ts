import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

test.beforeEach(async ({ page }) => {
  await page.route("**/api/apps/recipebot", (route) => route.fulfill({ json: { app: { id: "recipebot", slug: "recipebot", name: "RecipeBot", can_collaborate: false } } }))
  await page.route("**/api/apps/recipebot/messages?*", (route) => route.fulfill({ json: { messages: [] } }))
  await page.route("**/api/me/active-sessions", (route) => route.fulfill({ json: {
    sessions: [
      { id: 23, app_slug: "recipebot", app_name: "RecipeBot", branch_name: "feature/pantry", pr_title: null, session_title: "Improve pantry search", status: "active", busy: true, last_activity_at: "2026-07-28T12:00:00.000Z", created_at: "2026-07-28T11:00:00.000Z" },
      { id: 24, app_slug: "recipebot", app_name: "RecipeBot", branch_name: "feature/proposal", pr_title: "Improve matching", session_title: null, status: "promoted", busy: false, last_activity_at: "2026-07-28T11:00:00.000Z", created_at: "2026-07-28T10:00:00.000Z" },
    ],
  } }))
  await page.route("**/api/me/proposals", (route) => route.fulfill({ json: {
    proposals: [{ id: 24, app_slug: "recipebot", app_name: "RecipeBot", pr_title: "Improve matching", pr_number: 18, status: "promoted", yes_count: 2, votes_required: 3 }],
    governance: [{ id: 5, app_slug: "recipebot", app_name: "RecipeBot", title: "Rotate a development secret", up_count: 1, votes_required: 3 }],
  } }))
  await page.route("**/api/sessions/23", (route) => route.fulfill({ json: {
    session: { id: 23, app_slug: "recipebot", app_name: "RecipeBot", branch_name: "feature/pantry", pr_title: null, session_title: "Improve pantry search", status: "active", created_at: "2026-07-28T11:00:00.000Z" },
    messages: [],
  } }))
  await page.route("**/api/apps/recipebot/promoted", (route) => route.fulfill({ json: {
    promoted: [{ id: 24, pr_number: 18, pr_title: "Improve matching", status: "promoted", yes_count: 2, no_count: 0, votes_required: 3, created_at: "2026-07-28T12:00:00.000Z" }],
  } }))
  await page.route("**/api/apps/recipebot/issues", (route) => route.fulfill({ json: {
    issues: [{ id: 5, title: "Rotate a development secret", kind: "secret_change", up_count: 1, down_count: 0, votes_required: 3, status: "open", created_at: "2026-07-28T12:00:00.000Z" }],
  } }))
})

async function installSessionEventsSocket(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket
    const allWebSocketUrls: string[] = []
    type Handler = ((event: Event) => void) | null
    class SessionEventsSocket {
      static instances: SessionEventsSocket[] = []
      onopen: Handler = null
      onclose: Handler = null
      onerror: Handler = null
      onmessage: ((event: MessageEvent) => void) | null = null
      readonly url: string
      constructor(url: string) {
        this.url = url
        SessionEventsSocket.instances.push(this)
        window.setTimeout(() => this.onopen?.(new Event("open")), 0)
      }
      close() { this.onclose?.(new Event("close")) }
      emit(payload: unknown) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) })) }
      fail() { this.onerror?.(new Event("error")); this.onclose?.(new Event("close")) }
    }
    class WebSocketSpy {
      static CONNECTING = NativeWebSocket.CONNECTING
      static OPEN = NativeWebSocket.OPEN
      static CLOSING = NativeWebSocket.CLOSING
      static CLOSED = NativeWebSocket.CLOSED
      constructor(url: string | URL, protocols?: string | string[]) {
        allWebSocketUrls.push(String(url))
        if (String(url).includes("/ws/events")) return new SessionEventsSocket(String(url))
        return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols)
      }
    }
    Object.defineProperty(window, "WebSocket", { configurable: true, value: WebSocketSpy })
    Object.assign(window, { __sessionEventsSockets: SessionEventsSocket.instances, __allWebSocketUrls: allWebSocketUrls })
  })
}

test("keeps active sessions and proposals distinct while handing read paths to React", async ({ page }) => {
  await page.goto("/react/work")

  const work = page.getByTestId("work")
  await expect(work.getByRole("heading", { level: 1 })).toHaveCount(1)
  await expect(work).toHaveCSS("max-width", "none")
  await expect(work).toContainText("Improve pantry search")
  await expect(work).toContainText("Improve matching")
  await expect(page.getByRole("link", { name: "View Improve pantry search session" })).toHaveAttribute("href", "/react/apps/recipebot/dev/sessions/23")
  await expect(page.getByRole("link", { name: "View Improve matching proposal" })).toHaveAttribute("href", "/react/apps/recipebot/dev/proposals/24")
  await expect(page.getByRole("link", { name: "View Rotate a development secret governance item" })).toHaveAttribute("href", "/react/apps/recipebot/dev/governance/5")
  await expect(page.getByText("Working")).toBeVisible()
})

test("re-reads Work after a typed session_update instead of patching an incomplete socket payload", async ({ page }) => {
  await installSessionEventsSocket(page)
  let reads = 0
  await page.route("**/api/me/active-sessions", (route) => {
    reads += 1
    return route.fulfill({ json: { sessions: [{ id: 23, app_slug: "recipebot", app_name: "RecipeBot", branch_name: "feature/pantry", pr_title: null, session_title: reads <= 2 ? "Improve pantry search" : "Pantry search complete", status: reads <= 2 ? "active" : "paused", busy: false, last_activity_at: "2026-07-28T12:00:00.000Z", created_at: "2026-07-28T11:00:00.000Z" }] } })
  })
  await page.goto("/react/work")
  await expect(page.getByTestId("work")).toContainText("Improve pantry search")
  await page.evaluate(() => {
    const sockets = (window as unknown as { __sessionEventsSockets: Array<{ url: string; emit: (value: unknown) => void }> }).__sessionEventsSockets
    sockets.findLast((socket) => socket.url.includes("/ws/events"))?.emit({ type: "session_update", action: "paused", sessionId: 23, appSlug: "recipebot" })
  })
  await expect(page.getByTestId("work")).toContainText("Pantry search complete")
  expect(reads).toBeGreaterThanOrEqual(2)
})

test("explains the periodic fallback when live updates are unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "WebSocket", { configurable: true, value: undefined })
  })
  await page.goto("/react/work")
  await expect(page.getByRole("status")).toHaveText("Live updates unavailable. Refreshing periodically.")
})

test("uses React route transitions for every migrated work detail", async ({ page }) => {
  await page.goto("/react/work")

  await page.getByRole("link", { name: "View Improve pantry search session" }).click()
  await expect(page).toHaveURL(/\/react\/apps\/recipebot\/dev\/sessions\/23$/)
  await expect(page.getByTestId("dev-session")).toContainText("Improve pantry search")

  await page.goto("/react/work")
  await page.getByRole("link", { name: "View Improve matching proposal" }).click()
  await expect(page).toHaveURL(/\/react\/apps\/recipebot\/dev\/proposals\/24$/)
  await expect(page.getByTestId("proposal-detail")).toContainText("Improve matching")

  await page.goto("/react/work")
  await page.getByRole("link", { name: "View Rotate a development secret governance item" }).click()
  await expect(page).toHaveURL(/\/react\/apps\/recipebot\/dev\/governance\/5$/)
  await expect(page.getByTestId("governance-detail")).toContainText("Rotate a development secret")
})

test("has no critical or serious accessibility violations", async ({ page }) => {
  await page.goto("/react/work")
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})
