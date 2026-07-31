import { expect, test, type Locator } from "@playwright/test"

async function probeHitTarget(target: Locator) {
  return target.evaluate((element) => {
    const rectangle = element.getBoundingClientRect()
    const centerX = Math.floor(rectangle.left + rectangle.width / 2)
    const centerY = Math.floor(rectangle.top + rectangle.height / 2)
    const ownsPoint = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y)
      return hit === element || (hit ? element.contains(hit) : false)
    }
    const scan = (deltaX: number, deltaY: number) => {
      let distance = 0
      while (distance < 80 && ownsPoint(centerX + deltaX * (distance + 1), centerY + deltaY * (distance + 1))) {
        distance += 1
      }
      return distance
    }
    const left = scan(-1, 0)
    const right = scan(1, 0)
    const top = scan(0, -1)
    const bottom = scan(0, 1)
    return {
      effectiveBottom: centerY + bottom,
      effectiveHeight: top + bottom + 1,
      effectiveLeft: centerX - left,
      effectiveRight: centerX + right,
      effectiveTop: centerY - top,
      effectiveWidth: left + right + 1,
      visualHeight: rectangle.height,
      visualWidth: rectangle.width,
    }
  })
}

function hitTargetOverlap(
  first: Awaited<ReturnType<typeof probeHitTarget>>,
  second: Awaited<ReturnType<typeof probeHitTarget>>
) {
  const width = Math.max(
    0,
    Math.min(first.effectiveRight, second.effectiveRight)
      - Math.max(first.effectiveLeft, second.effectiveLeft)
      + 1
  )
  const height = Math.max(
    0,
    Math.min(first.effectiveBottom, second.effectiveBottom)
      - Math.max(first.effectiveTop, second.effectiveTop)
      + 1
  )
  return width * height
}

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

  const title = page.locator('[data-slot="top-bar"]').getByRole("heading", { level: 1, name: "Home" })
  await expect(title).toBeVisible()
  const titleBox = await title.boundingBox()
  expect(titleBox).not.toBeNull()
  expect(titleBox!.width).toBeGreaterThan(24)
})

test("gives the menu trigger and navigation rows honest coarse-pointer reach", async ({ page }) => {
  await page.goto("/react/")

  const coarsePointer = await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches)
  const trigger = page.getByRole("button", { name: "Toggle navigation" })
  const triggerTarget = await probeHitTarget(trigger)
  expect(triggerTarget.visualHeight).toBeLessThan(48)

  const navigation = page.getByRole("navigation", { name: "Platform navigation" })
  if (coarsePointer) {
    expect(triggerTarget.effectiveHeight).toBeGreaterThanOrEqual(48)
    expect(triggerTarget.effectiveWidth).toBeGreaterThanOrEqual(48)
    const triggerBox = await trigger.boundingBox()
    expect(triggerBox).not.toBeNull()
    await page.mouse.click(
      triggerBox!.x + triggerBox!.width / 2,
      triggerBox!.y - 4
    )
    await expect(navigation).toBeVisible()
  } else {
    expect(triggerTarget.effectiveHeight).toBeLessThan(48)
    expect(triggerTarget.effectiveWidth).toBeLessThan(48)
  }

  const rowLabels = [
    "Home",
    "Explore",
    "Work",
    "Challenges",
    "Activity",
    "Node",
    "Account",
    "Settings",
    "Send feedback",
    "Admin",
  ]
  const rowTargets = await Promise.all(
    rowLabels.map((label) => probeHitTarget(navigation.getByRole("link", { name: label })))
  )
  for (let index = 1; index < rowTargets.length; index += 1) {
    expect(hitTargetOverlap(rowTargets[index - 1], rowTargets[index])).toBe(0)
  }
  if (coarsePointer) {
    for (const target of rowTargets) {
      expect(target.effectiveHeight).toBeGreaterThanOrEqual(48)
    }
  } else {
    for (const target of rowTargets) {
      expect(target.effectiveHeight).toBeLessThan(48)
    }
  }

  await navigation.getByRole("link", { name: "Explore" }).click()
  await expect(page).toHaveURL(/\/react\/explore$/)
  if (coarsePointer) await expect(navigation).not.toBeVisible()
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
