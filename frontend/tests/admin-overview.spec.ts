import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

test("gates operations to administrators", async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ status: 403, json: { error: "Admin access required" } }))
  await page.goto("/react/admin")
  await expect(page.getByTestId("admin-overview")).toContainText("Admin access required")
})

test("renders the read-only operations snapshot and preserves legacy tools", async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { isAdmin: true, canAdminWrite: false, role: "view_admin" } } }))
  await page.route("**/api/admin/overview", (route) => route.fulfill({ json: {
    stuckApps: [{ slug: "recipebot", dbStatus: "creating", createdBy: "ava" }],
    orphanWorkers: [{ name: "worker-7", appSlug: "recipebot", uptimeSeconds: 3900 }],
    llmToday: { totalSpendCents: 1234, users: [{ username: "ava", costCents: 999 }] },
  } }))
  await page.goto("/react/admin")
  await expect(page.getByTestId("admin-overview")).toContainText("View-only administrator")
  await expect(page.getByTestId("admin-overview")).toContainText("recipebot")
  await expect(page.getByRole("link", { name: "Users" })).toHaveAttribute("href", "/react/admin/users")
  await expect(page.getByRole("link", { name: "Screenshot gallery" })).toHaveAttribute("href", "/react/admin/gallery")
})

test("exposes the operations route from the platform header only to admins", async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { isAdmin: true, canAdminWrite: true } } }))
  await page.route("**/api/apps", (route) => route.fulfill({ json: [] }))
  await page.goto("/react/")
  await expect(page.getByRole("link", { name: "Admin operations" })).toHaveAttribute("href", "/react/admin")
})

test("has no critical or serious accessibility violations", async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { isAdmin: true, canAdminWrite: true } } }))
  await page.route("**/api/admin/overview", (route) => route.fulfill({ json: { stuckApps: [], orphanWorkers: [], llmToday: { totalSpendCents: 0, users: [] } } }))
  await page.goto("/react/admin")
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})
