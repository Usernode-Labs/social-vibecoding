import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

const issue = {
  number: 84,
  title: "Make pantry filters easier to find",
  body: "The pantry controls are difficult to discover on a small screen.",
  htmlUrl: "https://github.com/Usernode-Labs/social-vibecoding/issues/84",
  created_by_username: "mira",
  bounty_count: 2,
  chatCount: 5,
  headless: { status: "ready" },
  in_progress: { count: 1 },
}

const comments = [
  { author: "mira", body: "The filters need to work with existing search terms.", createdAt: "2026-07-28T08:00:00.000Z" },
  { author: "sam", body: "I can take the first pass.", createdAt: "2026-07-28T09:00:00.000Z" },
]

async function installDevOverviewFixture(page: import("@playwright/test").Page, issues = [issue]) {
  await page.route("**/api/apps/recipebot", (route) => route.fulfill({ json: { app: { id: "recipebot", slug: "recipebot", name: "RecipeBot", status: "running", active_users: 24 } } }))
  await page.route("**/api/apps/recipebot/sessions", (route) => route.fulfill({ json: { sessions: [] } }))
  await page.route("**/api/apps/recipebot/promoted", (route) => route.fulfill({ json: { promoted: [] } }))
  await page.route("**/api/apps/recipebot/issues", (route) => route.fulfill({ json: { issues: [] } }))
  await page.route("**/api/apps/recipebot/github-issues", (route) => route.fulfill({ json: { issues } }))
}

async function installIssueFixture(page: import("@playwright/test").Page, issues = [issue], priority = { field: "priority", options: [], myValue: null }, onPriorityMutation?: (route: import("@playwright/test").Route) => Promise<void>) {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: 7, username: "mira", canCreateApps: true } } }))
  await page.route("**/api/apps/recipebot", (route) => route.fulfill({ json: { app: { id: "recipebot", slug: "recipebot", name: "RecipeBot", status: "running", can_collaborate: false } } }))
  await page.route("**/api/apps/recipebot/messages?thread_type=issue&thread_ref=84&limit=50", (route) => route.fulfill({ json: { messages: [] } }))
  await page.route("**/api/models", (route) => route.fulfill({ json: {
    default: "claude-sonnet-5",
    models: [
      { id: "claude-sonnet-5", label: "Sonnet 5", changeSize: { short: "Balanced", long: "A balanced choice for most issue proposals." } },
      { id: "claude-opus-5", label: "Opus 5", changeSize: { short: "Thorough", long: "Use more deliberate reasoning for complex issue proposals." } },
    ],
  } }))
  await page.route("**/api/apps/recipebot/topics/issue/84/attributes?field=priority", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: priority })
    if (onPriorityMutation) return onPriorityMutation(route)
    return route.fallback()
  })
  await page.route("**/api/apps/recipebot/topics/issue/84/attributes?field=category", (route) => route.fulfill({ json: {
    field: "category",
    options: [{ value: "ux", count: 2, mine: false }],
    myValue: null,
    categories: [
      { value: "bug", label: "Bug", custom: false },
      { value: "ux", label: "UX", custom: true },
    ],
  } }))
  await page.route("**/api/apps/recipebot/topics/issue/84/attributes?field=assignee", (route) => route.fulfill({ json: {
    field: "assignee",
    options: [{ value: "sam", count: 2, mine: false }],
    myValue: null,
  } }))
  await page.route("**/api/apps/recipebot/github-issues/84/comments", (route) => route.fulfill({ json: { comments, truncated: true } }))
  await page.route("**/api/apps/recipebot/github-issues", (route) => route.fulfill({ json: { issues } }))
  await page.route("**/api/apps/recipebot/issues", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { issues: [] } })
    return route.fallback()
  })
}

test("lets the recorded author rename an open issue through the canonical PATCH contract", async ({ page }) => {
  await installIssueFixture(page)
  let patch: { method: string; body: unknown } | null = null
  await page.route("**/api/apps/recipebot/github-issues/84/title", async (route) => {
    patch = { method: route.request().method(), body: route.request().postDataJSON() }
    await route.fulfill({ json: { ok: true, title: "Make pantry filters easy to find" } })
  })
  await page.goto("/react/apps/recipebot/dev/issues/84")
  await page.getByRole("button", { name: "Edit issue title" }).click()
  await page.getByRole("textbox", { name: "Issue title" }).fill("Make pantry filters easy to find")
  await page.getByRole("button", { name: "Save title" }).click()
  await expect.poll(() => patch).toEqual({ method: "PATCH", body: { title: "Make pantry filters easy to find" } })
  await expect(page.getByTestId("github-issue-detail")).toContainText("Make pantry filters easy to find")
})

test("keeps author-only editing hidden for another viewer", async ({ page }) => {
  await installIssueFixture(page)
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: 8, username: "sam" } } }))
  await page.goto("/react/apps/recipebot/dev/issues/84")
  await expect(page.getByRole("button", { name: "Edit issue title" })).toHaveCount(0)
})

test("shows the canonical server error if author access changes before save", async ({ page }) => {
  await installIssueFixture(page)
  await page.route("**/api/apps/recipebot/github-issues/84/title", (route) => route.fulfill({ status: 403, json: { error: "Only the issue's author can edit its title" } }))
  await page.goto("/react/apps/recipebot/dev/issues/84")
  await page.getByRole("button", { name: "Edit issue title" }).click()
  await page.getByRole("textbox", { name: "Issue title" }).fill("Different title")
  await page.getByRole("button", { name: "Save title" }).click()
  await expect(page.getByRole("alert").filter({ hasText: "Only the issue's author" })).toBeVisible()
})

test("lets a collaborator mark an open issue in progress through the canonical POST", async ({ page }) => {
  await installIssueFixture(page)
  let request: { method: string; body: string | null } | null = null
  await page.route("**/api/apps/recipebot/github-issues/84/claim", async (route) => {
    request = { method: route.request().method(), body: route.request().postData() }
    await route.fulfill({ json: { ok: true, created: true, claimedAt: "2026-07-28T10:00:00.000Z" } })
  })
  await page.goto("/react/apps/recipebot/dev/issues/84")
  await page.getByRole("button", { name: "Mark in progress" }).click()
  await expect.poll(() => request).toEqual({ method: "POST", body: null })
})

test("lets a collaborator clear only their own in-progress mark", async ({ page }) => {
  const mine = { ...issue, in_progress: { count: 1, mine: true } }
  await installIssueFixture(page, [mine])
  let request: { method: string; body: string | null } | null = null
  await page.route("**/api/apps/recipebot/github-issues/84/claim", async (route) => {
    request = { method: route.request().method(), body: route.request().postData() }
    await route.fulfill({ json: { ok: true, cleared: true } })
  })
  await page.goto("/react/apps/recipebot/dev/issues/84")
  await page.getByRole("button", { name: "Clear my in-progress mark" }).click()
  await expect.poll(() => request).toEqual({ method: "DELETE", body: null })
})

test("lets a write admin clear a specific collaborator's stale in-progress mark", async ({ page }) => {
  const claimed = {
    ...issue,
    in_progress: {
      count: 0,
      mine: false,
      claims: [{ userId: 8, username: "sam", mine: false, claimedAt: "2026-07-21T10:00:00.000Z" }],
    },
  }
  await installIssueFixture(page, [claimed])
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: 7, username: "mira", isAdmin: true, canAdminWrite: true } } }))
  let request: { method: string; body: unknown } | null = null
  await page.route("**/api/apps/recipebot/github-issues/84/claim", async (route) => {
    request = { method: route.request().method(), body: route.request().postDataJSON() }
    await route.fulfill({ json: { ok: true, cleared: true } })
  })

  await page.goto("/react/apps/recipebot/dev/issues/84")
  await expect(page.getByRole("heading", { name: "In-progress claims" })).toBeVisible()
  const clearClaim = page.getByRole("button", { name: "Clear sam's in-progress claim" })
  await expect(clearClaim).toHaveCSS("width", "24px")
  await expect(clearClaim).toHaveCSS("height", "24px")
  await expect(clearClaim.locator(':scope > [data-slot="platform-icon"]')).toHaveCSS("width", "12px")
  await expect(clearClaim.locator(':scope > [data-slot="platform-icon"]')).toHaveCSS("height", "12px")
  await clearClaim.click()

  await expect.poll(() => request).toEqual({ method: "DELETE", body: { userId: 8 } })
})

test("does not expose another collaborator's claim-clear action to a regular user", async ({ page }) => {
  const claimed = {
    ...issue,
    in_progress: {
      count: 0,
      mine: false,
      claims: [{ userId: 8, username: "sam", mine: false }],
    },
  }
  await installIssueFixture(page, [claimed])
  await page.goto("/react/apps/recipebot/dev/issues/84")
  await expect(page.getByRole("heading", { name: "In-progress claims" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Clear sam's in-progress claim" })).toHaveCount(0)
})

test("keeps an admin claim-clear failure actionable with the canonical server reason", async ({ page }) => {
  const claimed = {
    ...issue,
    in_progress: {
      count: 0,
      mine: false,
      claims: [{ userId: 8, username: "sam", mine: false }],
    },
  }
  await installIssueFixture(page, [claimed])
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: 7, username: "mira", isAdmin: true, canAdminWrite: true } } }))
  await page.route("**/api/apps/recipebot/github-issues/84/claim", (route) => route.fulfill({ status: 403, json: { error: "Only the claimer or an admin can clear this" } }))

  await page.goto("/react/apps/recipebot/dev/issues/84")
  await page.getByRole("button", { name: "Clear sam's in-progress claim" }).click()

  await expect(page.getByRole("alert").filter({ hasText: "Only the claimer or an admin can clear this" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Clear sam's in-progress claim" })).toBeEnabled()
})

test("shows the canonical claim error instead of changing local status", async ({ page }) => {
  await installIssueFixture(page)
  await page.route("**/api/apps/recipebot/github-issues/84/claim", (route) => route.fulfill({ status: 422, json: { error: "Cannot verify the issue right now" } }))
  await page.goto("/react/apps/recipebot/dev/issues/84")
  await page.getByRole("button", { name: "Mark in progress" }).click()
  await expect(page.getByRole("alert").filter({ hasText: "Cannot verify the issue right now" })).toBeVisible()
})

test("records a one-way issue kudos pledge through the canonical bounty contract", async ({ page }) => {
  await installIssueFixture(page)
  let request: { method: string; body: string | null } | null = null
  await page.route("**/api/apps/recipebot/issues/84/bounty", async (route) => {
    request = { method: route.request().method(), body: route.request().postData() }
    await route.fulfill({ json: { ok: true, bountyCount: 3, remaining: 4, limit: 5 } })
  })
  await page.goto("/react/apps/recipebot/dev/issues/84")
  await page.getByRole("button", { name: "Give kudos" }).click()
  await expect.poll(() => request).toEqual({ method: "POST", body: null })
  await expect(page.getByRole("alert").filter({ hasText: "Your pledge is recorded. 4 of 5 weekly kudos remain." })).toBeVisible()
  await expect(page.getByText("Your pledge", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Give kudos" })).toHaveCount(0)
})

test("keeps a failed issue kudos pledge actionable and shows the canonical server error", async ({ page }) => {
  await installIssueFixture(page)
  await page.route("**/api/apps/recipebot/issues/84/bounty", (route) => route.fulfill({ status: 429, json: { error: "Weekly kudos quota exceeded (5/week). Resets every Monday 00:00 UTC." } }))
  await page.goto("/react/apps/recipebot/dev/issues/84")
  await page.getByRole("button", { name: "Give kudos" }).click()
  await expect(page.getByRole("alert").filter({ hasText: "Weekly kudos quota exceeded" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Give kudos" })).toBeEnabled()
})

test("creates a vote-only close proposal without directly closing GitHub", async ({ page }) => {
  await installIssueFixture(page)
  let request: { method: string; body: unknown } | null = null
  await page.route("**/api/apps/recipebot/issues", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { issues: [] } })
    request = { method: route.request().method(), body: route.request().postDataJSON() }
    await route.fulfill({
      status: 201,
      json: {
        issue: {
          id: 910,
          kind: "close_issue",
          title: "Close issue #84",
          status: "open",
          up_count: 0,
          down_count: 0,
          created_at: "2026-07-28T10:00:00.000Z",
          payload: { issueNumber: 84, reason: "The replacement is already live." },
        },
      },
    })
  })

  await page.goto("/react/apps/recipebot/dev/issues/84")
  await page.getByRole("button", { name: "Propose to close" }).click()
  await expect(page.getByRole("alertdialog")).toContainText("It does not close the GitHub issue now")
  await page.getByLabel("Reason (optional)").fill("The replacement is already live.")
  expect(request).toBeNull()
  await page.getByRole("button", { name: "Create close proposal" }).click()

  await expect.poll(() => request).toEqual({
    method: "POST",
    body: {
      kind: "close_issue",
      payload: { issueNumber: 84, reason: "The replacement is already live." },
    },
  })
  await expect(page.getByRole("alert").filter({ hasText: "Close proposal created" })).toBeVisible()
  const closeProposalLink = page.getByRole("link", { name: "Close proposed" })
  await expect(closeProposalLink).toHaveAttribute("data-slot", "action-link")
  await expect(closeProposalLink).toHaveAttribute("href", "/react/apps/recipebot/dev/governance/910")
})

test("renders the existing close proposal instead of offering a duplicate", async ({ page }) => {
  await installIssueFixture(page)
  await page.route("**/api/apps/recipebot/issues", (route) => route.fulfill({
    json: {
      issues: [{
        id: 910,
        kind: "close_issue",
        title: "Close issue #84",
        status: "open",
        up_count: 1,
        down_count: 0,
        created_at: "2026-07-28T10:00:00.000Z",
        payload: { issueNumber: 84 },
      }],
    },
  }))

  await page.goto("/react/apps/recipebot/dev/issues/84")
  await expect(page.getByRole("button", { name: "Propose to close" })).toHaveCount(0)
  const closeProposalLink = page.getByRole("link", { name: "Close proposed" })
  await expect(closeProposalLink).toHaveAttribute("data-slot", "action-link")
  await expect(closeProposalLink).toHaveAttribute("href", "/react/apps/recipebot/dev/governance/910")
})

test("keeps a completed headless proposal on its caller-owned session route", async ({ page }) => {
  await installIssueFixture(page, [{ ...issue, headless: { status: "ready", mySessionId: 44 } }])
  await page.goto("/react/apps/recipebot/dev/issues/84")

  const sessionLink = page.getByRole("link", { name: "Go to my session" })
  await expect(sessionLink).toHaveAttribute("data-slot", "action-link")
  await expect(sessionLink).toHaveAttribute("href", "/react/apps/recipebot/dev/sessions/44")
})

test("keeps a rejected close proposal actionable with the canonical server reason", async ({ page }) => {
  await installIssueFixture(page)
  await page.route("**/api/apps/recipebot/issues", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { issues: [] } })
    return route.fulfill({ status: 422, json: { error: "Couldn't confirm this issue is open right now. Try again in a moment." } })
  })

  await page.goto("/react/apps/recipebot/dev/issues/84")
  await page.getByRole("button", { name: "Propose to close" }).click()
  await page.getByRole("button", { name: "Create close proposal" }).click()

  await expect(page.getByRole("alert").filter({ hasText: "Couldn't confirm this issue is open" })).toBeVisible()
  await expect(page.getByRole("alertdialog")).toBeVisible()
  await expect(page.getByRole("button", { name: "Create close proposal" })).toBeEnabled()
})

test("starts the existing headless proposal workflow only after explicit model confirmation", async ({ page }) => {
  await installIssueFixture(page, [{ ...issue, headless: null }])
  let request: { method: string; body: unknown } | null = null
  await page.route("**/api/apps/recipebot/issues/84/headless-session", async (route) => {
    request = { method: route.request().method(), body: route.request().postDataJSON() }
    await route.fulfill({ status: 201, json: { session: { id: 701 } } })
  })
  await page.goto("/react/apps/recipebot/dev/issues/84")
  await page.getByRole("button", { name: "Generate proposal" }).click()
  await expect(page.getByRole("alertdialog")).toContainText("Generate a proposal for issue #84?")
  expect(request).toBeNull()
  await page.getByRole("button", { name: "Generate proposal" }).last().click()
  await expect.poll(() => request).toEqual({ method: "POST", body: { model: "claude-sonnet-5" } })
  await expect(page.getByRole("alert").filter({ hasText: "A proposal is being generated" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Generating proposal…" })).toBeDisabled()
})

test("creates an issue-linked Dev session with an editable kickoff draft", async ({ page }) => {
  await installIssueFixture(page)
  let request: { method: string; body: unknown } | null = null
  await page.route("**/api/apps/recipebot/sessions", async (route) => {
    request = { method: route.request().method(), body: route.request().postDataJSON() }
    await route.fulfill({
      status: 201,
      json: {
        session: {
          id: 55,
          branch_name: "dev/issue-84",
          pr_title: null,
          session_title: null,
          status: "active",
          warm: true,
          created_at: "2026-07-28T10:00:00.000Z",
        },
      },
    })
  })
  await page.route("**/api/sessions/55", (route) => route.fulfill({ json: {
    session: {
      id: 55,
      app_slug: "recipebot",
      app_name: "RecipeBot",
      branch_name: "dev/issue-84",
      pr_title: null,
      session_title: null,
      status: "active",
      warm: true,
      created_at: "2026-07-28T10:00:00.000Z",
    },
    messages: [],
  } }))
  await page.route("**/api/sessions/55/status", (route) => route.fulfill({ json: {
    busy: false,
    phase: null,
    progress: [],
    estimate: null,
    resolving: false,
    sync: null,
  } }))

  await page.goto("/react/apps/recipebot/dev/issues/84")
  await page.getByRole("button", { name: "Create proposal" }).click()

  await expect.poll(() => request).toEqual({ method: "POST", body: { issueNumber: 84 } })
  await expect(page).toHaveURL(/\/react\/apps\/recipebot\/dev\/sessions\/55$/)
  await expect(page.getByRole("textbox", { name: "Message for Builder" })).toHaveValue(
    /Please implement GitHub issue #84: "Make pantry filters easier to find"\./,
  )
  await expect(page.getByRole("textbox", { name: "Message for Builder" })).toHaveValue(/Closes #84/)
})

test("clones a ready headless proposal into the caller's private Dev session", async ({ page }) => {
  await installIssueFixture(page, [{ ...issue, headless: { status: "ready", sessionId: 701, outcome: "spec" } }])
  let request: { method: string; body: string | null } | null = null
  await page.route("**/api/sessions/701/clone-headless", async (route) => {
    request = { method: route.request().method(), body: route.request().postData() }
    await route.fulfill({ json: { session: { id: 44 } } })
  })
  await page.goto("/react/apps/recipebot/dev/issues/84")
  await page.getByRole("button", { name: "Review spec & start session" }).click()
  await expect.poll(() => request).toEqual({ method: "POST", body: null })
  await expect(page).toHaveURL(/\/react\/apps\/recipebot\/dev\/sessions\/44$/)
})

test("keeps a failed proposal start retryable and shows the server error", async ({ page }) => {
  await installIssueFixture(page, [{ ...issue, headless: null }])
  await page.route("**/api/apps/recipebot/issues/84/headless-session", (route) => route.fulfill({ status: 429, json: { error: "Daily model budget is exhausted." } }))
  await page.goto("/react/apps/recipebot/dev/issues/84")
  await page.getByRole("button", { name: "Generate proposal" }).click()
  await page.getByRole("button", { name: "Generate proposal" }).last().click()
  await expect(page.getByRole("alert").filter({ hasText: "Daily model budget is exhausted." })).toBeVisible()
  await expect(page.getByRole("button", { name: "Generate proposal" })).toHaveCount(1)
})

test("casts a reversible personal priority vote through the canonical POST", async ({ page }) => {
  await installIssueFixture(page)
  let request: { method: string; body: unknown } | null = null
  await page.route("**/api/apps/recipebot/topics/issue/84/attributes", async (route) => {
    request = { method: route.request().method(), body: route.request().postDataJSON() }
    await route.fulfill({ json: { field: "priority", options: [{ value: "high", count: 1, mine: true }], myValue: "high" } })
  })
  await page.goto("/react/apps/recipebot/dev/issues/84")
  const priorityLabel = page.locator('[data-slot="field-label"]').filter({ hasText: "Priority" })
  await expect(priorityLabel.locator(':scope > [data-slot="platform-icon"]')).toHaveCSS("width", "14px")
  await expect(priorityLabel.locator(':scope > [data-slot="platform-icon"]')).toHaveCSS("height", "14px")
  await page.getByRole("combobox", { name: "My priority" }).click()
  await page.getByRole("option", { name: "High" }).click()
  await expect.poll(() => request).toEqual({ method: "POST", body: { field: "priority", value: "high" } })
})

test("withdraws only the caller's priority vote through the canonical DELETE", async ({ page }) => {
  let request: { method: string; body: string | null } | null = null
  await installIssueFixture(page, [issue], { field: "priority", options: [{ value: "medium", count: 1, mine: true }], myValue: "medium" }, async (route) => {
    request = { method: route.request().method(), body: route.request().postData() }
    await route.fulfill({ json: { field: "priority", options: [], myValue: null } })
  })
  await page.goto("/react/apps/recipebot/dev/issues/84")
  await page.getByRole("button", { name: "Clear my priority" }).click()
  await expect.poll(() => request).toEqual({ method: "DELETE", body: null })
})

test("casts a category vote from the app's canonical vocabulary", async ({ page }) => {
  await installIssueFixture(page)
  let request: { method: string; body: unknown } | null = null
  await page.route("**/api/apps/recipebot/topics/issue/84/attributes", async (route) => {
    request = { method: route.request().method(), body: route.request().postDataJSON() }
    await route.fulfill({ json: {
      field: "category",
      options: [{ value: "ux", count: 3, mine: true }],
      myValue: "ux",
      categories: [{ value: "ux", label: "UX", custom: true }],
    } })
  })

  await page.goto("/react/apps/recipebot/dev/issues/84")
  await page.getByRole("combobox", { name: "My category" }).click()
  await page.getByRole("option", { name: "UX" }).click()

  await expect.poll(() => request).toEqual({ method: "POST", body: { field: "category", value: "ux" } })
})

test("suggests an assignee as the caller's reversible social vote", async ({ page }) => {
  await installIssueFixture(page)
  let request: { method: string; body: unknown } | null = null
  await page.route("**/api/apps/recipebot/topics/issue/84/attributes", async (route) => {
    request = { method: route.request().method(), body: route.request().postDataJSON() }
    await route.fulfill({ json: {
      field: "assignee",
      options: [{ value: "alex", count: 1, mine: true }],
      myValue: "alex",
    } })
  })

  await page.goto("/react/apps/recipebot/dev/issues/84")
  await page.getByRole("textbox", { name: "Suggest assignee" }).fill("alex")
  await page.getByRole("textbox", { name: "Suggest assignee" }).press("Enter")

  await expect.poll(() => request).toEqual({ method: "POST", body: { field: "assignee", value: "alex" } })
})

test("preserves a typed category when the server rejects the vote", async ({ page }) => {
  await installIssueFixture(page)
  await page.route("**/api/apps/recipebot/topics/issue/84/attributes", (route) => route.fulfill({ status: 400, json: { error: "This app already has the maximum of 20 custom categories." } }))

  await page.goto("/react/apps/recipebot/dev/issues/84")
  const input = page.getByRole("textbox", { name: "Suggest category" })
  await input.fill("Research")
  await input.press("Enter")

  await expect(page.getByRole("alert").filter({ hasText: "maximum of 20 custom categories" })).toBeVisible()
  await expect(input).toHaveValue("Research")
})

test("links the Dev board issue card to the owned GitHub issue detail", async ({ page }, testInfo) => {
  await installDevOverviewFixture(page)
  // Mobile now defaults to the legacy-compatible linear view. This assertion
  // covers the Kanban card projection, so select that explicit route mode.
  await page.goto("/react/apps/recipebot/dev?view=kanban")
  const board = page.getByTestId("dev-board")
  if (testInfo.project.name === "mobile") await board.getByRole("tab", { name: "In progress" }).click()
  const issueLink = board.getByRole("link", { name: `View ${issue.title}` })
  await expect(issueLink).toHaveAttribute("href", "/react/apps/recipebot/dev/issues/84")
})

test("renders a loading skeleton before resolving the GitHub issue and its comments", async ({ page }) => {
  let resolveIssues: (() => void) | undefined
  let markIssuesRequested: (() => void) | undefined
  const issuesReady = new Promise<void>((resolve) => { resolveIssues = resolve })
  const issuesRequested = new Promise<void>((resolve) => { markIssuesRequested = resolve })
  await page.route("**/api/apps/recipebot", (route) => route.fulfill({ json: {
    app: {
      id: "recipebot",
      slug: "recipebot",
      name: "RecipeBot",
      status: "running",
      can_collaborate: false,
    },
  } }))
  await page.route("**/api/apps/recipebot/github-issues", async (route) => {
    markIssuesRequested?.()
    await issuesReady
    await route.fulfill({ json: { issues: [issue] } })
  })
  await page.route("**/api/apps/recipebot/github-issues/84/comments", (route) => route.fulfill({ json: { comments } }))
  await page.goto("/react/apps/recipebot/dev/issues/84", { waitUntil: "domcontentloaded" })
  await issuesRequested
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(2)
  await expect(page.locator('[data-slot="top-bar"]')).not.toContainText("RecipeBot")
  resolveIssues?.()
  await expect(page.getByTestId("github-issue-detail")).toContainText(issue.title)
})

test("renders the issue and comments without a legacy action handoff", async ({ page }) => {
  await installIssueFixture(page)
  await page.goto("/react/apps/recipebot/dev/issues/84")
  const detail = page.getByTestId("github-issue-detail")
  await expect(detail).toContainText("GitHub issue #84 · opened by mira")
  await expect(detail).toContainText("Proposal ready")
  await expect(detail).toContainText(comments[0].body)
  await expect(detail).toContainText("Only the newest GitHub comments are shown here.")
  await expect(detail.locator('[data-slot="top-bar"]').getByRole("button", { name: "Back" })).toBeVisible()
  await expect(detail.locator('[data-slot="top-bar"]').getByRole("button", { name: "Close RecipeBot" })).toBeVisible()
  await expect(detail.getByRole("heading", { level: 1 })).toHaveText(`RecipeBot · ${issue.title}`)
  await expect(detail.getByRole("heading", { level: 1 })).toHaveCount(1)
  await expect(detail).toHaveCSS("max-width", "none")
  const viewOnGitHub = detail.getByRole("link", { name: "View on GitHub" })
  await expect(viewOnGitHub).toHaveAttribute("data-slot", "action-anchor")
  await expect(viewOnGitHub).toHaveAttribute("href", issue.htmlUrl)
  await expect(viewOnGitHub).toHaveAttribute("target", "_blank")
  await expect(viewOnGitHub).toHaveAttribute("rel", "noreferrer")
  await expect(detail.getByRole("link", { name: /legacy Dev/i })).toHaveCount(0)
  await detail.locator('[data-slot="top-bar"]').getByRole("button", { name: "Back" }).click()
  await expect(page).toHaveURL(/\/react\/apps\/recipebot\/dev$/)
})

test("renders recoverable unavailable and not-found states", async ({ page }) => {
  await page.route("**/api/apps/error/github-issues", (route) => route.fulfill({ status: 403, json: { error: "Forbidden" } }))
  await page.goto("/react/apps/error/dev/issues/84")
  await expect(page.getByTestId("github-issue-detail-error")).toContainText("GitHub issue unavailable")

  await installIssueFixture(page, [])
  await page.goto("/react/apps/recipebot/dev/issues/999")
  await expect(page.getByTestId("github-issue-detail-not-found")).toContainText("GitHub issue not found")
  await expect(page.locator('[data-slot="top-bar"]')).not.toContainText("RecipeBot")
  const recoveryLink = page.getByRole("link", { name: "Back to Dev" })
  await expect(recoveryLink).toHaveAttribute("data-slot", "action-link")
  await expect(recoveryLink).toHaveAttribute("href", "/react/apps/recipebot/dev")
})

test("keeps the detail readable without horizontal overflow on a phone", async ({ page }) => {
  await installIssueFixture(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/react/apps/recipebot/dev/issues/84")
  const detail = page.getByTestId("github-issue-detail")
  await expect(detail).toBeVisible()
  expect(await detail.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
})

test("has no critical or serious accessibility violations", async ({ page }) => {
  await installIssueFixture(page)
  await page.goto("/react/apps/recipebot/dev/issues/84")
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})

test("production review mode keeps the author title action non-mutating", async ({ page }) => {
  test.skip(process.env.SV_PRODUCTION_READONLY !== "true", "This state is compiled only for the production-review profile.")
  await installIssueFixture(page, [{
    ...issue,
    in_progress: { count: 0, mine: false, claims: [{ userId: 8, username: "sam", mine: false }] },
  }])
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: 7, username: "mira", isAdmin: true, canAdminWrite: true } } }))
  let writes = 0
  await page.route("**/api/apps/recipebot/github-issues/84/title", async (route) => {
    writes += 1
    await route.fallback()
  })
  await page.route("**/api/apps/recipebot/issues", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { issues: [] } })
    writes += 1
    await route.fallback()
  })
  await page.goto("/react/apps/recipebot/dev/issues/84")
  await expect(page.getByRole("alert").filter({
    hasText: "Issue details can be reviewed here, but editing, close proposals, priority, in-progress marks, and kudos pledges are disabled.",
  })).toBeVisible()
  await expect(page.getByRole("button", { name: "Edit issue title" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Mark in progress" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Give kudos" })).toHaveCount(0)
  await expect(page.getByRole("combobox", { name: "My priority" })).toHaveCount(0)
  await expect(page.getByRole("combobox", { name: "My category" })).toHaveCount(0)
  await expect(page.getByRole("textbox", { name: "Suggest assignee" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Generate proposal" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Create proposal" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Propose to close" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Clear sam's in-progress claim" })).toHaveCount(0)
  expect(writes).toBe(0)
})
