import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

test.beforeEach(async ({ page }) => {
  await page.route("**/api/sessions/9", (route) => route.fulfill({ json: {
    session: { id: 9, app_slug: "recipebot", app_name: "RecipeBot", branch_name: "feature/pantry", session_title: "Improve pantry search", pr_title: null, status: "active", staging_url: "https://preview.example.test", testing_path: "/pantry", testing_md: "Search for a pantry staple and confirm its filter.", created_at: "2026-07-28T12:00:00.000Z" },
    messages: [],
  } }))
  await page.route("**/api/sessions/9/ensure-staging", (route) => route.fulfill({ json: { status: "ready", url: "https://preview.example.test" } }))
  await page.route("**/api/iframe-token", (route) => route.fulfill({ json: { token: "preview-token" } }))
  await page.route("https://preview.example.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>Preview</title><main>Preview ready</main>" }))
})

test("opens a server-authorized preview only after its secure host is reachable", async ({ page }) => {
  await page.goto("/react/apps/recipebot/dev/sessions/9/preview")
  await expect(page.getByTestId("staging-preview")).toBeVisible()
  await expect(page.getByTitle("Staging preview")).toHaveAttribute("src", /https:\/\/preview\.example\.test\/pantry\?token=preview-token/)
  await expect(page.getByRole("link", { name: "Session" })).toHaveAttribute("href", "/react/apps/recipebot/dev/sessions/9")
  await page.getByRole("button", { name: "How to test this change" }).click()
  await expect(page.getByText("Search for a pantry staple and confirm its filter.")).toBeVisible()
})

test("has no critical or serious accessibility violations", async ({ page }) => {
  await page.goto("/react/apps/recipebot/dev/sessions/9/preview")
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})
