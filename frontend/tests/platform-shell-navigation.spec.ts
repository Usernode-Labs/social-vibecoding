import { expect, test, type Locator, type Page } from "@playwright/test"

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

const stageApp = {
  id: "recipebot",
  slug: "recipebot",
  name: "RecipeBot",
  status: "running",
  tagline: "Find a recipe for what you have at home",
  description: null,
  active_users: 24,
  is_favorited: true,
  is_collaborator: true,
  your_apps_hidden: false,
  favorite_order: 0,
  open_prs: 0,
  active_sessions: 0,
  open_issues: 0,
  icon_url: null,
  can_collaborate: true,
  url: "https://recipebot.example.test",
}

async function visibleNavigationSurface(page: Page) {
  const navigation = page.getByRole("navigation", { name: "Platform navigation" })
  if (!await navigation.isVisible()) {
    await page.getByRole("button", { name: "Toggle navigation" }).click()
    await expect(navigation).toBeVisible()
  }
  const mobileSurface = navigation.locator("xpath=ancestor::*[@data-slot='sidebar'][@data-mobile='true'][1]")
  return await mobileSurface.count()
    ? mobileSurface
    : page.locator('[data-slot="sidebar-wrapper"]')
}

async function firstVisiblePainterOutsideCard(page: Page) {
  return page.locator('[data-slot="app-stage-boundary"]').evaluate((boundary) => {
    const paper = boundary.closest<HTMLElement>('[data-surface="paper"]')
    const card = boundary.querySelector<HTMLElement>('[data-slot="app-stage-card"]')
    const header = boundary.parentElement?.querySelector<HTMLElement>('[data-slot="top-bar"]')
    if (!paper || !card || !header) {
      return { mutationSlot: null, painterSlot: null, pointOutsideCard: false, sampled: false }
    }
    const boundaryStyle = getComputedStyle(boundary)
    const probe = document.createElement("div")
    boundary.append(probe)
    const unpaintedBackground = getComputedStyle(probe).backgroundColor
    probe.remove()
    const boundaryRectangle = boundary.getBoundingClientRect()
    const headerRectangle = header.getBoundingClientRect()
    const hasExposedBoundaryGutter = Number.parseFloat(boundaryStyle.paddingLeft) > 0
    const mutationTarget = hasExposedBoundaryGutter ? boundary : header
    const x = Math.floor(hasExposedBoundaryGutter ? boundaryRectangle.left + 1 : headerRectangle.left + 1)
    const y = Math.floor(hasExposedBoundaryGutter
      ? boundaryRectangle.top + boundaryRectangle.height / 2
      : headerRectangle.top + 1)
    const hit = document.elementFromPoint(x, y)
    let element = hit
    while (element instanceof HTMLElement) {
      const style = getComputedStyle(element)
      if (style.backgroundImage !== "none" || style.backgroundColor !== unpaintedBackground) {
        return {
          mutationSlot: mutationTarget.dataset.slot || null,
          painterSlot: element.dataset.surface || element.dataset.slot || element.tagName.toLowerCase(),
          pointOutsideCard: !card.contains(hit),
          sampled: true,
        }
      }
      if (element === paper) break
      element = element.parentElement
    }
    return {
      mutationSlot: mutationTarget.dataset.slot || null,
      painterSlot: null,
      pointOutsideCard: !card.contains(hit),
      sampled: true,
    }
  })
}

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
  const canvas = await visibleNavigationSurface(page)
  await expect(canvas).toHaveAttribute("data-surface", "canvas")
  await expect.poll(() => canvas.evaluate((node) => {
    const root = getComputedStyle(document.documentElement)
    const probe = document.createElement("span")
    probe.style.color = root.getPropertyValue("--background")
    document.body.append(probe)
    const expected = getComputedStyle(probe).color
    probe.remove()
    return getComputedStyle(node).backgroundColor === expected
  })).toBe(true)
})

test("keeps one inset Paper on the shell Canvas", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "The inset card margins apply from md up.")
  await page.goto("/react/")

  // The page is one Paper on the Canvas. Dropping the inset variant once
  // silently flattened the whole model while every functional gate stayed
  // green; omitting the semantic roles later made Card impersonate Paper.
  await expect(page.locator('[data-slot="sidebar"][data-variant="inset"]')).toHaveCount(1)
  const canvas = page.locator('[data-slot="sidebar-wrapper"]')
  const inset = page.locator('[data-slot="sidebar-inset"]')
  await expect(canvas).toHaveAttribute("data-surface", "canvas")
  await expect(inset).toHaveAttribute("data-surface", "paper")
  await expect(page.locator('[data-slot="route-viewport"]')).toHaveAttribute("data-surface", "print")
  await expect(page.locator('[data-surface="paper"]')).toHaveCount(1)
  await expect.poll(() => inset.evaluate((node) => {
    const style = getComputedStyle(node)
    return Number.parseFloat(style.borderTopLeftRadius) > 0 && Number.parseFloat(style.marginTop) > 0
  })).toBe(true)
  await expect.poll(async () => (
    await canvas.evaluate((node) => getComputedStyle(node).backgroundColor)
  ) !== (
    await inset.evaluate((node) => getComputedStyle(node).backgroundColor)
  )).toBe(true)
})

test("prints hosted app chrome and its distinct card on the shell Paper in both themes", async ({ page }) => {
  const shellReadyTimeout = 15_000
  await page.route("**/api/apps/recipebot", (route) => route.fulfill({ json: { app: stageApp } }))
  await page.route("**/api/iframe-token*", (route) => route.fulfill({ json: { token: "stage.header.signature" } }))
  await page.route("https://recipebot.example.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<main>RecipeBot child app</main>" }))

  for (const dark of [false, true]) {
    await page.goto("/react/")
    await page.locator("html").evaluate((node, nextDark) => node.classList.toggle("dark", nextDark), dark)
    const ordinaryCanvas = page.locator('[data-slot="sidebar-wrapper"]')
    const ordinaryCanvasBackground = await ordinaryCanvas.evaluate((node) => getComputedStyle(node).backgroundColor)
    const ordinaryPageBackground = await page.locator('[data-slot="sidebar-inset"]').evaluate((node) => getComputedStyle(node).backgroundColor)

    await page.goto("/react/apps/recipebot/open")
    await page.locator("html").evaluate((node, nextDark) => node.classList.toggle("dark", nextDark), dark)
    await expect(page.getByTestId("hosted-app")).toBeVisible({ timeout: shellReadyTimeout })
    expect(await page.locator('[data-slot="route-viewport"]').getAttribute("data-surface")).toBe("print")
    const paper = page.locator('[data-slot="sidebar-inset"]')
    const hostedStage = page.locator('[data-slot="hosted-app-stage"]')
    const hostedHeader = hostedStage.locator('[data-slot="top-bar"]')
    const hostedCard = hostedStage.locator('[data-slot="app-stage-card"]')
    await expect(page.locator('[data-surface="paper"]')).toHaveCount(1)
    await expect(hostedStage).toHaveAttribute("data-surface", "print")
    await expect.poll(() => paper.evaluate((node) => ({
      containsCard: node.contains(document.querySelector('[data-slot="app-stage-card"]')),
      containsHeader: node.contains(document.querySelector('[data-slot="top-bar"]')),
    }))).toEqual({ containsCard: true, containsHeader: true })
    const hostedCanvas = page.locator('[data-slot="sidebar-wrapper"]')
    const hostedCanvasBackground = await hostedCanvas.evaluate((node) => getComputedStyle(node).backgroundColor)
    const hostedPageBackground = await paper.evaluate((node) => getComputedStyle(node).backgroundColor)
    const hostedStageBackground = await hostedStage.evaluate((node) => getComputedStyle(node).backgroundColor)
    const hostedHeaderBackground = await hostedHeader.evaluate((node) => getComputedStyle(node).backgroundColor)
    const hostedCardBackground = await hostedCard.evaluate((node) => getComputedStyle(node).backgroundColor)
    const unpaintedBackground = await hostedStage.evaluate((node) => {
      const probe = document.createElement("div")
      node.append(probe)
      const background = getComputedStyle(probe).backgroundColor
      probe.remove()
      return background
    })

    expect(hostedCanvasBackground).toBe(ordinaryCanvasBackground)
    expect(hostedPageBackground).toBe(ordinaryPageBackground)
    expect(hostedStageBackground).toBe(unpaintedBackground)
    expect(hostedHeaderBackground).toBe(unpaintedBackground)
    expect(hostedCardBackground).not.toBe(hostedPageBackground)
    const visiblePaper = await firstVisiblePainterOutsideCard(page)
    expect(visiblePaper.sampled).toBe(true)
    expect(visiblePaper.pointOutsideCard).toBe(true)
    expect(visiblePaper.painterSlot).toBe("paper")
    expect(visiblePaper.mutationSlot).not.toBeNull()
    const mutationTarget = page.locator(`[data-slot="${visiblePaper.mutationSlot}"]`)
    await mutationTarget.evaluate((node, canvasPaint) => { node.style.backgroundColor = canvasPaint }, hostedCanvasBackground)
    expect((await firstVisiblePainterOutsideCard(page)).painterSlot).toBe(visiblePaper.mutationSlot)
    await mutationTarget.evaluate((node) => { node.style.removeProperty("background-color") })
    expect((await firstVisiblePainterOutsideCard(page)).painterSlot).toBe("paper")
  }
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
