import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

const app = {
  id: "recipebot",
  slug: "recipebot",
  name: "RecipeBot",
  status: "running",
  tagline: "Find a recipe for what you have at home",
  active_users: 24,
  is_favorited: true,
  is_collaborator: true,
  your_apps_hidden: false,
  favorite_order: 0,
  open_prs: 0,
  active_sessions: 0,
  open_issues: 0,
  icon_url: null,
  view_visibility: "private",
  can_manage: true,
  can_collaborate: true,
  self_hosted: false,
}

function roster(rows = [
  { userId: 7, username: "ava", status: "member", invitedBy: null, isCreator: true, createdAt: "2026-07-20T10:00:00Z", acceptedAt: "2026-07-20T10:00:00Z" },
  { userId: 12, username: "lin", status: "member", invitedBy: "ava", isCreator: false, createdAt: "2026-07-21T10:00:00Z", acceptedAt: "2026-07-21T10:00:00Z" },
  { userId: 15, username: "max", status: "invited", invitedBy: "ava", isCreator: false, createdAt: "2026-07-22T10:00:00Z", acceptedAt: null },
]) {
  return { collaborators: rows, collabVisibility: "private", viewVisibility: "private", creatorId: 7 }
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: 7, username: "ava" } } }))
  await page.route("**/api/apps/recipebot", (route) => route.fulfill({ json: { app } }))
  await page.route("**/api/public/apps/recipebot/contributors?include_wallets=0", (route) => route.fulfill({ json: { contributors: [] } }))
})

test("links App Detail to the collaboration manager and renders member/pending-invite states", async ({ page }) => {
  const rows = roster().collaborators
  await page.route("**/api/apps/recipebot/collaborators", (route) => route.fulfill({ json: roster(rows) }))

  await page.goto("/react/apps/recipebot")
  await expect(page.getByRole("link", { name: "Manage RecipeBot collaborators" })).toHaveAttribute("href", "/react/apps/recipebot/members")
  await page.getByRole("link", { name: "Manage RecipeBot collaborators" }).click()

  const members = page.getByTestId("app-members")
  const chrome = members.getByTestId("app-context-chrome")
  await expect(members).toContainText("RecipeBot collaborators")
  await expect(chrome.getByRole("group", { name: "RecipeBot controls" })).toHaveAttribute("data-placement", "flow")
  await expect(members.locator("h1")).toHaveCount(1)
  await expect(members.getByRole("heading", { level: 1, name: "RecipeBot · Members and visibility" })).toBeVisible()
  await expect.poll(() => members.evaluate((element) => getComputedStyle(element).maxWidth)).toBe("none")
  await expect(page.getByRole("list", { name: "RecipeBot collaborators" })).toContainText("@ava")
  await expect(page.getByRole("list", { name: "RecipeBot collaborators" })).toContainText("Creator")
  await expect(page.getByRole("list", { name: "RecipeBot collaborators" })).toContainText("@max")
  await expect(page.getByRole("list", { name: "RecipeBot collaborators" })).toContainText("Invited")
  await expect(page.getByRole("button", { name: "Remove @lin" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Revoke @max" })).toBeVisible()
  await chrome.getByRole("button", { name: "Back" }).click()
  await expect(page).toHaveURL("/react/apps/recipebot")
})

test("uses the canonical typeahead and invite endpoints, then reloads the canonical roster", async ({ page }) => {
  let rows = roster().collaborators
  let inviteRequest: { method: string; body: unknown } | null = null
  await page.route("**/api/apps/recipebot/collaborators", (route) => route.fulfill({ json: roster(rows) }))
  await page.route("**/api/users/search?*", (route) => route.fulfill({ json: { users: [{ id: 22, username: "mira" }] } }))
  await page.route("**/api/apps/recipebot/invites", async (route) => {
    inviteRequest = { method: route.request().method(), body: route.request().postDataJSON() }
    rows = [...rows, { userId: 22, username: "mira", status: "invited", invitedBy: "ava", createdAt: "2026-07-28T10:00:00Z", acceptedAt: null }]
    await route.fulfill({ status: 201, json: { ok: true, username: "mira" } })
  })

  await page.goto("/react/apps/recipebot/members")
  await page.getByLabel("Username").fill("mi")
  await expect(page.getByRole("list", { name: "Invite suggestions" }).getByRole("button", { name: "@mira" })).toBeVisible()
  await page.getByRole("button", { name: "@mira" }).click()
  await page.getByRole("button", { name: "Send invite" }).click()

  await expect.poll(() => inviteRequest).toEqual({ method: "POST", body: { username: "mira" } })
  await expect(page.getByText("Invited @mira.")).toBeVisible()
  await expect(page.getByRole("list", { name: "RecipeBot collaborators" })).toContainText("@mira")
})

test("confirms the exact remove endpoint and refreshes the roster", async ({ page }) => {
  let rows = roster().collaborators
  let removeRequest: { method: string; url: string } | null = null
  await page.route("**/api/apps/recipebot/collaborators", (route) => route.fulfill({ json: roster(rows) }))
  await page.route("**/api/apps/recipebot/collaborators/12", async (route) => {
    removeRequest = { method: route.request().method(), url: route.request().url() }
    rows = rows.filter((member) => member.userId !== 12)
    await route.fulfill({ json: { ok: true } })
  })

  await page.goto("/react/apps/recipebot/members")
  await page.getByRole("button", { name: "Remove @lin" }).click()
  await expect(page.getByRole("alertdialog")).toContainText("Remove @lin?")
  await page.getByRole("button", { name: "Remove collaborator" }).click()

  await expect.poll(() => removeRequest).toMatchObject({ method: "DELETE", url: expect.stringContaining("/api/apps/recipebot/collaborators/12") })
  await expect(page.getByRole("list", { name: "RecipeBot collaborators" })).not.toContainText("@lin")
})

test("creates a visibility proposal without changing the current access policy locally", async ({ page }) => {
  let request: { method: string; body: unknown } | null = null
  await page.route("**/api/apps/recipebot/collaborators", (route) => route.fulfill({
    json: { ...roster(), viewVisibility: "private" },
  }))
  await page.route("**/api/apps/recipebot/visibility-pr", async (route) => {
    request = { method: route.request().method(), body: route.request().postDataJSON() }
    await route.fulfill({ status: 201, json: { ok: true, sessionId: 71, prNumber: 15 } })
  })

  await page.goto("/react/apps/recipebot/members")
  await expect(page.getByTestId("app-visibility-settings")).toContainText("Only accepted collaborators can build or open this app.")
  await page.getByRole("group", { name: "Who can build" }).getByRole("button", { name: "Anyone" }).click()
  await expect(page.getByTestId("app-visibility-settings")).toContainText("Anyone on the platform can build and open this app.")
  await page.getByRole("button", { name: "Propose visibility change" }).click()
  await expect(page.getByRole("alertdialog")).toContainText("The change applies only after the group approves it")
  await page.getByRole("alertdialog").getByRole("button", { name: "Open proposal" }).click()

  await expect.poll(() => request).toEqual({
    method: "POST",
    body: { collabVisibility: "public", viewVisibility: "public" },
  })
  await expect(page.getByTestId("app-visibility-settings")).toContainText("Visibility proposal created")
  await expect(page.getByRole("link", { name: "Open proposal" })).toHaveAttribute("href", "/react/apps/recipebot/dev/sessions/71")
  await expect(page.getByTestId("app-visibility-settings")).toContainText("Only accepted collaborators can build or open this app.")
})

test("continues an already-open visibility proposal returned by the server", async ({ page }) => {
  await page.route("**/api/apps/recipebot/collaborators", (route) => route.fulfill({
    json: { ...roster(), viewVisibility: "private" },
  }))
  await page.route("**/api/apps/recipebot/visibility-pr", (route) => route.fulfill({
    status: 409,
    json: { error: "A visibility change is already up for vote", sessionId: 64, prNumber: 12 },
  }))

  await page.goto("/react/apps/recipebot/members")
  await page.getByRole("group", { name: "Who can open the app" }).getByRole("button", { name: "Everyone" }).click()
  await page.getByRole("button", { name: "Propose visibility change" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Open proposal" }).click()

  await expect(page.getByTestId("app-visibility-settings")).toContainText("Visibility proposal already open")
  await expect(page.getByRole("link", { name: "Open proposal" })).toHaveAttribute("href", "/react/apps/recipebot/dev/sessions/64")
})

test("keeps visibility read-only for a collaborator without manage authority", async ({ page }) => {
  let writes = 0
  await page.unroute("**/api/apps/recipebot")
  await page.route("**/api/apps/recipebot", (route) => route.fulfill({
    json: { app: { ...app, can_manage: false } },
  }))
  await page.route("**/api/apps/recipebot/collaborators", (route) => route.fulfill({ json: roster() }))
  await page.route("**/api/apps/recipebot/visibility-pr", (route) => {
    writes += 1
    return route.fulfill({ status: 500 })
  })

  await page.goto("/react/apps/recipebot/members")
  await expect(page.getByTestId("app-visibility-settings")).toContainText("Only the app creator or an administrator")
  await expect(page.getByRole("group", { name: "Who can build" }).getByRole("button", { name: "Anyone" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Propose visibility change" })).toBeDisabled()
  expect(writes).toBe(0)
})

test("keeps private existence hidden for a non-disclosing collaborator 404", async ({ page }) => {
  await page.route("**/api/apps/recipebot/collaborators", (route) => route.fulfill({ status: 404, json: { error: "App not found" } }))
  await page.goto("/react/apps/recipebot/members")
  const members = page.getByTestId("app-members")
  await expect(page.getByTestId("members-not-found")).toContainText("This collaborators view is not available to this session.")
  await expect(page.getByTestId("members-not-found")).not.toContainText("RecipeBot")
  await expect(members.getByTestId("app-context-chrome")).toHaveCount(0)
  await expect(members.locator("h1")).toHaveCount(0)
})

test("makes a 403, empty roster, mobile layout, and accessibility explicit", async ({ page }) => {
  await page.route("**/api/apps/recipebot/collaborators", (route) => route.fulfill({ status: 403, json: { error: "Collaborator access is required" } }))
  await page.goto("/react/apps/recipebot/members")
  await expect(page.getByRole("alert")).toContainText("Collaborator access required")

  await page.unroute("**/api/apps/recipebot/collaborators")
  await page.route("**/api/apps/recipebot/collaborators", (route) => route.fulfill({ json: roster([]) }))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await expect(page.getByText("No collaborators yet")).toBeVisible()
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})

test("production review disables every collaborator mutation without requests", async ({ page }) => {
  test.skip(process.env.SV_PRODUCTION_READONLY !== "true", "This state is compiled only for the production-review profile.")
  let writes = 0
  await page.route("**/api/apps/recipebot/collaborators", (route) => route.fulfill({ json: roster() }))
  await page.route("**/api/apps/recipebot/invites", (route) => { writes += 1; return route.fulfill({ status: 500 }) })
  await page.route("**/api/apps/recipebot/collaborators/*", (route) => { writes += 1; return route.fulfill({ status: 500 }) })
  await page.route("**/api/apps/recipebot/visibility-pr", (route) => { writes += 1; return route.fulfill({ status: 500 }) })
  await page.goto("/react/apps/recipebot/members")
  await expect(page.getByTestId("members-production-review")).toContainText("Read-only")
  await expect(page.getByTestId("members-production-review")).toContainText("Invitations, collaborator changes, and visibility changes are unavailable.")
  await expect(page.getByRole("button", { name: "Send invite" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Remove @lin" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Propose visibility change" })).toBeDisabled()
  expect(writes).toBe(0)
})
