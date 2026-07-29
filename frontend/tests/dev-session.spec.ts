import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

test.beforeEach(async ({ page }) => {
  await page.route("**/api/apps/recipebot", (route) => route.fulfill({ json: {
    app: {
      id: "recipebot",
      slug: "recipebot",
      name: "RecipeBot",
      status: "running",
      active_users: 24,
      is_favorited: false,
      is_collaborator: true,
      your_apps_hidden: false,
      favorite_order: null,
      open_prs: 0,
      active_sessions: 1,
      open_issues: 0,
      can_collaborate: true,
    },
  } }))
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: {
    user: {
      username: "maya",
      locale: "en",
      aiProgressEstimate: true,
      hasApiKey: false,
      keyLast4: null,
      usernodePubkey: null,
      walletLinkEnabled: false,
      isAdmin: false,
      canAdminWrite: false,
    },
  } }))
  await page.route("**/api/budget", (route) => route.fulfill({ json: {
    spentCents: 125,
    limitCents: 500,
    globalSpentCents: 1_250,
    globalLimitCents: 5_000,
    byokSpentCents: 0,
    aiEnabled: true,
  } }))
  await page.route("**/api/models", (route) => route.fulfill({ json: {
    default: "claude-opus-5",
    models: [
      { id: "claude-sonnet-5", label: "Sonnet 5", changeSize: { short: "simple, small changes", long: "One small thing at a time." } },
      { id: "claude-opus-5", label: "Opus 5", changeSize: { short: "general coding work", long: "General coding work." } },
      { id: "claude-fable-5", label: "Fable 5", changeSize: { short: "design, taste, and difficult coding", long: "Design and difficult coding." } },
    ],
  } }))
  await page.route("**/api/sessions/9", (route) => route.fulfill({ json: {
    session: { id: 9, app_slug: "recipebot", app_name: "RecipeBot", branch_name: "feature/pantry", session_title: "Improve pantry search", pr_title: null, status: "active", created_at: "2026-07-28T12:00:00.000Z" },
    messages: [
      { id: 1, role: "system", content: "Session started · RecipeBot", model: null, token_count: null, cost_cents: null, metadata: null, created_at: "2026-07-28T12:00:00.000Z" },
      { id: 2, role: "user", content: "Add a pantry filter.", model: null, token_count: null, cost_cents: null, metadata: null, created_at: "2026-07-28T12:01:00.000Z" },
      { id: 3, role: "assistant", content: "I’ll first inspect the existing search flow.", model: "claude-opus-5", token_count: 42, cost_cents: 0, metadata: null, created_at: "2026-07-28T12:01:03.000Z" },
    ],
  } }))
})

test("renders an existing Dev session without a legacy action handoff", async ({ page }) => {
  await page.goto("/react/apps/recipebot/dev/sessions/9")
  const route = page.getByTestId("dev-session")
  const chrome = route.getByTestId("app-context-chrome")
  await expect(route).toContainText("Improve pantry search")
  await expect(route.getByRole("heading", { name: /RecipeBot.*Improve pantry search/, level: 1 })).toBeVisible()
  await expect(route.locator("h1")).toHaveCount(1)
  await expect(chrome.getByRole("button", { name: "Back" })).toBeVisible()
  await expect(chrome.getByRole("button", { name: "Close RecipeBot" })).toBeVisible()
  expect(await route.getAttribute("class")).not.toMatch(/\b(?:mx-auto|max-w-)/)
  const chromeBox = await chrome.boundingBox()
  const contentBox = await route.locator(":scope > :not([data-testid='app-context-chrome'])").first().boundingBox()
  expect(chromeBox).not.toBeNull()
  expect(contentBox).not.toBeNull()
  expect(contentBox!.y).toBeGreaterThanOrEqual(chromeBox!.y + chromeBox!.height)
  await expect(page.getByTestId("dev-budget-status")).toContainText("$1.25 / $5.00")
  await expect(page.getByLabel("Development session conversation")).toContainText("Add a pantry filter.")
  await expect(page.getByRole("link", { name: /legacy Dev/i })).toHaveCount(0)
  await chrome.getByRole("button", { name: "Back" }).click()
  await expect(page).toHaveURL(/\/react\/apps\/recipebot\/dev$/)
})

test("explains exhausted shared credits and links to the unified settings surface", async ({ page }) => {
  await page.route("**/api/budget", (route) => route.fulfill({ json: {
    spentCents: 500,
    limitCents: 500,
    globalSpentCents: 1_250,
    globalLimitCents: 5_000,
    byokSpentCents: 0,
    aiEnabled: true,
  } }))
  await page.goto("/react/apps/recipebot/dev/sessions/9")

  const alert = page.getByTestId("dev-budget-exhausted")
  await expect(alert).toContainText("Today’s free AI credits are used up")
  await expect(alert.getByRole("link", { name: "Open settings" })).toHaveAttribute("href", "/react/settings")
})

test("loads a legacy saved draft and sends it only after an explicit action", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("usernode:dc-saved-drafts:9", JSON.stringify([
      { id: "draft-one", text: "Make the header sticky.", savedAt: "2026-07-29T00:00:00.000Z" },
    ]))
  })
  let requestBody: { message?: string; model?: string } | undefined
  await page.route("**/api/sessions/9/chat", (route) => {
    requestBody = route.request().postDataJSON() as typeof requestBody
    return route.fulfill({ contentType: "text/event-stream", body: "data: {\"type\":\"done\"}\n\n" })
  })
  await page.goto("/react/apps/recipebot/dev/sessions/9")

  await expect(page.getByRole("heading", { name: "Saved drafts" })).toBeVisible()
  await page.getByRole("button", { name: "Send saved draft: Make the header sticky." }).click()
  await expect.poll(() => requestBody?.message).toBe("Make the header sticky.")
  await expect.poll(() => page.evaluate(() => localStorage.getItem("usernode:dc-saved-drafts:9"))).toBe("[]")
})

test("keeps the composer writable during a live turn and parks text as a local draft", async ({ page }) => {
  await page.addInitScript(() => {
    class MockEventSource {
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null

      constructor() {
        setTimeout(() => {
          this.onmessage?.({
            data: JSON.stringify({ _seq: 88, type: "token", text: "Builder is working." }),
          })
        }, 20)
      }

      close() {}
    }
    Object.defineProperty(window, "EventSource", { configurable: true, value: MockEventSource })
  })
  await page.goto("/react/apps/recipebot/dev/sessions/9")
  await expect(page.getByText("Builder is working.", { exact: true })).toBeVisible()

  const composer = page.getByLabel("Message for Builder")
  await expect(composer).toBeEnabled()
  await composer.fill("Also simplify the empty state.")
  await page.getByRole("button", { name: "Save message as a draft" }).click()

  await expect(composer).toHaveValue("")
  await expect(page.getByText("Also simplify the empty state.", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Send saved draft: Also simplify the empty state." })).toBeDisabled()
  await expect.poll(() => page.evaluate(() => {
    const drafts = JSON.parse(localStorage.getItem("usernode:dc-saved-drafts:9") || "[]") as Array<{ text?: string }>
    return drafts[0]?.text
  })).toBe("Also simplify the empty state.")
})

test("prefills and persists a server-authored quick reply without sending it", async ({ page }) => {
  let chatRequests = 0
  await page.route("**/api/sessions/9", (route) => route.fulfill({ json: {
    session: { id: 9, app_slug: "recipebot", app_name: "RecipeBot", branch_name: "feature/pantry", session_title: "Improve pantry search", pr_title: null, status: "active", created_at: "2026-07-28T12:00:00.000Z" },
    messages: [
      { id: 1, role: "assistant", content: "What should we improve next?", model: "claude-opus-5", token_count: 42, cost_cents: 0, metadata: { quickReplies: ["Add a pantry filter", "Improve the empty state"] }, created_at: "2026-07-28T12:01:03.000Z" },
    ],
  } }))
  await page.route("**/api/sessions/9/chat", (route) => {
    chatRequests += 1
    return route.fulfill({ contentType: "text/event-stream", body: "data: {\"type\":\"done\"}\n\n" })
  })
  await page.goto("/react/apps/recipebot/dev/sessions/9")

  await expect(page.getByLabel("Suggested replies")).toBeVisible()
  await page.getByRole("button", { name: "Add a pantry filter" }).click()
  await expect(page.getByLabel("Message for Builder")).toHaveValue("Add a pantry filter")
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("social-vibecoding:dev-session-draft:9"))).toBe("Add a pantry filter")
  expect(chatRequests).toBe(0)
})

test("sends a single structured assistant answer immediately through the current model", async ({ page }) => {
  let requestBody: { message?: string; model?: string; attachmentIds?: string[] } | undefined
  await page.route("**/api/sessions/9", (route) => route.fulfill({ json: {
    session: { id: 9, app_slug: "recipebot", app_name: "RecipeBot", branch_name: "feature/pantry", session_title: "Improve pantry search", pr_title: null, status: "active", created_at: "2026-07-28T12:00:00.000Z" },
    messages: [
      { id: 1, role: "assistant", content: "Which layout should I use?", model: "claude-opus-5", token_count: 42, cost_cents: 0, metadata: { suggestions: [{ question: "Layout", answers: ["Use cards", "Use a table"] }] }, created_at: "2026-07-28T12:01:03.000Z" },
    ],
  } }))
  await page.route("**/api/sessions/9/chat", (route) => {
    requestBody = route.request().postDataJSON() as typeof requestBody
    return route.fulfill({ contentType: "text/event-stream", body: "data: {\"type\":\"done\"}\n\n" })
  })
  await page.goto("/react/apps/recipebot/dev/sessions/9")

  await page.getByRole("button", { name: /Use cards/ }).click()
  await expect.poll(() => requestBody).toEqual({ message: "Use cards", model: "claude-opus-5" })
})

test("combines selected answers for a multi-question assistant prompt", async ({ page }) => {
  let requestBody: { message?: string; model?: string } | undefined
  await page.route("**/api/sessions/9", (route) => route.fulfill({ json: {
    session: { id: 9, app_slug: "recipebot", app_name: "RecipeBot", branch_name: "feature/pantry", session_title: "Improve pantry search", pr_title: null, status: "active", created_at: "2026-07-28T12:00:00.000Z" },
    messages: [
      { id: 1, role: "assistant", content: "Two choices before I build.", model: "claude-opus-5", token_count: 42, cost_cents: 0, metadata: { suggestions: [
        { question: "Viewport", answers: ["Mobile first", "Desktop first"] },
        { question: "Density", answers: ["Comfortable", "Compact"] },
      ] }, created_at: "2026-07-28T12:01:03.000Z" },
    ],
  } }))
  await page.route("**/api/sessions/9/chat", (route) => {
    requestBody = route.request().postDataJSON() as typeof requestBody
    return route.fulfill({ contentType: "text/event-stream", body: "data: {\"type\":\"done\"}\n\n" })
  })
  await page.goto("/react/apps/recipebot/dev/sessions/9")

  await page.getByRole("button", { name: /Mobile first/ }).click()
  await page.getByRole("button", { name: "Compact" }).click()
  await page.getByRole("button", { name: "Send answers" }).click()
  await expect.poll(() => requestBody?.message).toBe("1. Mobile first\n2. Compact")
})

test("renders authenticated historical attachments from message metadata", async ({ page }) => {
  const attachmentId = "b22bd5f60bcd5450b22bd5f60bcd5450"
  await page.route("**/api/sessions/9", (route) => route.fulfill({ json: {
    session: { id: 9, app_slug: "recipebot", app_name: "RecipeBot", branch_name: "feature/pantry", session_title: "Improve pantry search", pr_title: null, status: "active", created_at: "2026-07-28T12:00:00.000Z" },
    messages: [
      { id: 1, role: "user", content: "Use these pantry notes.", model: null, token_count: null, cost_cents: null, metadata: { attachments: [{ id: attachmentId, kind: "text", filename: "pantry-notes.txt", contentType: "text/plain", sizeBytes: 2048 }] }, created_at: "2026-07-28T12:01:03.000Z" },
    ],
  } }))
  await page.goto("/react/apps/recipebot/dev/sessions/9")

  await expect(page.getByLabel("Message attachments")).toContainText("pantry-notes.txt")
  await expect(page.getByRole("link", { name: "Download pantry-notes.txt" })).toHaveAttribute(
    "href",
    `/api/sessions/9/attachments/${attachmentId}`,
  )
})

test("renders safe live token events through the resumable session stream", async ({ page }) => {
  await page.route("**/api/sessions/9/events", (route) => route.fulfill({
    contentType: "text/event-stream",
    // Replayed events retain their sequence number. The adapter must render
    // the message once even when EventSource reconnects and replays it.
    body: "id: 77\ndata: {\"_seq\":77,\"type\":\"token\",\"text\":\"A live Builder update.\",\"model\":\"claude-opus-5\"}\n\nid: 77\ndata: {\"_seq\":77,\"type\":\"token\",\"text\":\"A live Builder update.\",\"model\":\"claude-opus-5\"}\n\n",
  }))
  await page.goto("/react/apps/recipebot/dev/sessions/9")
  await expect(page.getByText("A live Builder update.", { exact: true })).toHaveCount(1)
})

test("surfaces a recoverable in-progress worker state", async ({ page }) => {
  await page.route("**/api/sessions/9/status", (route) => route.fulfill({ json: {
    busy: true, phase: "cc", progress: [{ text: "Builder is updating the pantry filter" }], estimate: null, resolving: false, sync: null,
  } }))
  await page.goto("/react/apps/recipebot/dev/sessions/9")
  await expect(page.getByRole("heading", { name: "Improve pantry search", level: 1 })).toBeVisible()
  await expect(page.getByText("Builder is updating the pantry filter")).toBeVisible()
  await expect(page.getByRole("button", { name: "Stop turn" })).toBeEnabled()
})

test("stops an in-progress Dev turn through the owner-scoped server contract", async ({ page }) => {
  let stopRequests = 0
  await page.route("**/api/sessions/9/status", (route) => route.fulfill({ json: {
    busy: true, phase: "cc", progress: [{ text: "Builder is updating the pantry filter" }], estimate: null, resolving: false, sync: null,
  } }))
  await page.route("**/api/sessions/9/stop", async (route) => {
    stopRequests += 1
    expect(route.request().method()).toBe("POST")
    expect(route.request().postData()).toBeNull()
    await route.fulfill({ json: { ok: true, stopped: true } })
  })
  await page.goto("/react/apps/recipebot/dev/sessions/9")
  await expect(page.getByRole("button", { name: "Stop turn" })).toBeVisible()
  await page.getByRole("button", { name: "Stop turn" }).click()
  await expect.poll(() => stopRequests).toBe(1)
})

test("proposes an idle session through the existing owner-scoped server contract", async ({ page }) => {
  let status = "active"
  let promoteRequests = 0
  await page.route("**/api/sessions/9/status", (route) => route.fulfill({ json: {
    busy: false, phase: null, progress: [], estimate: null, resolving: false, sync: null,
  } }))
  await page.route("**/api/sessions/9", (route) => route.fulfill({ json: {
    session: { id: 9, app_slug: "recipebot", app_name: "RecipeBot", branch_name: "feature/pantry", session_title: "Improve pantry search", pr_title: null, status, created_at: "2026-07-28T12:00:00.000Z" },
    messages: [],
  } }))
  await page.route("**/api/sessions/9/promote", async (route) => {
    promoteRequests += 1
    expect(route.request().method()).toBe("POST")
    expect(route.request().postData()).toBeNull()
    status = "promoted"
    await route.fulfill({ json: { ok: true, prNumber: 84, prUrl: "https://github.com/Usernode-Labs/recipebot/pull/84", prTitle: "Improve pantry search" } })
  })
  await page.goto("/react/apps/recipebot/dev/sessions/9")
  await expect(page.getByRole("button", { name: "Propose change" })).toBeVisible()
  await page.getByRole("button", { name: "Propose change" }).click()
  await expect(page.getByRole("heading", { name: "Propose these changes for voting?" })).toBeVisible()
  await page.getByRole("button", { name: "Propose change" }).last().click()
  await expect.poll(() => promoteRequests).toBe(1)
  await expect(page.getByText("promoted", { exact: true })).toBeVisible()
})

test("makes an owner session visible and reloads the canonical visibility state", async ({ page }) => {
  let sharedAt: string | null = null
  let visibilityRequests = 0
  await page.route("**/api/sessions/9", (route) => route.fulfill({ json: {
    session: { id: 9, app_slug: "recipebot", app_name: "RecipeBot", branch_name: "feature/pantry", session_title: "Improve pantry search", pr_title: null, status: "active", shared_at: sharedAt, created_at: "2026-07-28T12:00:00.000Z" },
    messages: [],
  } }))
  await page.route("**/api/sessions/9/share", async (route) => {
    visibilityRequests += 1
    expect(route.request().method()).toBe("POST")
    expect(route.request().postData()).toBeNull()
    sharedAt = "2026-07-28T13:00:00.000Z"
    await route.fulfill({ json: { ok: true, shared_at: sharedAt } })
  })
  await page.goto("/react/apps/recipebot/dev/sessions/9")
  await page.getByRole("button", { name: "Make visible" }).click()
  await expect.poll(() => visibilityRequests).toBe(1)
  await expect(page.getByText("Visible to everyone", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Make private" })).toBeVisible()
})

test("keeps a failed visibility update actionable", async ({ page }) => {
  await page.route("**/api/sessions/9/share", (route) => route.fulfill({ status: 403, json: { error: "Only the session owner can change visibility." } }))
  await page.goto("/react/apps/recipebot/dev/sessions/9")
  await page.getByRole("button", { name: "Make visible" }).click()
  await expect(page.getByRole("alert")).toContainText("Only the session owner can change visibility.")
  await expect(page.getByRole("button", { name: "Make visible" })).toBeVisible()
})

test("keeps a failed promotion actionable", async ({ page }) => {
  let promoteRequests = 0
  await page.route("**/api/sessions/9/status", (route) => route.fulfill({ json: {
    busy: false, phase: null, progress: [], estimate: null, resolving: false, sync: null,
  } }))
  await page.route("**/api/sessions/9/promote", (route) => {
    promoteRequests += 1
    return route.fulfill({ status: 429, json: { error: "You already have 5 PRs up for vote." } })
  })
  await page.goto("/react/apps/recipebot/dev/sessions/9")
  await page.getByRole("button", { name: "Propose change" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Propose change" }).click()
  await expect.poll(() => promoteRequests).toBe(1)
  await expect(page.getByRole("alert")).toContainText("You already have 5 PRs up for vote.")
  await expect(page.getByRole("button", { name: "Propose change" }).first()).toBeVisible()
})

test("re-runs failed proposal checks through the existing owner-scoped server contract", async ({ page }) => {
  let recheckRequests = 0
  await page.route("**/api/sessions/9", (route) => route.fulfill({ json: {
    session: { id: 9, app_slug: "recipebot", app_name: "RecipeBot", branch_name: "feature/pantry", session_title: "Improve pantry search", pr_title: null, status: "promoted", check_state: "failing", check_error_detail: "The mobile capture did not meet the expected selector.", created_at: "2026-07-28T12:00:00.000Z" },
    messages: [],
  } }))
  await page.route("**/api/sessions/9/recheck", async (route) => {
    recheckRequests += 1
    expect(route.request().method()).toBe("POST")
    expect(route.request().postData()).toBeNull()
    await route.fulfill({ json: { status: "running", checkState: "pending" } })
  })
  await page.goto("/react/apps/recipebot/dev/sessions/9")
  await expect(page.getByText("The mobile capture did not meet the expected selector.")).toBeVisible()
  await page.getByRole("button", { name: "Re-run checks" }).click()
  await expect(page.getByRole("heading", { name: "Run the proposal checks again?" })).toBeVisible()
  expect(recheckRequests).toBe(0)
  await page.getByRole("alertdialog").getByRole("button", { name: "Re-run checks" }).click()
  await expect.poll(() => recheckRequests).toBe(1)
  await expect(page.getByRole("alert").filter({ hasText: "Checks are running again" })).toBeVisible()
})

test("keeps a failed recheck actionable", async ({ page }) => {
  await page.route("**/api/sessions/9", (route) => route.fulfill({ json: {
    session: { id: 9, app_slug: "recipebot", app_name: "RecipeBot", branch_name: "feature/pantry", session_title: "Improve pantry search", pr_title: null, status: "promoted", check_state: "error", created_at: "2026-07-28T12:00:00.000Z" },
    messages: [],
  } }))
  await page.route("**/api/sessions/9/recheck", (route) => route.fulfill({ status: 403, json: { error: "Not allowed" } }))
  await page.goto("/react/apps/recipebot/dev/sessions/9")
  await page.getByRole("button", { name: "Re-run checks" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Re-run checks" }).click()
  await expect(page.getByRole("alert").filter({ hasText: "Not allowed" })).toBeVisible()
  await expect(page.getByTestId("dev-session").getByRole("button", { name: "Re-run checks" })).toBeVisible()
})

test("starts a Dev turn through the existing server contract", async ({ page }) => {
  let requestBody: { message?: string; attachmentIds?: string[]; model?: string } | undefined
  await page.route("**/api/sessions/9/chat", (route) => {
    requestBody = route.request().postDataJSON() as typeof requestBody
    return route.fulfill({ contentType: "text/event-stream", body: "data: {\"type\":\"done\"}\n\n" })
  })
  await page.goto("/react/apps/recipebot/dev/sessions/9")
  await page.getByLabel("Message for Builder").fill("Add a pantry filter.")
  await page.getByRole("button", { name: "Send message" }).click()
  await expect.poll(() => requestBody).toEqual({ message: "Add a pantry filter.", model: "claude-opus-5" })
})

test("uses the server-authorized selected model for the next Dev turn", async ({ page }) => {
  let requestBody: { model?: string } | undefined
  await page.route("**/api/sessions/9/chat", (route) => {
    requestBody = route.request().postDataJSON() as typeof requestBody
    return route.fulfill({ contentType: "text/event-stream", body: "data: {\"type\":\"done\"}\n\n" })
  })
  await page.goto("/react/apps/recipebot/dev/sessions/9")
  await page.getByRole("combobox", { name: "Model for this turn" }).click()
  await page.getByRole("option", { name: /Fable 5/ }).click()
  await page.getByLabel("Message for Builder").fill("Review the mobile layout.")
  await page.getByRole("button", { name: "Send message" }).click()
  await expect.poll(() => requestBody?.model).toBe("claude-fable-5")
})

test("pauses an active session through the existing reversible lifecycle contract", async ({ page }) => {
  let status = "active"
  let pauseRequests = 0
  await page.route("**/api/sessions/9", (route) => route.fulfill({ json: {
    session: { id: 9, app_slug: "recipebot", app_name: "RecipeBot", branch_name: "feature/pantry", session_title: "Improve pantry search", pr_title: null, status, created_at: "2026-07-28T12:00:00.000Z" },
    messages: [],
  } }))
  await page.route("**/api/sessions/9/pause", async (route) => {
    pauseRequests += 1
    expect(route.request().method()).toBe("POST")
    status = "paused"
    await route.fulfill({ json: { ok: true } })
  })
  await page.goto("/react/apps/recipebot/dev/sessions/9")
  await page.getByRole("button", { name: "Pause session" }).click()
  await expect(page.getByRole("button", { name: "Resume session" })).toBeVisible()
  expect(pauseRequests).toBe(1)
})

test("keeps a resume capacity failure actionable and leaves the session paused", async ({ page }) => {
  await page.route("**/api/sessions/9", (route) => route.fulfill({ json: {
    session: { id: 9, app_slug: "recipebot", app_name: "RecipeBot", branch_name: "feature/pantry", session_title: "Improve pantry search", pr_title: null, status: "paused", created_at: "2026-07-28T12:00:00.000Z" },
    messages: [],
  } }))
  await page.route("**/api/sessions/9/resume", (route) => route.fulfill({ status: 429, json: { error: "Your other sessions are busy finishing turns. Try again in a moment." } }))
  await page.goto("/react/apps/recipebot/dev/sessions/9")
  await page.getByRole("button", { name: "Resume session" }).click()
  await expect(page.getByRole("alert")).toContainText("Your other sessions are busy finishing turns. Try again in a moment.")
  await expect(page.getByRole("button", { name: "Resume session" })).toBeVisible()
})

test("requires an explicit confirmation before archiving and returns to the app Dev overview", async ({ page }) => {
  let archiveRequests = 0
  await page.route("**/api/sessions/9/archive", async (route) => {
    archiveRequests += 1
    expect(route.request().method()).toBe("POST")
    expect(route.request().postData()).toBeNull()
    await route.fulfill({ json: { ok: true } })
  })
  await page.goto("/react/apps/recipebot/dev/sessions/9")
  await page.getByRole("button", { name: "Archive session" }).click()
  await expect(page.getByRole("heading", { name: "Archive this session?" })).toBeVisible()
  expect(archiveRequests).toBe(0)
  await page.getByRole("button", { name: "Archive session" }).last().click()
  await expect(page).toHaveURL("/react/apps/recipebot/dev")
  expect(archiveRequests).toBe(1)
})

test("restores an archived owner session through the existing reversible lifecycle contract", async ({ page }) => {
  let status = "archived"
  let unarchiveRequests = 0
  await page.route("**/api/sessions/9", (route) => route.fulfill({ json: {
    session: { id: 9, app_slug: "recipebot", app_name: "RecipeBot", branch_name: "feature/pantry", session_title: "Improve pantry search", pr_title: null, status, created_at: "2026-07-28T12:00:00.000Z" },
    messages: [],
  } }))
  await page.route("**/api/sessions/9/unarchive", async (route) => {
    unarchiveRequests += 1
    expect(route.request().method()).toBe("POST")
    expect(route.request().postData()).toBeNull()
    status = "paused"
    await route.fulfill({ json: { ok: true, ccPurged: false, prReopened: true } })
  })
  await page.goto("/react/apps/recipebot/dev/sessions/9")
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Make visible" })).toHaveCount(0)
  await page.getByRole("button", { name: "Restore session" }).click()
  await expect(page.getByRole("heading", { name: "Restore this archived session?" })).toBeVisible()
  expect(unarchiveRequests).toBe(0)
  await page.getByRole("alertdialog").getByRole("button", { name: "Restore session" }).click()
  await expect.poll(() => unarchiveRequests).toBe(1)
  await expect(page.getByText("paused", { exact: true })).toBeVisible()
  await expect(page.getByRole("alert")).toContainText("pull request was reopened")
  await expect(page.getByRole("button", { name: "Resume session" })).toBeVisible()
})

test("uploads an attachment before it becomes eligible to send", async ({ page }) => {
  await page.route("**/api/sessions/9/attachments?filename=notes.txt", (route) => route.fulfill({ json: {
    id: "attachment-1", kind: "text", filename: "notes.txt", contentType: "text/plain", sizeBytes: 16, meta: null,
  } }))
  await page.goto("/react/apps/recipebot/dev/sessions/9")
  await page.locator('input[type="file"]').setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("pantry notes"),
  })
  await expect(page.getByLabel("Pending attachments")).toContainText("notes.txt")
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled()
})

for (const mode of ["light", "dark"] as const) {
  test(`has no critical or serious accessibility violations in ${mode} mode`, async ({ page }) => {
    await page.addInitScript((selectedMode) => window.localStorage.setItem("theme", selectedMode), mode)
    await page.goto("/react/apps/recipebot/dev/sessions/9")
    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
  })
}

test("production review mode disables the reversible lifecycle without a mutation request", async ({ page }) => {
  test.skip(process.env.SV_PRODUCTION_READONLY !== "true", "This state is compiled only for the production-review profile.")
  let mutations = 0
  await page.route("**/api/sessions/9/pause", async (route) => {
    mutations += 1
    await route.fulfill({ status: 500, json: { error: "This request must not be made." } })
  })
  await page.goto("/react/apps/recipebot/dev/sessions/9")
  await expect(page.getByRole("alert").filter({ hasText: "Read-only" })).toContainText("Session actions and messages are unavailable.")
  await expect(page.getByRole("button", { name: "Pause session" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Archive session" })).toBeDisabled()
  expect(mutations).toBe(0)
})

test("production review mode disables archived-session restoration without a mutation request", async ({ page }) => {
  test.skip(process.env.SV_PRODUCTION_READONLY !== "true", "This state is compiled only for the production-review profile.")
  let mutations = 0
  await page.route("**/api/sessions/9", (route) => route.fulfill({ json: {
    session: { id: 9, app_slug: "recipebot", app_name: "RecipeBot", branch_name: "feature/pantry", session_title: "Improve pantry search", pr_title: null, status: "archived", created_at: "2026-07-28T12:00:00.000Z" },
    messages: [],
  } }))
  await page.route("**/api/sessions/9/unarchive", async (route) => {
    mutations += 1
    await route.fulfill({ status: 500, json: { error: "This request must not be made." } })
  })
  await page.goto("/react/apps/recipebot/dev/sessions/9")
  await expect(page.getByRole("button", { name: "Restore session" })).toBeDisabled()
  expect(mutations).toBe(0)
})

test("production review mode never starts proposal checks", async ({ page }) => {
  test.skip(process.env.SV_PRODUCTION_READONLY !== "true", "This state is compiled only for the production-review profile.")
  let mutations = 0
  await page.route("**/api/sessions/9", (route) => route.fulfill({ json: {
    session: { id: 9, app_slug: "recipebot", app_name: "RecipeBot", branch_name: "feature/pantry", session_title: "Improve pantry search", pr_title: null, status: "promoted", check_state: "failing", created_at: "2026-07-28T12:00:00.000Z" },
    messages: [],
  } }))
  await page.route("**/api/sessions/9/recheck", async (route) => {
    mutations += 1
    await route.fulfill({ status: 500, json: { error: "This request must not be made." } })
  })
  await page.goto("/react/apps/recipebot/dev/sessions/9")
  await expect(page.getByRole("button", { name: "Re-run checks" })).toBeDisabled()
  expect(mutations).toBe(0)
})

test("production review mode does not expose a stop-turn mutation", async ({ page }) => {
  test.skip(process.env.SV_PRODUCTION_READONLY !== "true", "This state is compiled only for the production-review profile.")
  let mutations = 0
  await page.route("**/api/sessions/9/status", (route) => route.fulfill({ json: {
    busy: true, phase: "cc", progress: [], estimate: null, resolving: false, sync: null,
  } }))
  await page.route("**/api/sessions/9/stop", async (route) => {
    mutations += 1
    await route.fulfill({ status: 500, json: { error: "This request must not be made." } })
  })
  await page.goto("/react/apps/recipebot/dev/sessions/9")
  await expect(page.getByRole("button", { name: "Stop turn" })).toBeDisabled()
  expect(mutations).toBe(0)
})

test("production review mode does not send a visibility mutation", async ({ page }) => {
  test.skip(process.env.SV_PRODUCTION_READONLY !== "true", "This state is compiled only for the production-review profile.")
  let mutations = 0
  await page.route("**/api/sessions/9/share", async (route) => {
    mutations += 1
    await route.fulfill({ status: 500, json: { error: "This request must not be made." } })
  })
  await page.goto("/react/apps/recipebot/dev/sessions/9")
  await expect(page.getByRole("button", { name: "Make visible" })).toBeDisabled()
  expect(mutations).toBe(0)
})
