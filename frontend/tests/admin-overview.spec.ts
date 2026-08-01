import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

async function platformAdminLink(page: import("@playwright/test").Page) {
  const navigation = page.getByRole("navigation", { name: "Platform navigation" })
  if (!await navigation.isVisible()) {
    await page.getByRole("button", { name: "Toggle navigation" }).click()
  }
  return navigation.getByRole("link", { exact: true, name: "Admin" })
}

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
  const overview = page.getByTestId("admin-overview")
  await expect(overview).not.toHaveClass(/(?:mx-auto|max-w-)/)
  await expect(page.getByRole("heading", { exact: true, level: 1, name: "Operations" })).toHaveCount(1)
  await expect(overview).toContainText("View-only administrator")
  await expect(overview).toContainText("recipebot")
  const routerTools = [
    ["Users", "/react/admin/users"],
    ["Activation codes", "/react/admin/codes"],
    ["Spend limits", "/react/admin/limits"],
    ["Submitted features", "/react/admin/features"],
    ["Merge debug", "/react/admin/debug"],
    ["Screenshot gallery", "/react/admin/gallery"],
  ] as const
  for (const [name, href] of routerTools) {
    const link = page.getByRole("link", { exact: true, name })
    await expect(link).toHaveAttribute("data-slot", "action-link")
    await expect(link).toHaveAttribute("href", href)
  }

  const documentTools = [
    ["Analytics dashboard", "/dashboard"],
    ["Platform status", "/status"],
  ] as const
  for (const [name, href] of documentTools) {
    const link = page.getByRole("link", { exact: true, name })
    await expect(link).toHaveAttribute("data-slot", "action-anchor")
    await expect(link).toHaveAttribute("href", href)
    await expect(link).not.toHaveAttribute("target")
    await expect(link).not.toHaveAttribute("rel")
    await expect(link).not.toHaveAttribute("download")
  }
})

test("exposes the operations route from platform navigation only to admins", async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { isAdmin: true, canAdminWrite: true } } }))
  await page.route("**/api/apps", (route) => route.fulfill({ json: { apps: [] } }))
  await page.goto("/react/")
  await expect(await platformAdminLink(page)).toHaveAttribute("href", "/react/admin")
})

test("has no critical or serious accessibility violations", async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { isAdmin: true, canAdminWrite: true } } }))
  await page.route("**/api/admin/overview", (route) => route.fulfill({ json: { stuckApps: [], orphanWorkers: [], llmToday: { totalSpendCents: 0, users: [] } } }))
  await page.goto("/react/admin")
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})
