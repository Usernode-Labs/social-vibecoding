import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { isAdmin: true, canAdminWrite: true } } }))
  await page.route("**/api/admin/limits", (route) => route.fulfill({ json: { user_daily_limit_cents: 2500, global_daily_limit_cents: 20000, system_tokens_daily_limit_cents: 2500 } }))
})

test("shows the platform caps and allows only the established write-admin control", async ({ page }) => {
  await page.goto("/react/admin/limits")
  const route = page.getByTestId("spend-limits")
  await expect(route).not.toHaveClass(/(?:mx-auto|max-w-)/)
  await expect(page.getByRole("heading", { exact: true, level: 1, name: "Spend limits" })).toHaveCount(1)
  await expect(route).toContainText("$25.00")
  await expect(route).toContainText("$200.00")
  await expect(page.getByRole("button", { name: "Save limits" })).toBeEnabled()
})

test("saves all platform caps through the existing atomic endpoint", async ({ page }) => {
  let update: unknown = null
  await page.route("**/api/admin/limits", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback()
    update = route.request().postDataJSON()
    await route.fulfill({ json: { user_daily_limit_cents: 3000, global_daily_limit_cents: 30000, system_tokens_daily_limit_cents: 2800 } })
  })
  await page.goto("/react/admin/limits")
  await page.getByLabel("Default per-user daily cap").fill("3000")
  await page.getByLabel("Global daily cap").fill("30000")
  await page.getByLabel("System tokens daily cap").fill("2800")
  await page.getByRole("button", { name: "Save limits" }).click()
  await expect.poll(() => update).toEqual({ user: 3000, global: 30000, system: 2800 })
  await expect(page.getByTestId("spend-limits")).toContainText("$300.00")
})

test("keeps the server validation error visible", async ({ page }) => {
  await page.route("**/api/admin/limits", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback()
    await route.fulfill({ status: 400, json: { error: "global must be a non-negative integer (cents)" } })
  })
  await page.goto("/react/admin/limits")
  await page.getByLabel("Default per-user daily cap").fill("3000")
  await page.getByRole("button", { name: "Save limits" }).click()
  await expect(page.getByText("global must be a non-negative integer (cents)")).toBeVisible()
})

test("has no critical or serious accessibility violations", async ({ page }) => {
  await page.goto("/react/admin/limits")
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})
