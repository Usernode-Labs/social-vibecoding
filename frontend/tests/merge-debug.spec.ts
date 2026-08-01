import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

const run = { id: 5, app_name: "RecipeBot", app_slug: "recipebot", pr_number: 48, pr_title: "Improve search", kind: "merge", status: "merged", step_count: 2, started_at: "2026-07-27T12:00:00Z", ended_at: "2026-07-27T12:01:00Z" }
test.beforeEach(async ({ page }) => { await page.route("**/api/auth/me", (r) => r.fulfill({ json: { user: { isAdmin: true, canAdminWrite: false } } })); await page.route("**/api/debug/apps", (r) => r.fulfill({ json: { apps: [{ id: 1, slug: "recipebot", name: "RecipeBot", run_count: 1 }] } })); await page.route("**/api/debug/merge-runs**", (r) => r.fulfill({ json: { runs: [run], hasMore: false, nextCursor: null } })); await page.route("**/api/debug/merge-runs/5", (r) => r.fulfill({ json: { run, steps: [{ id: 1, run_id: 5, seq: 0, phase: "gate:checks", level: "info", message: "Checks passed.", detail: { checkState: "passing" }, created_at: "2026-07-27T12:00:02Z" }] } })) })
test("renders any-admin read-only diagnostics and expands an ordered trace", async ({ page }) => { await page.goto("/react/admin/debug"); const route = page.getByTestId("merge-debug"); await expect(route).not.toHaveClass(/(?:mx-auto|max-w-)/); await expect(page.getByRole("heading", { exact: true, level: 1, name: "Merge debug" })).toHaveCount(1); await expect(route).toContainText("RecipeBot · PR #48"); await page.getByRole("button", { name: "View trace" }).click(); await expect(route).toContainText("Checks passed."); await expect(page.getByRole("link", { name: "Open debug tools" })).toHaveAttribute("href", "/debug") })
test("composes and submits the five governed diagnostic fields", async ({ page }) => {
  const queries: string[] = []
  await page.route("**/api/debug/merge-runs**", (route) => {
    queries.push(route.request().url())
    return route.fulfill({ json: { runs: [run], hasMore: false, nextCursor: null } })
  })
  await page.goto("/react/admin/debug")

  const filters = page.getByRole("region", { name: "Merge diagnostic filters" })
  const fieldGroup = filters.locator('[data-slot="field-group"]')
  const fields = fieldGroup.locator(':scope > [data-slot="field"]')
  await expect(fieldGroup).toHaveCount(1)
  await expect(fields).toHaveCount(5)
  const expectedColumns = (page.viewportSize()?.width ?? 0) >= 1024 ? 5 : 1
  expect(await fieldGroup.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(expectedColumns)

  const controls = [
    ["App", "merge-debug-app"],
    ["PR #", "merge-debug-pr-number"],
    ["Session id", "merge-debug-session-id"],
    ["Outcome", "merge-debug-outcome"],
    ["Kind", "merge-debug-kind"],
  ] as const
  for (const [index, [label, id]] of controls.entries()) {
    await expect(fields.nth(index).locator('[data-slot="field-label"]')).toHaveText(label)
    await expect(fields.nth(index).locator('[data-slot="field-label"]')).toHaveAttribute("for", id)
    await expect(fields.nth(index).locator(`#${id}`)).toHaveCount(1)
  }

  await page.getByLabel("Debug app").click()
  await expect(page.locator('[data-slot="select-content"]:visible [data-slot="select-group"]')).toHaveCount(1)
  await page.getByRole("option", { name: "RecipeBot" }).click()
  await page.getByLabel("PR number").fill("48")
  await page.getByLabel("Session id").fill("23")
  await page.getByLabel("Outcome").click()
  await expect(page.locator('[data-slot="select-content"]:visible [data-slot="select-group"]')).toHaveCount(1)
  await page.getByRole("option", { name: "merged" }).click()
  await page.getByLabel("Run kind").click()
  await expect(page.locator('[data-slot="select-content"]:visible [data-slot="select-group"]')).toHaveCount(1)
  await page.getByRole("option", { name: "Conflict resolution" }).click()

  await expect.poll(() => queries.some((url) => {
    const params = new URL(url).searchParams
    return params.get("app") === "recipebot"
      && params.get("pr_number") === "48"
      && params.get("session_id") === "23"
      && params.get("outcome") === "merged"
      && params.get("kind") === "conflict_resolution"
  })).toBe(true)
})
test("retains server filter parameters and denies non-admins", async ({ page }) => { const queries: string[] = []; await page.route("**/api/debug/merge-runs**", (r) => { queries.push(r.request().url()); return r.fulfill({ json: { runs: [run], hasMore: false, nextCursor: null } }) }); await page.goto("/react/admin/debug"); await page.getByLabel("PR number").fill("48"); await expect.poll(() => queries.some((url) => new URL(url).searchParams.get("pr_number") === "48")).toBe(true); await page.unroute("**/api/auth/me"); await page.route("**/api/auth/me", (r) => r.fulfill({ json: { user: { isAdmin: false } } })); await page.reload(); await expect(page.getByRole("alert")).toContainText("Admin access required") })
test("has one-column fields and no critical or serious accessibility violations on mobile", async ({ page }) => { await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/react/admin/debug"); const fieldGroup = page.getByRole("region", { name: "Merge diagnostic filters" }).locator('[data-slot="field-group"]'); expect(await fieldGroup.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(1); const results = await new AxeBuilder({ page }).analyze(); expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([]) })
