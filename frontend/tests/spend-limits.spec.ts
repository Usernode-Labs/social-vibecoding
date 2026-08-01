import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

import { formatUsdInput, parseUsdInput } from "../@/lib/currency-input"

const limits = {
  user_daily_limit_cents: 2_500,
  global_daily_limit_cents: 20_000,
  system_tokens_daily_limit_cents: 2_500,
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { isAdmin: true, canAdminWrite: true } } }))
  await page.route("**/api/admin/limits", (route) => route.fulfill({ json: limits }))
})

test("converts display currency to exact integer cents without floating-point rounding", () => {
  expect(formatUsdInput(2_505)).toBe("25.05")
  expect(parseUsdInput("25")).toBe(2_500)
  expect(parseUsdInput("25.5")).toBe(2_550)
  expect(parseUsdInput("25.05")).toBe(2_505)
  expect(parseUsdInput(".50")).toBe(50)
  expect(parseUsdInput("25.005")).toBeNull()
  expect(parseUsdInput("-1.00")).toBeNull()
  expect(parseUsdInput("$25.00")).toBeNull()
})

test("shows confirmed platform caps and presents every edit field as currency", async ({ page }) => {
  await page.goto("/react/admin/limits")
  const route = page.getByTestId("spend-limits")
  await expect(route).not.toHaveClass(/(?:mx-auto|max-w-)/)
  await expect(page.getByRole("heading", { exact: true, level: 1, name: "Spend limits" })).toHaveCount(1)
  await expect(page.getByRole("heading", { exact: true, level: 2, name: "Current limits" })).toBeVisible()
  await expect(route).toContainText("$25.00")
  await expect(route).toContainText("$200.00")
  await expect(page.getByLabel("Default per-user daily cap")).toHaveValue("25.00")
  await expect(page.getByLabel("Global daily cap")).toHaveValue("200.00")
  await expect(page.getByLabel("System tokens daily cap")).toHaveValue("25.00")
  await expect(page.getByText("Whole cents.")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Save limits" })).toBeEnabled()
})

test("saves entered currency through the existing atomic cents contract", async ({ page }) => {
  let update: unknown = null
  await page.route("**/api/admin/limits", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback()
    update = route.request().postDataJSON()
    await route.fulfill({ json: { user_daily_limit_cents: 3_000, global_daily_limit_cents: 30_000, system_tokens_daily_limit_cents: 2_800 } })
  })
  await page.goto("/react/admin/limits")
  await page.getByLabel("Default per-user daily cap").fill("30.00")
  await page.getByLabel("Global daily cap").fill("300.00")
  await page.getByLabel("System tokens daily cap").fill("28.00")
  await page.getByRole("button", { name: "Save limits" }).click()
  await expect.poll(() => update).toEqual({ user: 3_000, global: 30_000, system: 2_800 })
  await expect(page.getByRole("status")).toContainText("Limits saved")
  await expect(page.getByTestId("spend-limits")).toContainText("$300.00")
})

test("keeps local currency validation beside every responsible field", async ({ page }) => {
  let mutations = 0
  await page.route("**/api/admin/limits", async (route) => {
    if (route.request().method() === "PUT") mutations += 1
    await route.fallback()
  })
  await page.goto("/react/admin/limits")
  await page.getByLabel("Default per-user daily cap").fill("25.005")
  await page.getByLabel("System tokens daily cap").fill("-1")
  await page.getByRole("button", { name: "Save limits" }).click()
  const errors = page.getByText("Enter a non-negative dollar amount with no more than two decimal places.")
  await expect(errors).toHaveCount(2)
  expect(mutations).toBe(0)
})

test("moves an attributable server rejection to its currency field", async ({ page }) => {
  await page.route("**/api/admin/limits", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback()
    await route.fulfill({ status: 400, json: { error: "global must be a non-negative integer (cents)" } })
  })
  await page.goto("/react/admin/limits")
  await page.getByLabel("Global daily cap").fill("300.00")
  await page.getByRole("button", { name: "Save limits" }).click()
  const globalField = page.locator('[data-slot="field"]').filter({ has: page.getByLabel("Global daily cap") })
  await expect(globalField).toContainText("The server rejected this dollar amount")
  await expect(page.getByText("global must be a non-negative integer (cents)")).toHaveCount(0)
})

test("keeps an unknown persistence failure with the form and preserves confirmed values", async ({ page }) => {
  await page.route("**/api/admin/limits", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback()
    await route.fulfill({ status: 503, json: { error: "Limit service is unavailable." } })
  })
  await page.goto("/react/admin/limits")
  await page.getByLabel("Global daily cap").fill("300.00")
  await page.getByRole("button", { name: "Save limits" }).click()
  const alert = page.getByRole("alert").filter({ hasText: "Limits were not saved" })
  await expect(alert).toContainText("Your entries remain in the form")
  await expect(alert).toContainText("last confirmed server values")
  await expect(page.getByLabel("Global daily cap")).toHaveValue("300.00")
  await expect(page.getByRole("region", { name: "Current limits" })).toContainText("$200.00")
})

test("retries a failed limits read without navigation", async ({ page }) => {
  let reads = 0
  await page.route("**/api/admin/limits", async (route) => {
    reads += 1
    if (reads === 1) return route.fulfill({ status: 503, json: { error: "Limits temporarily unavailable" } })
    await route.fulfill({ json: limits })
  })
  await page.goto("/react/admin/limits")
  await expect(page.getByRole("alert")).toContainText("Limits temporarily unavailable")
  await page.getByRole("button", { name: "Retry" }).click()
  await expect(page.getByRole("heading", { level: 2, name: "Current limits" })).toBeVisible()
  await expect(page).toHaveURL(/\/react\/admin\/limits$/)
  expect(reads).toBe(2)
})

test("production review mode keeps currency visible and issues no mutation", async ({ page }) => {
  test.skip(process.env.SV_PRODUCTION_READONLY !== "true", "This state is compiled only for the production-review profile.")
  let mutations = 0
  await page.route("**/api/admin/limits", async (route) => {
    if (route.request().method() === "PUT") mutations += 1
    await route.fallback()
  })
  await page.goto("/react/admin/limits")
  await expect(page.getByRole("alert")).toContainText("Changes unavailable")
  await expect(page.getByLabel("Default per-user daily cap")).toHaveValue("25.00")
  await expect(page.getByLabel("Default per-user daily cap")).toBeDisabled()
  await expect(page.getByRole("button", { name: "Save limits" })).toBeDisabled()
  expect(mutations).toBe(0)
})

test("keeps the currency form usable without horizontal overflow on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 })
  await page.goto("/react/admin/limits")
  const route = page.getByTestId("spend-limits")
  await expect(page.getByLabel("Default per-user daily cap")).toBeVisible()
  await expect(page.getByRole("button", { name: "Save limits" })).toBeVisible()
  expect(await route.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
})

test("has no critical or serious accessibility violations", async ({ page }) => {
  await page.goto("/react/admin/limits")
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})
