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

test("keeps the inset page-card spatial model", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "The inset card margins apply from md up.")
  await page.goto("/react/")

  // The page is one contained card on the sidebar-colored plane. Dropping the
  // variant once silently flattened the whole model while every functional
  // gate stayed green.
  await expect(page.locator('[data-slot="sidebar"][data-variant="inset"]')).toHaveCount(1)
  const inset = page.locator('[data-slot="sidebar-inset"]')
  await expect.poll(() => inset.evaluate((node) => {
    const style = getComputedStyle(node)
    return Number.parseFloat(style.borderTopLeftRadius) > 0 && Number.parseFloat(style.marginTop) > 0
  })).toBe(true)
})

test("keeps the menu trigger compact and the header title visible", async ({ page }) => {
  await page.goto("/react/")

  const trigger = page.getByRole("button", { name: "Toggle navigation" })
  await expect(trigger).toBeVisible()
  const triggerBox = await trigger.boundingBox()
  expect(triggerBox).not.toBeNull()
  // The trigger is a compact control; a stretched trigger once consumed the
  // entire header row and collapsed the title to zero width.
  expect(triggerBox!.width).toBeLessThanOrEqual(64)

  const title = page.locator('[data-slot="platform-header"]').getByText("dApps")
  await expect(title).toBeVisible()
  const titleBox = await title.boundingBox()
  expect(titleBox).not.toBeNull()
  expect(titleBox!.width).toBeGreaterThan(24)
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
