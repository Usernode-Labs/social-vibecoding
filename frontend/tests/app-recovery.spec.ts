import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

const failedApp = {
  id: "pantry-pal", slug: "pantry-pal", name: "Pantry Pal", status: "error",
  tagline: "A helpful pantry assistant", active_users: 0, is_favorited: false,
  is_collaborator: true, your_apps_hidden: false, favorite_order: null,
  open_prs: 0, active_sessions: 0, open_issues: 0, can_manage: true,
  lastFailure: { reason: "The initial container could not start." },
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/apps/pantry-pal", (route) => route.fulfill({ json: { app: failedApp } }))
})

test("starts the existing failed-app retry and returns to the app detail route", async ({ page }) => {
  let retryRequests = 0
  await page.route("**/api/apps/pantry-pal/retry", async (route) => {
    expect(route.request().method()).toBe("POST")
    expect(route.request().postData()).toBeNull()
    retryRequests += 1
    await route.fulfill({ json: { ok: true } })
  })
  await page.goto("/react/apps/pantry-pal/recovery")
  const recovery = page.getByTestId("app-recovery")
  const chrome = recovery.locator('[data-slot="top-bar"]')
  await expect(recovery).toContainText("The initial container could not start.")
  await expect(chrome).toHaveAttribute("data-placement", "flow")
  await expect(page.locator("h1")).toHaveCount(1)
  await expect(recovery.getByRole("heading", { level: 1, name: "Pantry Pal · Repair app setup" })).toBeVisible()
  await expect.poll(() => recovery.evaluate((element) => getComputedStyle(element).maxWidth)).toBe("none")
  await page.getByRole("button", { name: "Retry setup" }).click()
  await expect(page).toHaveURL(/\/react\/apps\/pantry-pal$/)
  expect(retryRequests).toBe(1)
})

test("returns from setup repair through the explicit nested app context", async ({ page }) => {
  await page.goto("/react/apps/pantry-pal/recovery")
  const chrome = page.locator('[data-slot="top-bar"]')
  await expect(chrome.getByRole("button", { name: "Back" })).toBeVisible()
  await expect(chrome.getByRole("button", { name: "Close Pantry Pal" })).toHaveCount(0)
  await chrome.getByRole("button", { name: "Back" }).click()
  await expect(page).toHaveURL("/react/apps/pantry-pal")
})

test("does not invent app identity when recovery access fails", async ({ page }) => {
  await page.unroute("**/api/apps/pantry-pal")
  await page.route("**/api/apps/pantry-pal", (route) => route.fulfill({ status: 404, json: { error: "App not found" } }))
  await page.goto("/react/apps/pantry-pal/recovery")

  const recovery = page.getByTestId("app-recovery")
  await expect(recovery.getByRole("alert")).toContainText("App unavailable")
  await expect(page.locator('[data-slot="top-bar"]')).not.toContainText("Pantry Pal")
  await expect(page.locator("h1")).toHaveCount(1)
})

test("shows the server retry cap error and stays on the recovery route", async ({ page }) => {
  await page.route("**/api/apps/pantry-pal/retry", (route) => route.fulfill({ status: 429, json: { error: "Retry limit reached (3). Ask an admin to investigate." } }))
  await page.goto("/react/apps/pantry-pal/recovery")
  await page.getByRole("button", { name: "Retry setup" }).click()
  await expect(page.getByRole("alert").filter({ hasText: "Retry limit reached (3)" })).toBeVisible()
  await expect(page).toHaveURL(/\/react\/apps\/pantry-pal\/recovery$/)
})

test("does not expose a retry write to viewers without management access", async ({ page }) => {
  await page.route("**/api/apps/pantry-pal", (route) => route.fulfill({ json: { app: { ...failedApp, can_manage: false } } }))
  let writes = 0
  await page.route("**/api/apps/pantry-pal/retry", async (route) => {
    writes += 1
    await route.fallback()
  })
  await page.goto("/react/apps/pantry-pal/recovery")
  await expect(page.getByRole("alert").filter({ hasText: "Manager access required" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Retry setup" })).toBeDisabled()
  expect(writes).toBe(0)
})

test("does not offer retry for a healthy app", async ({ page }) => {
  await page.route("**/api/apps/pantry-pal", (route) => route.fulfill({ json: { app: { ...failedApp, status: "running", lastFailure: null } } }))
  await page.goto("/react/apps/pantry-pal/recovery")
  const recovery = page.getByTestId("app-recovery")
  await expect(recovery.getByText("This app does not need setup repair")).toBeVisible()
  await expect(recovery.getByRole("button", { name: "Retry setup" })).toHaveCount(0)
  await expect(recovery.getByRole("link", { name: "Back to app" })).toHaveCount(0)
  await recovery.locator('[data-slot="top-bar"]').getByRole("button", { name: "Back" }).click()
  await expect(page).toHaveURL("/react/apps/pantry-pal")
})

test("works at a narrow viewport and has no critical accessibility violations", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/react/apps/pantry-pal/recovery")
  await expect(page.getByRole("button", { name: "Retry setup" })).toBeVisible()
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})

test("production review mode disables retry without a mutation request", async ({ page }) => {
  test.skip(process.env.SV_PRODUCTION_READONLY !== "true", "This state is compiled only for the production-review profile.")
  let writes = 0
  await page.route("**/api/apps/pantry-pal/retry", async (route) => {
    writes += 1
    await route.fallback()
  })
  await page.goto("/react/apps/pantry-pal/recovery")
  await expect(page.getByTestId("app-recovery-production-review")).toContainText("Read-only")
  await expect(page.getByTestId("app-recovery-production-review")).toContainText("Setup retry is unavailable.")
  await expect(page.getByRole("button", { name: "Retry setup" })).toBeDisabled()
  expect(writes).toBe(0)
})
