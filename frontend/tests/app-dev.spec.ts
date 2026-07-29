import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

test.beforeEach(async ({ page }) => {
  await page.route("**/api/apps/recipebot", (route) => route.fulfill({ json: { app: { id: "recipebot", slug: "recipebot", name: "RecipeBot", status: "running", active_users: 24, can_collaborate: true } } }))
  await page.route("**/api/apps/recipebot/sessions", (route) => route.fulfill({ json: { sessions: [{ id: 9, branch_name: "feature/pantry", pr_title: null, session_title: "Improve pantry search", status: "active", warm: true, created_at: "2026-07-28T12:00:00.000Z" }] } }))
  await page.route("**/api/apps/recipebot/promoted", (route) => route.fulfill({ json: { promoted: [{ id: 19, pr_number: 47, pr_title: "Filter pantry staples", status: "promoted", yes_count: 2, no_count: 0, votes_required: 3, chat_count: 4, created_at: "2026-07-28T12:00:00.000Z" }] } }))
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
  await expect(page.getByRole("link", { name: "Open RecipeBot discussion" })).toHaveAttribute("href", "/react/apps/recipebot/dev/chat")
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
  await expect(page.getByRole("button", { name: "List view" })).toHaveAttribute("aria-pressed", "true")

  await page.getByRole("button", { name: "Tasks by assignee view" }).click()
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
  const source = page.getByRole("link", { name: "View Add pantry shortcuts" })
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
  await expect(page.getByTestId("governance-detail")).toContainText("Add allergy tags")
  await page.getByRole("button", { name: "No (0)" }).click()
  await expect.poll(() => vote).toEqual({ vote: "down" })
  await expect(page.getByRole("link", { name: "Open Add allergy tags in legacy Dev for moderation and withdrawal" })).toHaveAttribute("href", "/#app/recipebot/dev/governance/12")
})

test("records a proposal vote through the existing server contract and retains force-merge legacy boundary", async ({ page }) => {
  let vote: unknown = null
  await page.route("**/api/sessions/19/vote", async (route) => {
    vote = route.request().postDataJSON()
    await route.fulfill({ json: { ok: true, merged: false } })
  })
  await page.goto("/react/apps/recipebot/dev/proposals/19")
  await expect(page.getByTestId("proposal-detail")).toContainText("Filter pantry staples")
  await page.getByRole("button", { name: "Yes (2)" }).click()
  await expect.poll(() => vote).toEqual({ vote: "yes" })
  await expect(page.getByRole("link", { name: "Open Filter pantry staples in legacy Dev for force-merge and moderation" })).toHaveAttribute("href", "/#app/recipebot/dev/proposals/19")
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
  await expect(page.getByRole("alert")).toContainText("4 of 5 weekly recognition slots remain")
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
  await expect(page.getByRole("alert")).toContainText("Production review mode")
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
