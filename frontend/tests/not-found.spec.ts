import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

test("turns an unmatched React deep link into a recoverable page", async ({ page }) => {
  await page.goto("/react/no-such-route")
  await expect(page.getByTestId("not-found")).toContainText("Page not found")
  await expect(page.getByRole("link", { name: "Back to apps" })).toHaveAttribute("href", "/react")
})

test("has no critical or serious accessibility violations", async ({ page }) => {
  await page.goto("/react/no-such-route")
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})
