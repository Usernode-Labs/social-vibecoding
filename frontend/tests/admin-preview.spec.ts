import { expect, test } from "@playwright/test"

const admin = {
  id: 7,
  username: "ava",
  isAdmin: true,
  canAdminWrite: true,
}

const recipeBot = {
  id: "recipebot",
  slug: "recipebot",
  name: "RecipeBot",
  status: "running",
  tagline: "Find a recipe for what you have",
  active_users: 24,
  is_favorited: true,
  is_collaborator: true,
  your_apps_hidden: false,
  favorite_order: 0,
  open_prs: 0,
  active_sessions: 0,
  open_issues: 0,
  self_hosted: false,
  view_visibility: "public",
  repo_url: "https://github.com/example/recipebot",
  can_manage: true,
  url: "https://recipebot.example.test",
}

async function expectPlatformAdminLink(page: import("@playwright/test").Page) {
  const navigation = page.getByRole("navigation", { name: "Platform navigation" })
  if (!await navigation.isVisible()) {
    await page.getByRole("button", { name: "Toggle navigation" }).click()
  }
  await expect(navigation.getByRole("link", { exact: true, name: "Admin" })).toHaveAttribute("href", "/react/admin")
  const dialog = page.getByRole("dialog", { name: "Sidebar" })
  if (await dialog.isVisible()) {
    await dialog.press("Escape")
  }
}

async function openDeveloperPreferences(page: import("@playwright/test").Page) {
  const disclosure = page.getByTestId("settings-developer-disclosure")
  if (await disclosure.getAttribute("open") === null) await disclosure.locator("summary").click()
  await expect(disclosure).toHaveAttribute("open", "")
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: admin } }))
  await page.route((url) => url.pathname === "/api/me/llm-grants", (route) => route.fulfill({ json: { grants: [] } }))
  await page.route((url) => url.pathname === "/api/me/agent-files", (route) => route.fulfill({
    json: { files: [], limits: { maxFilesPerKind: 10, maxFileBytes: 49152 } },
  }))
})

test("persists the administrator preview across routes and restores the full shell", async ({ page }) => {
  await page.goto("/react/settings")

  await openDeveloperPreferences(page)
  await expect(page.getByTestId("settings-admin-preview")).toBeVisible()
  await expectPlatformAdminLink(page)

  await page.getByRole("switch", { name: "View as non-admin" }).click()

  await expect(page.getByTestId("admin-preview-banner")).toBeVisible()
  await openDeveloperPreferences(page)
  await expect(page.getByRole("switch", { name: "View as non-admin" })).toBeChecked()
  await expect(page.getByRole("navigation", { name: "Platform navigation" }).getByRole("link", { exact: true, name: "Admin" })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => localStorage.getItem("viewAsNonAdmin"))).toBe("1")

  await page.getByRole("button", { name: "Switch back" }).click()

  await expect(page.getByTestId("admin-preview-banner")).toHaveCount(0)
  await openDeveloperPreferences(page)
  await expectPlatformAdminLink(page)
  await expect(page.getByRole("switch", { name: "View as non-admin" })).not.toBeChecked()
  await expect.poll(() => page.evaluate(() => localStorage.getItem("viewAsNonAdmin"))).toBeNull()
})

test("blocks direct administrator data reads while previewing", async ({ page }) => {
  let overviewRequests = 0
  await page.addInitScript(() => localStorage.setItem("viewAsNonAdmin", "1"))
  await page.route("**/api/admin/overview", (route) => {
    overviewRequests += 1
    return route.fulfill({
      json: { stuckApps: [], orphanWorkers: [], llmToday: { totalSpendCents: 0, users: [] } },
    })
  })

  await page.goto("/react/admin")

  await expect(page.getByTestId("admin-overview")).toContainText("Admin access required")
  await expect(page.getByTestId("admin-preview-banner")).toBeVisible()
  expect(overviewRequests).toBe(0)
})

test("hides app-level administrator actions while preserving regular app actions", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("viewAsNonAdmin", "1"))
  await page.route("**/api/apps/recipebot", (route) => route.fulfill({ json: { app: recipeBot } }))
  await page.route("**/api/public/apps/recipebot/contributors?include_wallets=0", (route) => route.fulfill({
    json: { contributors: [{ user_id: 7, username: "ava" }] },
  }))

  await page.goto("/react/apps/recipebot")

  await expect(page.getByText("Change approval")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Require an admin approval" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Remove from Your apps" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Open RecipeBot" })).toBeVisible()
})

test("does not offer administrator preview to regular users", async ({ page }) => {
  await page.unroute("**/api/auth/me")
  await page.route("**/api/auth/me", (route) => route.fulfill({
    json: { user: { id: 8, username: "lin", isAdmin: false, canAdminWrite: false } },
  }))

  await page.goto("/react/settings")

  await expect(page.getByTestId("settings-admin-preview")).toHaveCount(0)
  await expect(page.getByRole("switch", { name: "View as non-admin" })).toHaveCount(0)
})
