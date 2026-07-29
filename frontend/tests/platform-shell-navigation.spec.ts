import { expect, test } from "@playwright/test"

const apps = { apps: [] }

test.beforeEach(async ({ page }) => {
  await page.route("**/api/apps", (route) => route.fulfill({ json: apps }))
  await page.route("**/api/auth/me", (route) => route.fulfill({
    json: { user: { id: 7, username: "ava", isAdmin: true, canAdminWrite: true } },
  }))
  await page.route((url) => url.pathname === "/api/notifications", (route) => route.fulfill({
    json: { notifications: [], unread: 3, pendingInvites: [], hasMore: false, nextBefore: null },
  }))
  await page.route("**/api/node-status/full", (route) => route.fulfill({
    json: { node: { status: "Synced" } },
  }))
})

test("renders the accepted platform IA with one current destination", async ({ page }) => {
  await page.goto("/react/")

  const navigation = page.getByRole("navigation", { name: "Platform navigation" })
  const trigger = page.getByRole("button", { name: "Toggle navigation" })
  if (!await navigation.isVisible()) {
    await expect(trigger).toBeVisible()
    await trigger.click()
  }

  for (const label of ["Home", "Explore", "Work", "Challenges", "Activity", "Node", "Account", "Settings", "Send feedback", "Admin"]) {
    await expect(navigation.getByRole("link", { name: label })).toBeVisible()
  }
  await expect(navigation.locator("a[aria-current='page']")).toHaveCount(1)
  await expect(navigation.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page")
  await expect(navigation.locator('[aria-label="3 items need attention"]')).toContainText("3")
  await expect(navigation.getByRole("img", { name: "Node, synced" })).toBeVisible()
  await expect(page.getByRole("group", { name: "Color mode" })).toHaveCount(0)
})

test("closes the narrow sidebar through the official Sheet focus path", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Desktop keeps the platform sidebar expanded.")
  await page.goto("/react/")

  const trigger = page.getByRole("button", { name: "Toggle navigation" })
  await trigger.click()
  const dialog = page.getByRole("dialog", { name: "Sidebar" })
  await expect(dialog.getByRole("navigation", { name: "Platform navigation" })).toBeVisible()

  await dialog.press("Escape")
  await expect(page.getByRole("navigation", { name: "Platform navigation" })).toBeHidden()
  await expect(trigger).toBeFocused()
})
