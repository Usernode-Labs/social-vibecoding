import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

async function allowCreation(page: import("@playwright/test").Page) {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: 7, username: "ava", canCreateApps: true } } }))
}

test("creates a new app through the established server contract", async ({ page }) => {
  await allowCreation(page)
  let request: { method: string; body: unknown } | null = null
  await page.route("**/api/apps", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    request = { method: route.request().method(), body: route.request().postDataJSON() }
    await route.fulfill({ status: 201, json: { app: { slug: "pantry-pal-a1b2c3" } } })
  })

  await page.goto("/react/create")
  await page.getByLabel("App name").fill("Pantry Pal")
  await page.getByRole("radio", { name: /Invite-only/ }).click()
  await page.getByRole("radio", { name: /Members/ }).click()
  await page.getByRole("button", { name: "Create app" }).click()

  await expect.poll(() => request).toEqual({
    method: "POST",
    body: { name: "Pantry Pal", collabVisibility: "private", viewVisibility: "private" },
  })
  await expect(page).toHaveURL(/\/react\/apps\/pantry-pal-a1b2c3$/)
})

test("checks repository access before importing and uses the confirmed source", async ({ page }) => {
  await allowCreation(page)
  await page.route("**/api/github/verify-access?url=*", (route) => route.fulfill({ json: { ok: true, owner: "ava", repo: "recipes", name: "Recipe Book", description: "Saved meals", fullName: "ava/recipes" } }))
  let body: unknown = null
  await page.route("**/api/apps", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    body = route.request().postDataJSON()
    await route.fulfill({ status: 201, json: { app: { slug: "recipe-book-d4e5f6" } } })
  })

  await page.goto("/react/create")
  await page.getByRole("tab", { name: "Import existing" }).click()
  await page.getByLabel("GitHub repository URL").fill("https://github.com/ava/recipes")
  await page.getByRole("button", { name: "Check access" }).click()
  await expect(page.getByRole("status")).toContainText("ava/recipes")
  await expect(page.getByLabel("App name")).toHaveValue("Recipe Book — Saved meals")
  await page.getByRole("button", { name: "Import app" }).click()

  await expect.poll(() => body).toEqual({ name: "Recipe Book — Saved meals", repoUrl: "https://github.com/ava/recipes", collabVisibility: "public", viewVisibility: "public" })
  await expect(page).toHaveURL(/\/react\/apps\/recipe-book-d4e5f6$/)
})

test("surfaces preflight errors and never creates an unchecked imported app", async ({ page }) => {
  await allowCreation(page)
  let creations = 0
  await page.route("**/api/github/verify-access?url=*", (route) => route.fulfill({ status: 403, json: { error: "Invite usernode-bot with Write access first." } }))
  await page.route("**/api/apps", async (route) => {
    if (route.request().method() === "POST") creations += 1
    await route.fallback()
  })

  await page.goto("/react/create")
  await page.getByRole("tab", { name: "Import existing" }).click()
  await page.getByLabel("GitHub repository URL").fill("https://github.com/ava/recipes")
  await page.getByRole("button", { name: "Check access" }).click()
  await expect(page.getByRole("alert").filter({ hasText: "Invite usernode-bot with Write access first." })).toBeVisible()
  await expect(page.getByLabel("App name")).toBeDisabled()
  expect(creations).toBe(0)
})

test("shows the server creation error without changing routes", async ({ page }) => {
  await allowCreation(page)
  await page.route("**/api/apps", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    await route.fulfill({ status: 403, json: { error: "You’ve reached your app limit (3)." } })
  })

  await page.goto("/react/create")
  await page.getByLabel("App name").fill("One too many")
  await page.getByRole("button", { name: "Create app" }).click()
  await expect(page.getByRole("alert").filter({ hasText: "You’ve reached your app limit (3)." })).toBeVisible()
  await expect(page).toHaveURL(/\/react\/create$/)
})

test("does not expose a creation write for an account without an available slot", async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: 7, username: "ava", canCreateApps: false } } }))
  let writes = 0
  await page.route("**/api/apps", async (route) => {
    if (route.request().method() !== "GET") writes += 1
    await route.fallback()
  })
  await page.goto("/react/create")
  await expect(page.getByRole("alert").filter({ hasText: "App creation unavailable" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Create app" })).toBeDisabled()
  expect(writes).toBe(0)
})

test("is usable at a narrow mobile viewport and has no critical accessibility violations", async ({ page }) => {
  await allowCreation(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/react/create")
  await expect(page.getByRole("tab", { name: "Create new" })).toBeVisible()
  await expect(page.getByRole("radio", { name: /Invite-only/ })).toBeVisible()
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})

test("production review mode disables app creation without a mutation request", async ({ page }) => {
  test.skip(process.env.SV_PRODUCTION_READONLY !== "true", "This state is compiled only for the production-review profile.")
  await allowCreation(page)
  let writes = 0
  await page.route("**/api/apps", async (route) => {
    if (route.request().method() !== "GET") writes += 1
    await route.fallback()
  })
  await page.goto("/react/create")
  await expect(page.getByRole("alert").filter({ hasText: "Production review mode" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Create app" })).toBeDisabled()
  expect(writes).toBe(0)
})
