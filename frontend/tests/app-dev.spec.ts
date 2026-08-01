import { expect, test, type Locator } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

async function probeHitTarget(target: Locator) {
  return target.evaluate((element) => {
    const rectangle = element.getBoundingClientRect()
    const centerX = Math.floor(rectangle.left + rectangle.width / 2)
    const centerY = Math.floor(rectangle.top + rectangle.height / 2)
    const ownsPoint = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y)
      return hit === element || (hit ? element.contains(hit) : false)
    }
    const scan = (deltaX: number, deltaY: number) => {
      let distance = 0
      while (distance < 64 && ownsPoint(centerX + deltaX * (distance + 1), centerY + deltaY * (distance + 1))) {
        distance += 1
      }
      return distance
    }
    const left = scan(-1, 0)
    const right = scan(1, 0)
    const top = scan(0, -1)
    const bottom = scan(0, 1)
    return {
      effectiveBottom: centerY + bottom,
      effectiveHeight: top + bottom + 1,
      effectiveLeft: centerX - left,
      effectiveRight: centerX + right,
      effectiveTop: centerY - top,
      effectiveWidth: left + right + 1,
      visualHeight: rectangle.height,
      visualWidth: rectangle.width,
    }
  })
}

function hitTargetOverlap(
  first: Awaited<ReturnType<typeof probeHitTarget>>,
  second: Awaited<ReturnType<typeof probeHitTarget>>
) {
  const width = Math.max(
    0,
    Math.min(first.effectiveRight, second.effectiveRight)
      - Math.max(first.effectiveLeft, second.effectiveLeft)
      + 1
  )
  const height = Math.max(
    0,
    Math.min(first.effectiveBottom, second.effectiveBottom)
      - Math.max(first.effectiveTop, second.effectiveTop)
      + 1
  )
  return width * height
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/apps/recipebot", (route) => route.fulfill({ json: { app: { id: "recipebot", slug: "recipebot", name: "RecipeBot", status: "running", active_users: 24, can_collaborate: true } } }))
  await page.route("**/api/apps/recipebot/sessions", (route) => route.fulfill({ json: { sessions: [{ id: 9, branch_name: "feature/pantry", pr_title: null, session_title: "Improve pantry search", status: "active", warm: true, created_at: "2026-07-28T12:00:00.000Z" }] } }))
  await page.route("**/api/apps/recipebot/promoted", (route) => route.fulfill({ json: { promoted: [{ id: 19, pr_number: 47, pr_title: "Filter pantry staples", pr_url: "https://github.com/Usernode-Labs/social-vibecoding/pull/47", status: "promoted", yes_count: 2, no_count: 0, votes_required: 3, chat_count: 4, created_at: "2026-07-28T12:00:00.000Z" }] } }))
  await page.route("**/api/apps/recipebot/issues", (route) => route.fulfill({ json: { issues: [{ id: 12, title: "Add allergy tags", kind: "rename", status: "open", up_count: 1, down_count: 0, votes_required: 3, chat_count: 1, created_at: "2026-07-28T12:00:00.000Z" }] } }))
  await page.route("**/api/apps/recipebot/messages**", (route) => route.fulfill({ json: { messages: [] } }))
  await page.route("**/api/apps/recipebot/github-issues", (route) => route.fulfill({ json: { issues: [] } }))
  await page.route("**/api/apps/recipebot/shared-sessions", (route) => route.fulfill({ json: { sessions: [] } }))
  await page.route("**/api/apps/recipebot/merged**", (route) => route.fulfill({ json: { merged: [], total: 0, hasMore: false } }))
  await page.route("**/api/apps/recipebot/board-order", (route) => route.fulfill({ json: { issues: [], review: [] } }))
  await page.route("**/api/apps/recipebot/pm-order", (route) => route.fulfill({ json: {} }))
})

async function installGlobalEventsSocket(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket
    type Handler = ((event: Event) => void) | null
    class GlobalEventsSocket {
      static instances: GlobalEventsSocket[] = []
      onopen: Handler = null
      onclose: Handler = null
      onerror: Handler = null
      onmessage: ((event: MessageEvent) => void) | null = null
      readonly url: string
      constructor(url: string) {
        this.url = url
        GlobalEventsSocket.instances.push(this)
        window.setTimeout(() => this.onopen?.(new Event("open")), 0)
      }
      close() { this.onclose?.(new Event("close")) }
      emit(payload: unknown) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) })) }
    }
    class WebSocketSpy {
      static CONNECTING = NativeWebSocket.CONNECTING
      static OPEN = NativeWebSocket.OPEN
      static CLOSING = NativeWebSocket.CLOSING
      static CLOSED = NativeWebSocket.CLOSED
      constructor(url: string | URL, protocols?: string | string[]) {
        if (String(url).includes("/ws/events")) return new GlobalEventsSocket(String(url))
        return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols)
      }
    }
    Object.defineProperty(window, "WebSocket", { configurable: true, value: WebSocketSpy })
    Object.assign(window, { __globalEventSockets: GlobalEventsSocket.instances })
  })
}

test("uses the shared Improve chrome with reciprocal Use and one route heading", async ({ page }) => {
  await page.goto("/react/apps/recipebot/dev")

  const dev = page.getByTestId("app-dev")
  const chrome = page.locator('[data-slot="top-bar"]')
  await expect(chrome).toHaveAttribute("data-placement", "flow")
  await expect(dev.getByRole("heading", { level: 1 })).toHaveCount(1)
  await expect(dev.getByRole("heading", { level: 1, name: "RecipeBot" })).toBeVisible()
  await expect(dev.getByText("App details", { exact: true })).toHaveCount(0)

  await page.getByRole("button", { name: "Use" }).click()
  await expect(page).toHaveURL("/react/apps/recipebot/open")
})

test("gives compact TopBar actions honest coarse-pointer reach", async ({ page }) => {
  const coarsePointer = await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches)

  await page.goto("/react/apps/recipebot/dev")
  const chrome = page.locator('[data-slot="top-bar"]')
  const use = chrome.getByRole("button", { name: "Use" })
  const close = chrome.getByRole("button", { name: "Close RecipeBot" })
  const useTarget = await probeHitTarget(use)
  const closeTarget = await probeHitTarget(close)
  expect(useTarget.visualHeight).toBeLessThan(48)
  expect(hitTargetOverlap(useTarget, closeTarget)).toBe(0)
  if (coarsePointer) {
    expect(useTarget.effectiveHeight).toBeGreaterThanOrEqual(48)
    const useBox = await use.boundingBox()
    expect(useBox).not.toBeNull()
    await page.mouse.click(useBox!.x + useBox!.width / 2, useBox!.y - 4)
  } else {
    expect(useTarget.effectiveHeight).toBeLessThan(48)
    await use.click()
  }
  await expect(page).toHaveURL("/react/apps/recipebot/open")

  await page.goto("/react/apps/recipebot/dev/proposals/19")
  const nestedChrome = page.getByTestId("proposal-detail").locator('[data-slot="top-bar"]')
  const back = nestedChrome.getByRole("button", { name: "Back" })
  const nestedClose = nestedChrome.getByRole("button", { name: "Close RecipeBot" })
  const backTarget = await probeHitTarget(back)
  const nestedCloseTarget = await probeHitTarget(nestedClose)
  expect(backTarget.visualHeight).toBeLessThan(48)
  expect(hitTargetOverlap(backTarget, nestedCloseTarget)).toBe(0)
  if (coarsePointer) {
    expect(backTarget.effectiveHeight).toBeGreaterThanOrEqual(48)
    const backBox = await back.boundingBox()
    expect(backBox).not.toBeNull()
    await page.mouse.click(backBox!.x + backBox!.width / 2, backBox!.y - 4)
  } else {
    expect(backTarget.effectiveHeight).toBeLessThan(48)
    await back.click()
  }
  await expect(page).toHaveURL(/\/react\/apps\/recipebot\/dev$/)
})

test("closes the Improve context to Home", async ({ page }) => {
  await page.goto("/react/apps/recipebot/dev")
  await page.getByRole("button", { name: "Close RecipeBot" }).click()
  await expect(page).toHaveURL(/\/react\/?$/)
})

test("keeps responsive Improve content below the flow chrome", async ({ page }) => {
  await page.goto("/react/apps/recipebot/dev?view=list")

  const dev = page.getByTestId("app-dev")
  const chromeBox = await page.locator('[data-slot="top-bar"]').boundingBox()
  const contentBox = await page.getByTestId("app-dev-content").boundingBox()
  expect(chromeBox).not.toBeNull()
  expect(contentBox).not.toBeNull()
  expect(contentBox!.y).toBeGreaterThanOrEqual(chromeBox!.y + chromeBox!.height)
  expect(await dev.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
})

test("lists app-scoped sessions and preserves the session-level legacy handoff", async ({ page }) => {
  await page.goto("/react/apps/recipebot/dev?view=kanban")
  await expect(page.getByTestId("app-dev")).toContainText("Improve pantry search")
  await expect(page.locator('a[href="/react/apps/recipebot/dev/sessions/9"]')).toHaveAttribute("aria-label", "Open Improve pantry search")
})

test("creates a generic Dev session through the existing server contract and opens it", async ({ page }) => {
  let creationRequests = 0
  await page.route("**/api/apps/recipebot/sessions", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    creationRequests += 1
    expect(route.request().postData()).toBeNull()
    await route.fulfill({ status: 201, json: { session: { id: 44, branch_name: "dev/ava-1722168000000", pr_title: null, session_title: null, status: "active", warm: false, created_at: "2026-07-28T12:00:00.000Z" } } })
  })
  await page.goto("/react/apps/recipebot/dev")
  await page.getByRole("button", { name: "Create a session in RecipeBot" }).click()
  await expect(page).toHaveURL("/react/apps/recipebot/dev/sessions/44")
  expect(creationRequests).toBe(1)
})

test("keeps the server's generic-session error visible and does not navigate", async ({ page }) => {
  await page.route("**/api/apps/recipebot/sessions", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    await route.fulfill({ status: 429, json: { error: "You already have 3 running sessions. Pause or archive one first." } })
  })
  await page.goto("/react/apps/recipebot/dev")
  await page.getByRole("button", { name: "Create a session in RecipeBot" }).click()
  await expect(page.getByRole("alert")).toContainText("You already have 3 running sessions. Pause or archive one first.")
  await expect(page).toHaveURL("/react/apps/recipebot/dev")
})

test("links the Dev overview to the read-only general discussion", async ({ page }) => {
  await page.goto("/react/apps/recipebot/dev")
  const discussionLink = page.getByRole("link", { name: "Open RecipeBot discussion" })
  await expect(discussionLink).toHaveAttribute("data-slot", "action-link")
  await expect(discussionLink).toHaveAttribute("href", "/react/apps/recipebot/dev/chat")
  await page.goto("/react/apps/recipebot/dev?view=list")
  const sessionLink = page.getByRole("link", { name: "Open Improve pantry search" })
  await expect(sessionLink).toHaveAttribute("data-slot", "action-link")
  await expect(sessionLink).toHaveAttribute("href", "/react/apps/recipebot/dev/sessions/9")
  const proposalLink = page.getByRole("link", { name: "View Filter pantry staples" })
  await expect(proposalLink).toHaveAttribute("data-slot", "action-link")
  await expect(proposalLink).toHaveAttribute("href", "/react/apps/recipebot/dev/proposals/19")
})

test("keeps the four lifecycle columns and uses a single mobile column selector", async ({ page }) => {
  await page.route("**/api/apps/recipebot/github-issues", (route) => route.fulfill({ json: { issues: [{ number: 72, title: "Review ingredient substitutions", created_by_username: "sam" }] } }))
  await page.goto("/react/apps/recipebot/dev?view=kanban")
  await expect(page.getByTestId("dev-board")).toContainText("Issues")
  await expect(page.getByTestId("dev-board")).toContainText("In progress")
  await expect(page.getByTestId("dev-board")).toContainText("In review")
  await expect(page.getByTestId("dev-board")).toContainText("Done")
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole("tablist", { name: "Development board columns" })).toBeVisible()
  await page.getByRole("tab", { name: /In review/ }).click()
  await expect(page.locator('section[aria-label="In review column"]')).toBeVisible()
  await expect(page.getByRole("img", { name: "Filter pantry staples, needs vote" })).toBeVisible()
})

test("filters board cards immediately through the governed search composition", async ({ page }) => {
  const filterRequests: string[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/apps/recipebot")) filterRequests.push(request.url())
  })
  await page.route("**/api/apps/recipebot/github-issues", (route) => route.fulfill({ json: { issues: [
    { number: 72, title: "Review ingredient substitutions", created_by_username: "sam" },
    { number: 73, title: "Add pantry shortcuts", created_by_username: "sam" },
  ] } }))
  await page.goto("/react/apps/recipebot/dev?view=kanban")

  const filter = page.getByRole("searchbox", { name: "Filter board cards", exact: true })
  await expect(filter).toHaveAttribute("name", "board-filter")
  await expect(filter).toHaveAttribute("placeholder", "Filter by title, author, or number")
  await expect(filter.locator("xpath=..")).toHaveAttribute("data-slot", "input-group")
  await expect(page.getByRole("link", { name: "View Add pantry shortcuts" })).toBeVisible()
  await page.waitForTimeout(300)
  const requestBaseline = filterRequests.length

  await filter.fill("ingredient")
  expect(await page.getByRole("link", { name: "View Review ingredient substitutions" }).count()).toBe(1)
  expect(await page.getByRole("link", { name: "View Add pantry shortcuts" }).count()).toBe(0)
  await expect(page.getByRole("link", { name: "View Review ingredient substitutions" })).toBeVisible()
  await expect(page.getByRole("link", { name: "View Add pantry shortcuts" })).toHaveCount(0)
  await filter.press("Enter")
  await expect(page).toHaveURL("/react/apps/recipebot/dev?view=kanban")

  await filter.fill("missing")
  const issues = page.locator('section[aria-label="Issues column"]')
  await expect(issues.getByText("No matching work in this stage.", { exact: true })).toBeVisible()
  await expect(issues.getByText("New work will appear here.", { exact: true })).toHaveCount(0)

  await page.getByRole("button", { name: "Clear filters" }).click()
  await expect(filter).toHaveValue("")
  await expect(page.getByRole("link", { name: "View Review ingredient substitutions" })).toBeVisible()
  await expect(page.getByRole("link", { name: "View Add pantry shortcuts" })).toBeVisible()
  await page.waitForTimeout(300)
  expect(filterRequests).toHaveLength(requestBaseline)
})

test("gives the mobile board tabs honest non-overlapping reach", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route("**/api/apps/recipebot/github-issues", (route) => route.fulfill({ json: { issues: [{ number: 72, title: "Review ingredient substitutions", created_by_username: "sam" }] } }))
  await page.goto("/react/apps/recipebot/dev?view=kanban")

  const coarsePointer = await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches)
  const tablist = page.getByRole("tablist", { name: "Development board columns" })
  const tabs = tablist.getByRole("tab")
  await expect(tabs).toHaveCount(4)
  const targets = []
  for (let index = 0; index < await tabs.count(); index += 1) {
    const target = await probeHitTarget(tabs.nth(index))
    expect(target.visualHeight).toBeLessThan(48)
    if (coarsePointer) expect(target.effectiveHeight).toBeGreaterThanOrEqual(48)
    else expect(target.effectiveHeight).toBeLessThan(48)
    targets.push(target)
  }
  for (let index = 0; index < targets.length - 1; index += 1) {
    expect(hitTargetOverlap(targets[index], targets[index + 1])).toBe(0)
  }

  const inReview = tabs.filter({ hasText: "In review" })
  if (coarsePointer) {
    const box = await inReview.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.click(box!.x + box!.width / 2, box!.y - 4)
  } else {
    await inReview.click()
  }
  await expect(inReview).toHaveAttribute("aria-selected", "true")
  await expect(page.locator('section[aria-label="In review column"]')).toBeVisible()
})

test("routes completed proposals and governance changes to owned React details", async ({ page }, testInfo) => {
  await page.route("**/api/apps/recipebot/merged**", (route) => route.fulfill({ json: {
    merged: [
      { id: 91, row_type: "pr", pr_number: 108, pr_title: "Improve pantry filters", username: "mira", created_at: "2026-07-28T12:00:00.000Z" },
      { id: 92, row_type: "close_issue", title: "Close obsolete pantry issue", created_at: "2026-07-27T12:00:00.000Z" },
    ],
    total: 2,
    hasMore: false,
  } }))
  await page.goto("/react/apps/recipebot/dev?view=kanban")
  if (testInfo.project.name === "mobile") await page.getByRole("tab", { name: /Done/ }).click()
  await expect(page.getByRole("link", { name: "View Improve pantry filters" })).toHaveAttribute("href", "/react/apps/recipebot/dev/proposals/91")
  await expect(page.getByRole("link", { name: "View Close obsolete pantry issue" })).toHaveAttribute("href", "/react/apps/recipebot/dev/governance/92")
})

test("loads older completed work through the existing keyset contract", async ({ page }) => {
  const requests: string[] = []
  await page.route("**/api/apps/recipebot/merged**", (route) => {
    const url = new URL(route.request().url())
    requests.push(url.search)
    if (url.searchParams.has("before")) {
      return route.fulfill({ json: {
        merged: [{ id: 90, row_type: "pr", pr_number: 107, pr_title: "Older pantry change", created_at: "2026-07-26T12:00:00.000Z" }],
        total: 2,
        hasMore: false,
      } })
    }
    return route.fulfill({ json: {
      merged: [{ id: 91, row_type: "pr", pr_number: 108, pr_title: "Newest pantry change", created_at: "2026-07-28T12:00:00.000Z" }],
      total: 2,
      hasMore: true,
    } })
  })
  await page.goto("/react/apps/recipebot/dev?view=list")
  await expect(page.getByTestId("dev-list")).toContainText("Newest pantry change")
  await page.getByRole("button", { name: "Load older completed work" }).click()
  await expect(page.getByTestId("dev-list")).toContainText("Older pantry change")
  await expect(page.getByRole("button", { name: "Load older completed work" })).toHaveCount(0)
  expect(requests.some((search) => search.includes("before=2026-07-28T12%3A00%3A00.000Z") && search.includes("before_id=91") && search.includes("before_type=pr"))).toBe(true)
})

test("honors the one-shot list query override and persists an explicit per-app Dev view choice", async ({ page }) => {
  await page.goto("/react/apps/recipebot/dev?view=list")
  await expect(page.getByTestId("dev-list")).toBeVisible()
  const listView = page.getByRole("button", { name: "List view" })
  const boardView = page.getByRole("button", { name: "Kanban view" })
  const byPersonView = page.getByRole("button", { name: "Tasks by assignee view" })
  await expect(listView).toHaveAttribute("aria-pressed", "true")
  await expect(listView).toHaveText("List")
  await expect(boardView).toHaveText("Board")
  await expect(byPersonView).toHaveText("By person")
  await expect(listView.locator("svg")).toHaveCount(0)
  await expect(boardView.locator("svg")).toHaveCount(0)
  await expect(byPersonView.locator("svg")).toHaveCount(0)

  await byPersonView.click()
  await expect(page).toHaveURL("/react/apps/recipebot/dev")
  await expect(page.getByTestId("dev-pm")).toBeVisible()
  await page.reload()
  await expect(page.getByTestId("dev-pm")).toBeVisible()
})

test("groups the PM projection by the leading community assignee", async ({ page }) => {
  await page.route("**/api/apps/recipebot/github-issues", (route) => route.fulfill({ json: { issues: [
    { number: 72, title: "Review ingredient substitutions", created_by_username: "sam", assignee: { top: "Ava" } },
    { number: 73, title: "Add pantry shortcuts", created_by_username: "sam" },
  ] } }))
  await page.route("**/api/apps/recipebot/promoted", (route) => route.fulfill({ json: { promoted: [
    { id: 19, pr_number: 47, pr_title: "Filter pantry staples", status: "promoted", username: "maya", assignee: { top: "Ava" }, created_at: "2026-07-28T12:00:00.000Z" },
  ] } }))
  await page.goto("/react/apps/recipebot/dev?view=pm")
  await expect(page.getByTestId("dev-pm")).toContainText("@Ava")
  await expect(page.getByTestId("dev-pm")).toContainText("Review ingredient substitutions")
  await expect(page.getByTestId("dev-pm")).toContainText("Filter pantry staples")
  await expect(page.getByRole("heading", { name: "Unassigned" })).toBeVisible()
  await expect(page.getByTestId("dev-pm")).toContainText("Add pantry shortcuts")
  await expect(page.getByTestId("dev-board")).toContainText("Collaborators can drag to cast or withdraw their own assignee vote")
})

test("reassigns and orders a PM task through the established community-vote contracts", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Pointer PM drag has desktop evidence; keyboard drag remains supplied by dnd-kit.")
  let assigned = false
  let assignment: unknown = null
  let savedOrder: unknown = null
  let pmOrder: Record<string, Array<{ type: string; ref: number }>> = {}
  await page.route("**/api/apps/recipebot/github-issues", (route) => route.fulfill({ json: { issues: [
    { number: 72, title: "Review ingredient substitutions", created_by_username: "sam", assignee: { top: "Ava" } },
    { number: 73, title: "Add pantry shortcuts", created_by_username: "sam", ...(assigned ? { assignee: { top: "Ava" } } : {}) },
  ] } }))
  await page.route("**/api/apps/recipebot/topics/issue/73/attributes", async (route) => {
    assignment = route.request().postDataJSON()
    assigned = true
    await route.fulfill({ json: { field: "assignee", options: [{ value: "Ava", count: 1, mine: true }], myValue: "Ava" } })
  })
  await page.route("**/api/apps/recipebot/pm-order", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: pmOrder })
    savedOrder = route.request().postDataJSON()
    const body = savedOrder as { assignee: string; order: Array<{ type: string; ref: number }> }
    pmOrder = { ...pmOrder, [body.assignee.toLowerCase()]: body.order }
    await route.fulfill({ json: pmOrder })
  })

  await page.goto("/react/apps/recipebot/dev?view=pm")
  const source = page.getByRole("button", { name: "Reorder Add pantry shortcuts" })
  const target = page.getByRole("link", { name: "View Review ingredient substitutions" })
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) throw new Error("Expected visible PM drag targets")
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 14, sourceBox.y + sourceBox.height / 2 + 14)
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 10 })
  await page.mouse.up()

  await expect.poll(() => assignment).toEqual({ field: "assignee", value: "Ava" })
  await expect.poll(() => savedOrder).toEqual({ assignee: "Ava", order: [{ type: "issue", ref: 73 }, { type: "issue", ref: 72 }] })
  await expect(page.getByTestId("dev-pm")).toContainText("@Ava")
})

test("keeps PM assignment and ordering read-only without collaboration access", async ({ page }) => {
  await page.route("**/api/apps/recipebot", (route) => route.fulfill({ json: { app: {
    id: "recipebot",
    slug: "recipebot",
    name: "RecipeBot",
    status: "running",
    active_users: 24,
    can_collaborate: false,
  } } }))
  await page.route("**/api/apps/recipebot/github-issues", (route) => route.fulfill({ json: { issues: [
    { number: 72, title: "Review ingredient substitutions", created_by_username: "sam", assignee: { top: "Ava" } },
  ] } }))
  await page.goto("/react/apps/recipebot/dev?view=pm")
  await expect(page.getByTestId("dev-pm")).toContainText("@Ava")
  await expect(page.getByRole("button", { name: /Reorder Review ingredient substitutions/ })).toHaveCount(0)
})

test("withdraws the collaborator's assignee vote when a PM task moves to Unassigned", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Pointer PM drag has desktop evidence; keyboard drag remains supplied by dnd-kit.")
  let cleared = false
  let savedOrder: unknown = null
  await page.route("**/api/apps/recipebot/github-issues", (route) => route.fulfill({ json: { issues: [
    { number: 72, title: "Review ingredient substitutions", created_by_username: "sam", ...(cleared ? {} : { assignee: { top: "Ava" } }) },
  ] } }))
  await page.route("**/api/apps/recipebot/topics/issue/72/attributes?field=assignee", async (route) => {
    expect(route.request().method()).toBe("DELETE")
    cleared = true
    await route.fulfill({ json: { field: "assignee", options: [], myValue: null } })
  })
  await page.route("**/api/apps/recipebot/pm-order", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: {} })
    savedOrder = route.request().postDataJSON()
    await route.fulfill({ json: { ava: [] } })
  })

  await page.goto("/react/apps/recipebot/dev?view=pm")
  const source = page.getByRole("link", { name: "View Review ingredient substitutions" })
  const target = page.getByTestId("dev-pm-lane-unassigned")
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) throw new Error("Expected visible PM drag targets")
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 14, sourceBox.y + sourceBox.height / 2 + 14)
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height - 18, { steps: 10 })
  await page.mouse.up()

  await expect.poll(() => cleared).toBe(true)
  await expect.poll(() => savedOrder).toEqual({ assignee: "Ava", order: [] })
})

test("reconciles another collaborator's PM order from the scoped global event", async ({ page }) => {
  await installGlobalEventsSocket(page)
  let reads = 0
  let orderEnabled = false
  await page.route("**/api/apps/recipebot/github-issues", (route) => route.fulfill({ json: { issues: [
    { number: 72, title: "Review ingredient substitutions", created_by_username: "sam", assignee: { top: "Ava" } },
    { number: 73, title: "Add pantry shortcuts", created_by_username: "sam", assignee: { top: "Ava" } },
  ] } }))
  await page.route("**/api/apps/recipebot/pm-order", (route) => {
    reads += 1
    return route.fulfill({ json: orderEnabled ? { ava: [{ type: "issue", ref: 73 }, { type: "issue", ref: 72 }] } : {} })
  })

  await page.goto("/react/apps/recipebot/dev?view=pm")
  const lane = page.getByTestId("dev-pm-lane-ava")
  await expect(lane.getByRole("link").first()).toContainText("Review ingredient substitutions")
  orderEnabled = true
  await page.evaluate(() => {
    const sockets = (window as unknown as { __globalEventSockets: Array<{ emit: (value: unknown) => void }> }).__globalEventSockets
    sockets.forEach((socket) => socket.emit({ type: "board_order_update", appSlug: "recipebot", pm: true }))
  })
  await expect(lane.getByRole("link").first()).toContainText("Add pantry shortcuts")
  expect(reads).toBeGreaterThanOrEqual(2)
})

test("list and PM workspace projections have no critical or serious accessibility violations", async ({ page }) => {
  for (const view of ["list", "pm"]) {
    await page.goto(`/react/apps/recipebot/dev?view=${view}`)
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
  }
})

test("persists only a supported same-column board reorder", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "The mobile selector has separate coverage; this is desktop drag-and-drop evidence.")
  await page.route("**/api/apps/recipebot/github-issues", (route) => route.fulfill({ json: { issues: [
    { number: 72, title: "Review ingredient substitutions" },
    { number: 73, title: "Add pantry shortcuts" },
  ] } }))
  let saved: unknown = null
  await page.route("**/api/apps/recipebot/board-order", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    saved = route.request().postDataJSON()
    await route.fulfill({ json: { issues: [{ type: "issue", ref: 73 }, { type: "issue", ref: 72 }], review: [] } })
  })
  await page.goto("/react/apps/recipebot/dev?view=kanban")
  const handle = page.getByRole("link", { name: "View Review ingredient substitutions", exact: true })
  const target = page.getByText("Add pantry shortcuts")
  const sourceBox = await handle.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) throw new Error("Expected visible Kanban drag targets")
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 14, sourceBox.y + sourceBox.height / 2 + 14)
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect.poll(() => saved).toEqual({ column: "issues", order: [{ type: "issue", ref: 73 }, { type: "issue", ref: 72 }] })
})

test("keeps proposal and governance cards in the review column with their established detail handoffs", async ({ page }) => {
  await page.goto("/react/apps/recipebot/dev?view=kanban")
  if ((page.viewportSize()?.width || 1024) < 640) {
    await page.getByRole("tab", { name: "In review 2" }).click()
  }
  await expect(page.locator('section[aria-label="In review column"]')).toBeVisible()
  await expect(page.getByText("Filter pantry staples")).toBeVisible()
  await expect(page.getByRole("link", { name: "View Filter pantry staples" })).toHaveAttribute("href", "/react/apps/recipebot/dev/proposals/19")
  await expect(page.getByText("Add allergy tags")).toBeVisible()
  await expect(page.getByRole("link", { name: "View Add allergy tags" })).toHaveAttribute("href", "/react/apps/recipebot/dev/governance/12")
})

test("records a governance vote through the existing server contract and reloads the detail", async ({ page }) => {
  let vote: unknown = null
  await page.route("**/api/issues/12/vote", async (route) => {
    vote = route.request().postDataJSON()
    await route.fulfill({ json: { ok: true } })
  })
  await page.goto("/react/apps/recipebot/dev/governance/12")
  const detail = page.getByTestId("governance-detail")
  await expect(detail).toContainText("Add allergy tags")
  await expect(detail.locator('[data-slot="top-bar"]').getByRole("button", { name: "Back" })).toBeVisible()
  await expect(detail.locator('[data-slot="top-bar"]').getByRole("button", { name: "Close RecipeBot" })).toBeVisible()
  await expect(detail.getByRole("heading", { level: 1 })).toHaveText("RecipeBot · Add allergy tags")
  await expect(detail.getByRole("heading", { level: 1 })).toHaveCount(1)
  await expect(detail).toHaveCSS("max-width", "none")
  await page.getByRole("button", { name: "No (0)" }).click()
  await expect.poll(() => vote).toEqual({ vote: "down" })
  const legacyActions = page.getByRole("link", { name: "Open Add allergy tags in legacy Dev for moderation and withdrawal" })
  await expect(legacyActions).toHaveAttribute("data-slot", "action-anchor")
  await expect(legacyActions).toHaveAttribute("href", "/#app/recipebot/dev/governance/12")
  await detail.locator('[data-slot="top-bar"]').getByRole("button", { name: "Back" }).click()
  await expect(page).toHaveURL(/\/react\/apps\/recipebot\/dev$/)
})

test("records a proposal vote through the existing server contract and retains force-merge legacy boundary", async ({ page }) => {
  let vote: unknown = null
  await page.route("**/api/sessions/19/vote", async (route) => {
    vote = route.request().postDataJSON()
    await route.fulfill({ json: { ok: true, merged: false } })
  })
  await page.goto("/react/apps/recipebot/dev/proposals/19")
  const detail = page.getByTestId("proposal-detail")
  await expect(detail).toContainText("Filter pantry staples")
  await expect(detail.locator('[data-slot="top-bar"]').getByRole("button", { name: "Back" })).toBeVisible()
  await expect(detail.locator('[data-slot="top-bar"]').getByRole("button", { name: "Close RecipeBot" })).toBeVisible()
  const topBar = detail.locator('[data-slot="top-bar"]')
  const title = detail.getByRole("heading", { level: 1 })
  await expect(title).toHaveText("RecipeBot · Filter pantry staples")
  await expect(detail.getByRole("heading", { level: 1 })).toHaveCount(1)
  if ((page.viewportSize()?.width || 0) < 640) {
    await expect(title).toHaveCSS("white-space", "normal")
    const identityBox = await topBar.locator('[data-slot="top-bar-identity"]').boundingBox()
    const actionsBox = await topBar.locator('[data-slot="top-bar-action"]').boundingBox()
    expect(identityBox).not.toBeNull()
    expect(actionsBox).not.toBeNull()
    expect(actionsBox!.y).toBeGreaterThanOrEqual(identityBox!.y + identityBox!.height)
  }
  await expect(detail).toHaveCSS("max-width", "none")
  const pullRequest = detail.getByRole("link", { name: "View PR" })
  await expect(pullRequest).toHaveAttribute("data-slot", "badge")
  await expect(pullRequest).toHaveAttribute("href", "https://github.com/Usernode-Labs/social-vibecoding/pull/47")
  await expect(pullRequest).toHaveAttribute("target", "_blank")
  await expect(pullRequest).toHaveAttribute("rel", "noreferrer")
  await expect(pullRequest).not.toHaveAttribute("download")
  await page.getByRole("button", { name: "Yes (2)" }).click()
  await expect.poll(() => vote).toEqual({ vote: "yes" })
  const legacyActions = page.getByRole("link", { name: "Open Filter pantry staples in legacy Dev for force-merge and moderation" })
  await expect(legacyActions).toHaveAttribute("data-slot", "action-anchor")
  await expect(legacyActions).toHaveAttribute("href", "/#app/recipebot/dev/proposals/19")
  await detail.locator('[data-slot="top-bar"]').getByRole("button", { name: "Back" }).click()
  await expect(page).toHaveURL(/\/react\/apps\/recipebot\/dev$/)
})

test("recovers a completed proposal detail outside the active proposal feed", async ({ page }) => {
  await page.route("**/api/apps/recipebot/promoted", (route) => route.fulfill({ json: { promoted: [] } }))
  await page.route("**/api/apps/recipebot/proposals/91", (route) => route.fulfill({ json: { proposal: {
    id: 91,
    pr_number: 108,
    pr_title: "Improve pantry filters",
    status: "merged",
    yes_count: 4,
    no_count: 0,
    username: "mira",
    pr_summary_md: "The pantry controls are now easier to find.",
    created_at: "2026-07-28T12:00:00.000Z",
  } } }))
  await page.goto("/react/apps/recipebot/dev/proposals/91")
  await expect(page.getByTestId("proposal-detail")).toContainText("Improve pantry filters")
  await expect(page.getByTestId("proposal-detail")).toContainText("Merged")
})

test("recovers an applied governance detail outside the open governance feed", async ({ page }) => {
  await page.route("**/api/apps/recipebot/issues", (route) => route.fulfill({ json: { issues: [] } }))
  await page.route("**/api/apps/recipebot/governance/92", (route) => route.fulfill({ json: { issue: {
    id: 92,
    title: "Close obsolete pantry issue",
    kind: "close_issue",
    status: "closed",
    up_count: 4,
    down_count: 0,
    description: "The replacement is live.",
    created_at: "2026-07-27T12:00:00.000Z",
  } } }))
  await page.goto("/react/apps/recipebot/dev/governance/92")
  await expect(page.getByTestId("governance-detail")).toContainText("Close obsolete pantry issue")
  await expect(page.getByTestId("governance-detail")).toContainText("closed")
})

test("keeps proposal and governance not-found recovery inside the React app", async ({ page }) => {
  await page.route("**/api/apps/recipebot/promoted", (route) => route.fulfill({ json: { promoted: [] } }))
  await page.route("**/api/apps/recipebot/proposals/404", (route) => route.fulfill({ json: { proposal: null } }))
  await page.goto("/react/apps/recipebot/dev/proposals/404")
  const proposalRecovery = page.getByRole("link", { name: "Back to Dev" })
  await expect(proposalRecovery).toHaveAttribute("data-slot", "action-link")
  await expect(proposalRecovery).toHaveAttribute("href", "/react/apps/recipebot/dev")

  await page.route("**/api/apps/recipebot/issues", (route) => route.fulfill({ json: { issues: [] } }))
  await page.route("**/api/apps/recipebot/governance/404", (route) => route.fulfill({ json: { issue: null } }))
  await page.goto("/react/apps/recipebot/dev/governance/404")
  const governanceRecovery = page.getByRole("link", { name: "Back to Dev" })
  await expect(governanceRecovery).toHaveAttribute("data-slot", "action-link")
  await expect(governanceRecovery).toHaveAttribute("href", "/react/apps/recipebot/dev")
})

test("gives and retracts direct proposal kudos through the existing reversible contract", async ({ page }) => {
  let directKudos = false
  const requests: string[] = []
  await page.route("**/api/apps/recipebot/promoted", (route) => route.fulfill({ json: { promoted: [{
    id: 19, pr_number: 47, pr_title: "Filter pantry staples", status: "promoted", username: "maya", yes_count: 2, no_count: 0, votes_required: 3, chat_count: 4, kudos_count: directKudos ? 3 : 2, my_kudos_direct: directKudos, created_at: "2026-07-28T12:00:00.000Z",
  }] } }))
  await page.route("**/api/sessions/19/kudos", async (route) => {
    requests.push(route.request().method())
    directKudos = route.request().method() === "POST"
    await route.fulfill({ json: { ok: true, remaining: directKudos ? 4 : 5, limit: 5 } })
  })
  await page.goto("/react/apps/recipebot/dev/proposals/19")
  await page.getByRole("button", { name: /Give kudos 2/ }).click()
  await expect.poll(() => requests).toEqual(["POST"])
  await expect(page.getByRole("alert").filter({ hasText: "Recognition updated" })).toContainText("4 of 5 weekly recognition slots remain")
  await expect(page.getByRole("button", { name: /Retract kudos 3/ })).toBeVisible()
  await page.getByRole("button", { name: /Retract kudos 3/ }).click()
  await expect.poll(() => requests).toEqual(["POST", "DELETE"])
  await expect(page.getByRole("button", { name: /Give kudos 2/ })).toBeVisible()
})

test("keeps a rejected proposal kudos request actionable", async ({ page }) => {
  await page.route("**/api/sessions/19/kudos", (route) => route.fulfill({ status: 429, json: { error: "Weekly kudos quota exceeded (5/week)." } }))
  await page.goto("/react/apps/recipebot/dev/proposals/19")
  await page.getByRole("button", { name: /Give kudos/ }).click()
  await expect(page.getByRole("alert").filter({ hasText: "Weekly kudos quota exceeded" })).toBeVisible()
  await expect(page.getByRole("button", { name: /Give kudos/ })).toBeVisible()
})

test("keeps a rejected governance vote actionable", async ({ page }) => {
  await page.route("**/api/issues/12/vote", (route) => route.fulfill({ status: 409, json: { error: "Issue is not open" } }))
  await page.goto("/react/apps/recipebot/dev/governance/12")
  await page.getByRole("button", { name: "Yes (1)" }).click()
  await expect(page.getByRole("alert").filter({ hasText: "Issue is not open" })).toBeVisible()
})

test("has no critical or serious accessibility violations", async ({ page }) => {
  await page.goto("/react/apps/recipebot/dev")
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})

test("production review mode makes New session unavailable without a mutation request", async ({ page }) => {
  test.skip(process.env.SV_PRODUCTION_READONLY !== "true", "This state is compiled only for the production-review profile.")
  let creationRequests = 0
  await page.route("**/api/apps/recipebot/sessions", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    creationRequests += 1
    await route.fulfill({ status: 500, json: { error: "This request must not be made." } })
  })
  await page.goto("/react/apps/recipebot/dev")
  await expect(page.getByRole("alert")).toContainText("Read-only")
  await expect(page.getByRole("alert")).toContainText("Creating sessions and changing work order or assignees are unavailable.")
  await expect(page.getByRole("button", { name: "Create a session in RecipeBot" })).toBeDisabled()
  expect(creationRequests).toBe(0)
})

test("production review mode exposes no PM mutation affordances", async ({ page }) => {
  test.skip(process.env.SV_PRODUCTION_READONLY !== "true", "This state is compiled only for the production-review profile.")
  await page.route("**/api/apps/recipebot/github-issues", (route) => route.fulfill({ json: { issues: [
    { number: 72, title: "Review ingredient substitutions", created_by_username: "sam", assignee: { top: "Ava" } },
  ] } }))
  await page.goto("/react/apps/recipebot/dev?view=pm")
  await expect(page.getByTestId("dev-pm")).toContainText("@Ava")
  await expect(page.getByRole("button", { name: /Reorder Review ingredient substitutions/ })).toHaveCount(0)
})

test("production review mode disables proposal votes without a mutation request", async ({ page }) => {
  test.skip(process.env.SV_PRODUCTION_READONLY !== "true", "This state is compiled only for the production-review profile.")
  let mutations = 0
  await page.route("**/api/sessions/19/vote", async (route) => {
    mutations += 1
    await route.fulfill({ status: 500, json: { error: "This request must not be made." } })
  })
  await page.goto("/react/apps/recipebot/dev/proposals/19")
  await expect(page.getByRole("button", { name: "Yes (2)" })).toBeDisabled()
  expect(mutations).toBe(0)
})

test("production review mode disables proposal kudos without a mutation request", async ({ page }) => {
  test.skip(process.env.SV_PRODUCTION_READONLY !== "true", "This state is compiled only for the production-review profile.")
  let mutations = 0
  await page.route("**/api/sessions/19/kudos", async (route) => {
    mutations += 1
    await route.fulfill({ status: 500, json: { error: "This request must not be made." } })
  })
  await page.goto("/react/apps/recipebot/dev/proposals/19")
  await expect(page.getByRole("button", { name: /Give kudos/ })).toBeDisabled()
  expect(mutations).toBe(0)
})
