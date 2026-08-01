import { expect, test, type Page } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

const users = [
  { id: 1, username: "ava", is_admin: true, apps_created: 5, app_quota: 3, cost_today_cents: 999, usernode_pubkey: "ut1verylongexamplewalletaddress00001", is_self: true },
  { id: 2, username: "milo", admin_readonly: true, is_admin: true, apps_created: 2, app_quota: 4, cost_today_cents: 235, daily_limit_cents: 2500 },
  { id: 3, username: "sam", apps_created: 1, app_quota: 3, cost_today_cents: 0, activation_code: "WELCOME-2026" },
]

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { isAdmin: true, canAdminWrite: true } } }))
  await page.route("**/api/admin/users", (route) => route.fulfill({ json: users }))
})

async function openAdminUsers(page: Page) {
  await page.goto("/react/admin/users")
  const route = page.getByTestId("admin-users")
  await expect(route).toContainText("ava (you)")
  await expect(page.getByRole("button", { name: "Save app quota for sam" })).toBeEnabled()
  await expect(page).toHaveURL(/\/react\/admin\/users$/)
  return route
}

test("shows user administration with its account-management destination", async ({ page }) => {
  const route = await openAdminUsers(page)
  await expect(route).not.toHaveClass(/(?:mx-auto|max-w-)/)
  await expect(page.getByRole("heading", { exact: true, level: 1, name: "Users" })).toHaveCount(1)
  await expect(route).toContainText("ava (you)")
  await expect(route).toContainText("View-only admin")
  const managementLink = page.getByRole("link", { name: "Manage accounts" })
  await expect(managementLink).toHaveAttribute("data-slot", "action-anchor")
  await expect(managementLink).toHaveAttribute("href", "/#admin/users")
})

test("updates an individual app quota through the existing write-admin contract", async ({ page }) => {
  let request: unknown = null
  await page.route("**/api/admin/users/3/app-quota", async (route) => {
    expect(route.request().method()).toBe("PUT")
    request = route.request().postDataJSON()
    await route.fulfill({ json: { ok: true, app_quota: 7 } })
  })
  await openAdminUsers(page)
  await page.getByRole("spinbutton", { name: "App quota for sam", exact: true }).fill("7")
  const response = page.waitForResponse((candidate) => candidate.url().endsWith("/api/admin/users/3/app-quota") && candidate.request().method() === "PUT")
  await page.getByRole("button", { name: "Save app quota for sam" }).click()
  await response
  await expect.poll(() => request).toEqual({ quota: 7 })
  await expect(page.getByTestId("admin-users")).toContainText("1 / 7")
})

test("updates and clears the per-user daily override through the existing contract", async ({ page }) => {
  const updates: unknown[] = []
  await page.route("**/api/admin/users/3/daily-limit", async (route) => {
    updates.push(route.request().postDataJSON())
    const cents = route.request().postDataJSON().cents as number | null
    await route.fulfill({ json: { ok: true, daily_limit_cents: cents } })
  })
  await openAdminUsers(page)
  const dailyCap = page.getByRole("textbox", { name: "Daily cap for sam", exact: true })
  await expect(dailyCap).toHaveValue("")
  await dailyCap.fill("12.00")
  const saveResponse = page.waitForResponse((candidate) => candidate.url().endsWith("/api/admin/users/3/daily-limit") && candidate.request().method() === "PUT")
  await page.getByRole("button", { name: "Save daily cap for sam" }).click()
  await saveResponse
  await expect.poll(() => updates).toEqual([{ cents: 1200 }])
  await expect(page.getByTestId("admin-users")).toContainText("$12.00")
  await expect(dailyCap).toHaveValue("12.00")
  await dailyCap.fill("")
  const clearResponse = page.waitForResponse((candidate) => candidate.url().endsWith("/api/admin/users/3/daily-limit") && candidate.request().method() === "PUT")
  await page.getByRole("button", { name: "Save daily cap for sam" }).click()
  await clearResponse
  await expect.poll(() => updates).toEqual([{ cents: 1200 }, { cents: null }])
  await expect(page.getByTestId("admin-users")).toContainText("Platform default")
})

test("keeps server mutation errors visible", async ({ page }) => {
  await page.route("**/api/admin/users/3/app-quota", (route) => route.fulfill({ status: 400, json: { error: "quota must be a non-negative integer" } }))
  await openAdminUsers(page)
  const response = page.waitForResponse((candidate) => candidate.url().endsWith("/api/admin/users/3/app-quota") && candidate.status() === 400)
  await page.getByRole("button", { name: "Save app quota for sam" }).click()
  await response
  await expect(page).toHaveURL(/\/react\/admin\/users$/)
  await expect(page.getByRole("alert")).toContainText("quota must be a non-negative integer")
})

test("view-only administrators cannot mutate individual limits", async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { isAdmin: true, canAdminWrite: false } } }))
  await page.goto("/react/admin/users")
  await expect(page.getByTestId("admin-users")).toContainText("ava (you)")
  await expect(page.getByRole("alert")).toContainText("View-only administrator")
  await expect(page.getByRole("button", { name: "Save app quota for sam" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Save daily cap for sam" })).toBeDisabled()
})

test("production review mode does not issue user mutations", async ({ page }) => {
  test.skip(process.env.SV_PRODUCTION_READONLY !== "true", "This state is compiled only for the production-review profile.")
  let mutations = 0
  await page.route("**/api/admin/users/**", async (route) => {
    if (route.request().method() !== "GET") mutations += 1
    await route.fallback()
  })
  await page.goto("/react/admin/users")
  await expect(page.getByTestId("admin-users")).toContainText("ava (you)")
  await expect(page.getByRole("alert")).toContainText("Changes unavailable")
  await expect(page.getByRole("button", { name: "Save app quota for sam" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Save daily cap for sam" })).toBeDisabled()
  expect(mutations).toBe(0)
})

test("filters the read-only list by user name", async ({ page }) => {
  await openAdminUsers(page)
  const filterRequests: string[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/admin/users") filterRequests.push(request.url())
  })
  const filter = page.getByRole("searchbox", { name: "Filter users", exact: true })
  await expect(filter).toHaveAttribute("placeholder", "Filter users")
  await filter.fill("milo")
  expect(await page.getByText("milo", { exact: true }).count()).toBe(1)
  await expect(page.getByTestId("admin-users")).toContainText("milo")
  await expect(page.getByTestId("admin-users")).not.toContainText("ava (you)")
  await filter.press("Enter")
  await expect(page).toHaveURL(/\/react\/admin\/users$/)
  await filter.fill("missing")
  await expect(page.getByText("No matching users", { exact: true })).toBeVisible()
  await expect(page.getByText("Try another name, or clear the filter.", { exact: true })).toBeVisible()
  await filter.fill("")
  await expect(page.getByTestId("admin-users")).toContainText("ava (you)")
  await expect(page.getByTestId("admin-users")).toContainText("milo")
  await page.waitForTimeout(300)
  expect(filterRequests).toEqual([])
})

test("has no critical or serious accessibility violations", async ({ page }) => {
  await openAdminUsers(page)
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})
