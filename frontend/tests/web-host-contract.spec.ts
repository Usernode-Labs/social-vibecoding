import { expect, test, type Page } from "@playwright/test"

async function routeShellReads(page: Page) {
  await page.route("**/api/notifications?**", (route) => route.fulfill({
    json: { notifications: [], unread: 0, hasMore: false, nextBefore: null },
  }))
  await page.route("**/api/node-status/full", (route) => route.fulfill({
    json: { node: { status: "synced" } },
  }))
  await page.route("**/api/auth/me", (route) => route.fulfill({
    status: 403,
    json: { error: "Admin access required" },
  }))
}

test("keeps zoom accessible and assigns device insets to the shell", async ({ page }) => {
  await routeShellReads(page)
  await page.goto("/react/missing")

  const viewport = page.locator('meta[name="viewport"]')
  await expect(viewport).toHaveAttribute("content", /viewport-fit=cover/)
  await expect(viewport).toHaveAttribute("content", /interactive-widget=resizes-content/)
  await expect(viewport).not.toHaveAttribute("content", /maximum-scale/)
  await expect(viewport).not.toHaveAttribute("content", /user-scalable/)

  await page.evaluate(() => {
    const root = document.documentElement
    root.style.setProperty("--safe-area-top", "13px")
    root.style.setProperty("--safe-area-bottom", "17px")
    root.style.setProperty("--safe-area-left", "23px")
    root.style.setProperty("--safe-area-right", "29px")
  })

  const shellHeader = page.locator('[data-slot="sidebar-inset"] > header').first()
  await expect.poll(() => shellHeader.evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      paddingTop: style.paddingTop,
      paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight,
    }
  })).toEqual({ paddingTop: "13px", paddingLeft: "23px", paddingRight: "29px" })

  const route = page.getByTestId("not-found")
  const routeViewport = page.locator('[data-slot="route-viewport"]')
  const routeGutter = (page.viewportSize()?.width || 0) >= 640 ? 24 : 16
  await expect.poll(() => routeViewport.evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      bottom: style.paddingBottom,
      left: style.paddingLeft,
      right: style.paddingRight,
    }
  })).toEqual({
    bottom: "17px",
    left: `${Math.max(0, 23 - routeGutter)}px`,
    right: `${Math.max(0, 29 - routeGutter)}px`,
  })
  await expect.poll(() => route.evaluate((node) => {
    const routeStyle = getComputedStyle(node)
    const viewport = node.parentElement
    if (!viewport) return null
    const viewportStyle = getComputedStyle(viewport)
    return {
      left: Number.parseFloat(routeStyle.paddingLeft) + Number.parseFloat(viewportStyle.paddingLeft),
      right: Number.parseFloat(routeStyle.paddingRight) + Number.parseFloat(viewportStyle.paddingRight),
    }
  })).toEqual({ left: Math.max(23, routeGutter), right: Math.max(29, routeGutter) })

  const isMobile = (page.viewportSize()?.width || 0) < 768
  if (isMobile) {
    await page.getByRole("button", { name: "Toggle navigation" }).click()
  }
  const sidebar = isMobile
    ? page.locator('[data-slot="sidebar"][data-mobile="true"] > div:last-of-type')
    : page.locator('[data-slot="sidebar-inner"]').first()
  await expect.poll(() => sidebar.evaluate((node) => getComputedStyle(node).paddingBottom)).toBe("17px")
  await page.evaluate(() => {
    document.documentElement.dataset.keyboardVisible = "true"
  })
  await expect.poll(() => sidebar.evaluate((node) => getComputedStyle(node).paddingBottom)).toBe("0px")
  await expect.poll(() => routeViewport.evaluate((node) => getComputedStyle(node).paddingBottom)).toBe("0px")
})

test("keeps every sheet edge and close control inside active device insets", async ({ page }) => {
  await routeShellReads(page)
  await page.goto("/react/missing")
  await page.evaluate(() => {
    const root = document.documentElement
    root.style.setProperty("--safe-area-top", "31px")
    root.style.setProperty("--safe-area-bottom", "27px")
    root.style.setProperty("--safe-area-left", "23px")
    root.style.setProperty("--safe-area-right", "29px")
    for (const side of ["top", "right", "bottom", "left"]) {
      const sheet = document.createElement("div")
      sheet.dataset.slot = "sheet-content"
      sheet.dataset.side = side
      sheet.dataset.testid = `${side}-sheet`
      const close = document.createElement("button")
      close.dataset.slot = "sheet-close-control"
      close.dataset.testid = `${side}-sheet-close`
      sheet.append(close)
      document.body.append(sheet)
    }
  })

  const computed = async (testId: string) => page.getByTestId(testId).evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      bottom: style.paddingBottom,
      left: style.paddingLeft,
      right: style.paddingRight,
      top: style.paddingTop,
    }
  })
  await expect.poll(() => computed("right-sheet")).toEqual({
    bottom: "27px", left: "0px", right: "29px", top: "31px",
  })
  await expect.poll(() => computed("left-sheet")).toEqual({
    bottom: "27px", left: "23px", right: "0px", top: "31px",
  })
  await expect.poll(() => computed("bottom-sheet")).toEqual({
    bottom: "27px", left: "23px", right: "29px", top: "0px",
  })
  await expect.poll(() => computed("top-sheet")).toEqual({
    bottom: "0px", left: "23px", right: "29px", top: "31px",
  })
  await expect.poll(() => page.getByTestId("right-sheet-close").evaluate((node) => {
    const style = getComputedStyle(node)
    return { right: style.right, top: style.top }
  })).toEqual({ right: "29px", top: "31px" })

  await page.evaluate(() => {
    document.documentElement.dataset.keyboardVisible = "true"
  })
  await expect.poll(() => page.getByTestId("bottom-sheet").evaluate((node) =>
    getComputedStyle(node).paddingBottom
  )).toBe("0px")
})

test("derives keyboard visibility from the visual viewport contract", async ({ page }) => {
  await routeShellReads(page)
  await page.addInitScript(() => {
    class TestVisualViewport extends EventTarget {
      height = window.innerHeight
      offsetTop = 0
      scale = 1
    }
    const viewport = new TestVisualViewport()
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    })
    ;(window as Window & { __testVisualViewport?: TestVisualViewport }).__testVisualViewport = viewport
  })
  await page.goto("/react/missing")

  await expect(page.locator("html")).toHaveAttribute("data-keyboard-visible", "false")
  const coarsePointer = await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches)
  await page.evaluate(() => {
    const viewport = (window as Window & {
      __testVisualViewport?: { height: number; dispatchEvent: (event: Event) => boolean }
    }).__testVisualViewport
    if (!viewport) throw new Error("Missing test visual viewport")
    viewport.offsetTop = 20
    viewport.height = window.innerHeight - 180
    viewport.dispatchEvent(new Event("resize"))
  })
  await expect(page.locator("html")).toHaveAttribute(
    "data-keyboard-visible",
    coarsePointer ? "true" : "false",
  )
  await expect.poll(() => page.locator("html").evaluate((node) =>
    getComputedStyle(node).getPropertyValue("--keyboard-inset-height").trim()
  )).toBe(coarsePointer ? "160px" : "0px")

  await page.evaluate(() => {
    const viewport = (window as Window & {
      __testVisualViewport?: { height: number; scale: number; dispatchEvent: (event: Event) => boolean }
    }).__testVisualViewport
    if (!viewport) throw new Error("Missing test visual viewport")
    viewport.scale = 2
    viewport.dispatchEvent(new Event("resize"))
  })
  await expect(page.locator("html")).toHaveAttribute("data-keyboard-visible", "false")
  await expect.poll(() => page.locator("html").evaluate((node) =>
    getComputedStyle(node).getPropertyValue("--keyboard-inset-height").trim()
  )).toBe("0px")

  await page.evaluate(() => {
    const viewport = (window as Window & {
      __testVisualViewport?: { height: number; scale: number; dispatchEvent: (event: Event) => boolean }
    }).__testVisualViewport
    if (!viewport) throw new Error("Missing test visual viewport")
    viewport.scale = 1
    viewport.offsetTop = 0
    viewport.height = window.innerHeight - 40
    viewport.dispatchEvent(new Event("resize"))
  })
  await expect(page.locator("html")).toHaveAttribute("data-keyboard-visible", "false")

  await page.evaluate(() => {
    const viewport = (window as Window & {
      __testVisualViewport?: { height: number; offsetTop: number }
    }).__testVisualViewport
    if (!viewport) throw new Error("Missing test visual viewport")
    viewport.offsetTop = 12
    viewport.height = window.innerHeight - 172
    window.dispatchEvent(new Event("orientationchange"))
  })
  await expect(page.locator("html")).toHaveAttribute(
    "data-keyboard-visible",
    coarsePointer ? "true" : "false",
  )
  await expect.poll(() => page.locator("html").evaluate((node) =>
    getComputedStyle(node).getPropertyValue("--keyboard-inset-height").trim()
  )).toBe(coarsePointer ? "160px" : "0px")
})
