import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

const session = { id: 41, session_title: "Improve pantry search", branch_name: "feature/pantry-search", status: "active", username: "mira", shared_at: "2026-07-28T09:30:00.000Z", chat_count: 2, linked_issues: [84], staging_url: "https://preview.example.test" }
const messages = [
  { id: 1, user_id: 2, username: "mira", content: "I’m testing the smallest useful pantry filter.", msg_type: "message", created_at: "2026-07-28T09:32:00.000Z" },
  { id: 2, user_id: 5, username: "sam", content: "Keeping the existing search terms intact sounds right.", msg_type: "message", created_at: "2026-07-28T09:35:00.000Z" },
]

async function installFixture(page: import("@playwright/test").Page, sessions = [session], canCollaborate = false) {
  await page.route("**/api/apps/recipebot/shared-sessions", (route) => route.fulfill({ json: { sessions } }))
  await page.route("**/api/apps/recipebot", (route) => route.fulfill({ json: { app: {
    id: "recipebot",
    slug: "recipebot",
    name: "RecipeBot",
    status: "running",
    active_users: 24,
    is_favorited: false,
    is_collaborator: canCollaborate,
    your_apps_hidden: false,
    favorite_order: null,
    open_prs: 0,
    active_sessions: 1,
    open_issues: 0,
    can_collaborate: canCollaborate,
  } } }))
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: 5, username: "sam" } } }))
  await page.route("**/api/apps/recipebot/messages**", (route) => route.fulfill({ json: { messages } }))
}

async function installGroupChatSocket(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket
    type Handler = ((event: Event) => void) | null
    class GroupChatSocket {
      static instances: GroupChatSocket[] = []
      readonly CONNECTING = 0
      readonly OPEN = 1
      readonly CLOSING = 2
      readonly CLOSED = 3
      readyState = 0
      onopen: Handler = null
      onclose: Handler = null
      onerror: Handler = null
      onmessage: ((event: MessageEvent) => void) | null = null
      sent: string[] = []
      readonly url: string
      constructor(url: string) {
        this.url = url
        GroupChatSocket.instances.push(this)
        window.setTimeout(() => { this.readyState = 1; this.onopen?.(new Event("open")) }, 0)
      }
      close() { this.readyState = 3; this.onclose?.(new Event("close")) }
      send(payload: string) { this.sent.push(payload) }
    }
    class WebSocketSpy {
      static CONNECTING = NativeWebSocket.CONNECTING
      static OPEN = NativeWebSocket.OPEN
      static CLOSING = NativeWebSocket.CLOSING
      static CLOSED = NativeWebSocket.CLOSED
      constructor(url: string | URL, protocols?: string | string[]) {
        if (String(url).includes("/ws/chat/")) return new GroupChatSocket(String(url))
        return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols)
      }
    }
    Object.defineProperty(window, "WebSocket", { configurable: true, value: WebSocketSpy })
    Object.assign(window, { __groupChatSockets: GroupChatSocket.instances })
  })
}

test("renders view-authorized shared metadata and its public session discussion", async ({ page }) => {
  const discussionUrls: string[] = []
  await installFixture(page)
  await page.unroute("**/api/apps/recipebot/messages**")
  await page.route("**/api/apps/recipebot/messages**", (route) => {
    discussionUrls.push(route.request().url())
    return route.fulfill({ json: { messages } })
  })
  await page.goto("/react/apps/recipebot/dev/shared/41")
  const detail = page.getByTestId("shared-session-detail")
  const chrome = detail.locator('[data-slot="top-bar"]')
  await expect(detail.getByRole("heading", { name: /RecipeBot.*Shared Dev session/, level: 1 })).toBeVisible()
  await expect(detail.locator("h1")).toHaveCount(1)
  await expect(chrome.getByRole("button", { name: "Back" })).toBeVisible()
  await expect(chrome.getByRole("button", { name: "Close RecipeBot" })).toBeVisible()
  expect(await detail.getAttribute("class")).not.toMatch(/\b(?:mx-auto|max-w-)/)
  const chromeBox = await chrome.boundingBox()
  const contentBox = await detail.locator(":scope > :not([data-slot='top-bar'])").first().boundingBox()
  expect(chromeBox).not.toBeNull()
  expect(contentBox).not.toBeNull()
  expect(contentBox!.y).toBeGreaterThanOrEqual(chromeBox!.y + chromeBox!.height)
  await expect(detail).toContainText("Improve pantry search")
  await expect(detail).toContainText("Shared by mira")
  await expect(detail).toContainText(messages[0].content)
  await expect(detail.getByRole("link", { name: "Issue #84" })).toHaveAttribute("href", "/react/apps/recipebot/dev/issues/84")
  await expect(detail.getByText("View-only discussion")).toBeVisible()
  await expect(detail.getByRole("link", { name: /legacy Dev/i })).toHaveCount(0)
  await expect(detail.getByRole("link", { name: "Open live preview" })).toHaveAttribute("href", session.staging_url)
  await expect.poll(() => discussionUrls.join(" ")).toContain("thread_type=session&thread_ref=41")
  await chrome.getByRole("button", { name: "Back" }).click()
  await expect(page).toHaveURL(/\/react\/apps\/recipebot\/dev$/)
})

test("does not request a public thread for a session that is no longer shared", async ({ page }) => {
  let messageRequested = false
  await page.route("**/api/apps/recipebot/shared-sessions", (route) => route.fulfill({ json: { sessions: [] } }))
  await page.route("**/api/apps/recipebot/messages**", (route) => { messageRequested = true; return route.fulfill({ json: { messages } }) })
  await page.goto("/react/apps/recipebot/dev/shared/41")
  await expect(page.getByTestId("shared-session-detail-not-found")).toContainText("Shared session not found")
  expect(messageRequested).toBe(false)
})

test("lets a collaborator reply through the canonical shared-session thread", async ({ page }) => {
  await installGroupChatSocket(page)
  await installFixture(page, [session], true)
  await page.goto("/react/apps/recipebot/dev/shared/41")

  await expect(page.getByRole("form", { name: "Post a topic discussion message" })).toBeVisible()
  await page.getByRole("button", { name: "Reply to mira" }).click()
  await page.getByRole("textbox", { name: "Discussion message" }).fill("I can verify that shared flow.")
  await page.getByRole("button", { name: "Post discussion message" }).click()

  await expect.poll(() => page.evaluate(() => (
    window as unknown as { __groupChatSockets: Array<{ sent: string[] }> }
  ).__groupChatSockets[0]?.sent.filter((payload) => JSON.parse(payload).type === "chat"))).toEqual([
    JSON.stringify({
      type: "chat",
      content: "I can verify that shared flow.",
      thread: { type: "session", ref: 41 },
      quote: { source: "message", refMsgId: 1 },
    }),
  ])
})

test("renders a recoverable metadata error", async ({ page }) => {
  await page.route("**/api/apps/error/shared-sessions", (route) => route.fulfill({ status: 403, json: { error: "Forbidden" } }))
  await page.goto("/react/apps/error/dev/shared/41")
  await expect(page.getByTestId("shared-session-detail-error")).toContainText("Shared session unavailable")
})

test("remains readable on a phone", async ({ page }) => {
  await installFixture(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/react/apps/recipebot/dev/shared/41")
  const detail = page.getByTestId("shared-session-detail")
  await expect(detail).toBeVisible()
  expect(await detail.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
})

test("has no critical or serious accessibility violations", async ({ page }) => {
  await installFixture(page)
  await page.goto("/react/apps/recipebot/dev/shared/41")
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})

test("production review mode keeps shared-session discussion read-only", async ({ page }) => {
  test.skip(process.env.SV_PRODUCTION_READONLY !== "true", "This state is compiled only for the production-review profile.")
  await installFixture(page, [session], true)
  await page.goto("/react/apps/recipebot/dev/shared/41")
  await expect(page.getByRole("alert").filter({ hasText: "Read-only" })).toContainText("Posting and reactions are unavailable.")
  await expect(page.getByRole("form", { name: "Post a topic discussion message" })).toHaveCount(0)
  expect((await page.request.get("/ws/chat/recipebot")).status()).toBe(404)
})
