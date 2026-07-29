import { expect, test } from "@playwright/test"

import { expectAccessibleShellStructure } from "./accessibility"

async function platformNavigation(page: import("@playwright/test").Page) {
  const navigation = page.getByRole("navigation", { name: "Platform navigation" })
  if (!await navigation.isVisible()) {
    await page.getByRole("button", { name: "Toggle navigation" }).click()
  }
  await expect(navigation).toBeVisible()
  return navigation
}

test("turns an unmatched React deep link into a recoverable page", async ({ page }) => {
  await page.goto("/react/no-such-route")
  const route = page.getByTestId("not-found")
  await expect(route.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible()
  await expect(route.locator("h1")).toHaveCount(1)
  await expect.poll(() => route.evaluate((element) => getComputedStyle(element).maxWidth)).toBe("none")
  await expect(page.getByRole("link", { name: "Back to apps" })).toHaveCount(0)
  await expect(route.getByRole("link", { name: "Go to Home" })).toHaveAttribute("href", "/react")
  const navigation = await platformNavigation(page)
  await expect(navigation.getByRole("link", { name: "Home" })).toHaveAttribute("href", /\/react\/?$/)
})

test("has no critical or serious accessibility violations", async ({ page }) => {
  await page.goto("/react/no-such-route")
  await expectAccessibleShellStructure(page)
})
