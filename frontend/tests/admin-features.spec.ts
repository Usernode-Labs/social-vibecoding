import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

const features = [
  { id: 71, title: "Share app templates", status: "open", app_name: "RecipeBot", app_slug: "recipebot", description: "Let members publish a reusable starter after an app is stable.", created_by_username: "ava", created_at: "2026-07-27T12:00:00Z", github_issue_number: 46, up_count: 28, down_count: 2 },
  { id: 72, title: "Offline recipe queue", status: "completed", app_name: "RecipeBot", app_slug: "recipebot", description: "Keep planned recipes visible while the host is unavailable.", created_by_username: "milo", created_at: "2026-07-22T12:00:00Z", up_count: 16, down_count: 1 },
]

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { isAdmin: true, canAdminWrite: true } } }))
  await page.route("**/api/admin/submitted-features**", (route) => route.fulfill({ json: { features, total: features.length, limit: 200, offset: 0 } }))
})

test("shows the server-ranked read-only feature feed and feature-request destination", async ({ page }) => {
  await page.goto("/react/admin/features")
  await expect(page.getByTestId("admin-features")).toContainText("#1")
  await expect(page.getByTestId("admin-features")).toContainText("Share app templates")
  await expect(page.getByTestId("admin-features")).toContainText("28 up · 2 down")
  await expect(page.getByRole("link", { name: "Open feature requests" })).toHaveAttribute("href", "/admin-features")
})

test("uses the existing status query to filter server-ranked requests", async ({ page }) => {
  const statuses: string[] = []
  await page.route("**/api/admin/submitted-features**", (route) => {
    statuses.push(new URL(route.request().url()).searchParams.get("status") || "")
    return route.fulfill({ json: { features: [features[1]], total: 1, limit: 200, offset: 0 } })
  })
  await page.goto("/react/admin/features")
  await page.getByRole("combobox", { name: "Feature status" }).click()
  await page.getByRole("option", { name: "Completed" }).click()
  await expect.poll(() => statuses).toContain("completed")
  await expect(page.getByTestId("admin-features")).toContainText("Offline recipe queue")
})

test("downloads all existing read-only result pages as a local CSV", async ({ page }) => {
  const offsets: string[] = []
  await page.route("**/api/admin/submitted-features**", (route) => {
    const url = new URL(route.request().url())
    const offset = url.searchParams.get("offset") || "0"
    offsets.push(offset)
    return route.fulfill({ json: offset === "0" ? { features: [features[0]], total: 2, limit: 200, offset: 0 } : { features: [features[1]], total: 2, limit: 200, offset: 1 } })
  })
  await page.goto("/react/admin/features")
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download CSV" }).click()])
  expect(download.suggestedFilename()).toBe("submitted-features-all.csv")
  await expect.poll(() => offsets).toEqual(expect.arrayContaining(["0", "1"]))
})

test("keeps the feed available to view-only administrators without write controls", async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { isAdmin: true, canAdminWrite: false } } }))
  await page.goto("/react/admin/features")
  await expect(page.getByRole("alert")).toContainText("View-only administrator")
  await expect(page.getByRole("button", { name: "Download CSV" })).toBeEnabled()
  await expect(page.getByTestId("admin-features")).not.toContainText("Moderate")
})

test("shows authorization and API failures without exposing the feed", async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { isAdmin: false } } }))
  await page.goto("/react/admin/features")
  await expect(page.getByRole("alert")).toContainText("Admin access required")
  await page.unroute("**/api/auth/me")
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { isAdmin: true, canAdminWrite: true } } }))
  await page.route("**/api/admin/submitted-features**", (route) => route.fulfill({ status: 500, json: { error: "feature index unavailable" } }))
  await page.reload()
  await expect(page.getByRole("alert")).toContainText("Submitted features unavailable")
  await expect(page.getByRole("alert")).toContainText("feature index unavailable")
})

test("remains legible on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/react/admin/features")
  await expect(page.getByRole("combobox", { name: "Feature status" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Download CSV" })).toBeVisible()
  await expect(page.getByTestId("admin-features")).toContainText("RecipeBot")
})

test("production review mode keeps the already read-only surface usable", async ({ page }) => {
  test.skip(process.env.SV_PRODUCTION_READONLY !== "true", "This state is compiled only for the production-review profile.")
  await page.goto("/react/admin/features")
  await expect(page.getByRole("alert")).toContainText("Read-only")
  await expect(page.getByRole("button", { name: "Download CSV" })).toBeEnabled()
})

test("has no critical or serious accessibility violations", async ({ page }) => {
  await page.goto("/react/admin/features")
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})
