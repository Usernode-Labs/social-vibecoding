import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

const apps = {
  apps: [{
    id: "recipebot",
    slug: "recipebot",
    name: "RecipeBot",
    status: "running",
    tagline: "Find a recipe for what you have at home",
    active_users: 24,
    is_favorited: true,
    is_collaborator: true,
    your_apps_hidden: false,
    favorite_order: 0,
    open_prs: 0,
    active_sessions: 0,
    open_issues: 0,
    icon_url: null,
  }],
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: 7, username: "ava" } } }))
  await page.route("**/api/apps", (route) => route.fulfill({ json: apps }))
})

test("uses the OS preference on first boot and persists an explicit choice", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" })
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("theme-test-initialized")) return
    window.localStorage.removeItem("theme")
    window.sessionStorage.setItem("theme-test-initialized", "1")
  })
  await page.goto("/react/")

  await expect(page.locator("html")).toHaveClass(/dark/)
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")

  await page.goto("/react/settings")
  const switcher = page.getByTestId("settings-appearance").getByRole("group", { name: "Color mode" })
  await switcher.getByRole("button", { name: "Use light mode" }).click()

  await expect(page.locator("html")).not.toHaveClass(/dark/)
  await expect(page.locator("html")).toHaveClass(/light/)
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("theme"))).toBe("light")
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#ffffff")

  await page.reload()
  await expect(page.locator("html")).toHaveClass(/light/)
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light")
})

test("keeps the Settings control synchronized for explicit and System preferences", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("theme", "light"))
  await page.goto("/react/settings")

  const appearance = page.getByTestId("settings-appearance")
  const switchers = page.getByRole("group", { name: "Color mode" })
  await expect(switchers).toHaveCount(1)
  await appearance.getByRole("button", { name: "Use dark mode" }).click()

  await expect(page.locator("html")).toHaveClass(/dark/)
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark")
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#0a0a0a")
  await expect(appearance.getByRole("button", { name: "Use dark mode" })).toHaveAttribute("aria-pressed", "true")

  await appearance.getByRole("button", { name: /Use system mode/ }).click()
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("theme"))).toBe("system")
  await expect(appearance.getByRole("button", { name: /Use system mode/ })).toHaveAttribute("aria-pressed", "true")
})

for (const mode of ["light", "dark"] as const) {
  test(`has no serious accessibility violations on Home in ${mode} mode`, async ({ page }) => {
    await page.addInitScript((selectedMode) => window.localStorage.setItem("theme", selectedMode), mode)
    await page.goto("/react/")
    await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible()

    const results = await new AxeBuilder({ page }).analyze()
    expect(results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact || ""))).toEqual([])
  })
}
