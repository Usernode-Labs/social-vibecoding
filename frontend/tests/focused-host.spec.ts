import { expect, test } from "@playwright/test"

const app = {
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

let appRequests = 0
let tokenRequests = 0
let hostedDocumentRequests = 0

test.beforeEach(async ({ page }) => {
  appRequests = 0
  tokenRequests = 0
  hostedDocumentRequests = 0

  await page.addInitScript(() => {
    ;(window as Window & { Usernode?: { postMessage: (message: string) => void } }).Usernode = {
      postMessage(message) {
        sessionStorage.setItem("focused-host-native-message", message)
      },
    }
  })

  await page.route("**/api/auth/me", (route) => route.fulfill({
    json: { user: { id: 7, username: "ava", canAdminWrite: false } },
  }))
  await page.route("**/api/notifications?*", (route) => route.fulfill({
    json: { notifications: [], unread: 0, hasMore: false, nextBefore: null },
  }))
  await page.route("**/api/node-status/full", (route) => route.fulfill({
    json: { node: { status: "synced" } },
  }))
  await page.route("**/api/apps/recipebot", (route) => {
    appRequests += 1
    return route.fulfill({ json: { app } })
  })
  await page.route("**/api/iframe-token*", (route) => {
    tokenRequests += 1
    if (new URL(route.request().url()).searchParams.get("app") !== app.slug) {
      return route.fulfill({ status: 400, json: { error: "app query parameter is required" } })
    }
    return route.fulfill({ json: { token: "focused.header.signature" } })
  })
  await page.route("https://recipebot.example.test/**", (route) => {
    if (route.request().resourceType() === "document") hostedDocumentRequests += 1
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <title>RecipeBot</title>
        <main>RecipeBot child app</main>
        <script>window.__focusedHostMount = Math.random().toString(36)</script>`,
    })
  })
})

test("the focused app owns a single bar: platform header yields to chrome", async ({ page }) => {
  await page.goto("/react/apps/recipebot/open")

  await expect(page.locator('[data-slot="top-bar"]')).toHaveCount(1)
  const chrome = page.locator('[data-slot="top-bar"]')
  await expect(chrome.getByRole("button", { name: "Toggle navigation" })).toBeVisible()
  await expect(chrome.getByRole("button", { name: "Close RecipeBot" })).toBeVisible()
})

test("composes focused chrome with the exact iframe and native-title contracts", async ({ page }) => {
  await page.goto("/react/apps/recipebot/open?path=/recipes?query=tomato")

  await expect(page.getByRole("heading", { name: "RecipeBot", exact: true })).toHaveCount(1)
  await expect(page.getByRole("button", { name: "Improve" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Use" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Close RecipeBot" })).toBeVisible()

  const frame = page.getByTestId("focused-app-frame")
  await expect(frame).toBeVisible()
  await expect(frame).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-forms allow-same-origin allow-popups allow-pointer-lock",
  )
  await expect(frame).toHaveAttribute("allow", "clipboard-write; pointer-lock")
  await expect(frame).toHaveAttribute(
    "src",
    "https://recipebot.example.test/recipes?query=tomato&token=focused.header.signature",
  )
  await expect(page).toHaveTitle("RecipeBot")
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("focused-host-native-message"))).toBe(
    JSON.stringify({ method: "titleChanged", value: "RecipeBot" }),
  )
})

test("falls back to the app root for an unsafe direct path", async ({ page }) => {
  await page.goto("/react/apps/recipebot/open?path=//untrusted.example.test")

  await expect(page.getByTestId("focused-app-frame")).toHaveAttribute(
    "src",
    "https://recipebot.example.test/?token=focused.header.signature",
  )
})

test("keeps one offline recovery action and reloads the focused route", async ({ page }) => {
  await page.goto("/react/apps/recipebot/open")
  await expect(page.getByTestId("focused-app-frame")).toBeVisible()
  const settledAppRequests = appRequests

  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("usernode:offline-change", { detail: { offline: true } }))
  })

  await expect(page.locator('[data-slot="focused-app-surface"][data-state="offline"]')).toBeVisible()
  const card = page.locator('[data-slot="app-stage-card"]')
  await expect.poll(() => card.evaluate((node) => {
    const style = getComputedStyle(node)
    return { bottom: style.paddingBottom, left: style.paddingLeft, right: style.paddingRight, top: style.paddingTop }
  })).toEqual({ bottom: "24px", left: "24px", right: "24px", top: "24px" })
  await expect(page.getByTestId("focused-app-frame")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(1)
  await page.getByRole("button", { name: "Retry" }).click()

  await expect.poll(() => appRequests).toBeGreaterThan(settledAppRequests)
  await expect(page.getByTestId("focused-app-frame")).toBeVisible()
})

test("refreshes the iframe token on cadence without reloading an unchanged source", async ({ page }) => {
  await page.clock.install()
  await page.goto("/react/apps/recipebot/open")
  await expect(page.locator('[data-slot="focused-app-surface"][data-state="ready"]')).toBeVisible()

  const settledTokenRequests = tokenRequests
  const settledDocumentRequests = hostedDocumentRequests
  const child = page.frames().find((frame) => frame.url().startsWith("https://recipebot.example.test/"))
  if (!child) throw new Error("RecipeBot child frame did not load")
  const mount = await child.evaluate(() =>
    (window as Window & { __focusedHostMount?: string }).__focusedHostMount
  )

  await page.clock.fastForward(45 * 60 * 1000)

  await expect.poll(() => tokenRequests).toBeGreaterThan(settledTokenRequests)
  expect(hostedDocumentRequests).toBe(settledDocumentRequests)
  await expect(child.locator("main")).toHaveText("RecipeBot child app")
  expect(await child.evaluate(() =>
    (window as Window & { __focusedHostMount?: string }).__focusedHostMount
  )).toBe(mount)
})

test("routes Improve and Close with their accepted focused-app meanings", async ({ page }) => {
  await page.goto("/react/apps/recipebot/open")
  await page.getByRole("button", { name: "Improve" }).click()
  await expect(page).toHaveURL(/\/react\/apps\/recipebot\/dev$/)

  await page.goto("/react/apps/recipebot/open")
  await page.getByRole("button", { name: "Close RecipeBot" }).click()
  await expect(page).toHaveURL(/\/react\/?$/)
})

test("keeps the flow header and app card inside one web-owned safe area", async ({ page }, testInfo) => {
  await page.goto("/react/apps/recipebot/open")
  const routeViewport = page.locator('[data-slot="route-viewport"]')
  const host = page.locator('[data-slot="hosted-app-stage"][data-state="ready"]')
  const card = page.locator('[data-slot="app-stage-card"][data-state="ready"]')
  const focused = page.locator('[data-slot="focused-app-surface"][data-state="ready"]')
  const chrome = page.locator('[data-slot="top-bar"][data-placement="flow"]')
  await expect(focused).toBeVisible()
  await page.evaluate(() => {
    const root = document.documentElement
    root.style.setProperty("--safe-area-bottom", "19px")
    root.style.setProperty("--safe-area-left", "21px")
    root.style.setProperty("--safe-area-right", "25px")
  })

  await expect(chrome).toBeVisible()
  await expect.poll(() => routeViewport.evaluate((node) => {
    const style = getComputedStyle(node)
    return { bottom: style.paddingBottom, left: style.paddingLeft, right: style.paddingRight }
  })).toEqual({ bottom: "0px", left: "0px", right: "0px" })
  await expect.poll(() => host.evaluate((node) => {
    const style = getComputedStyle(node)
    return { bottom: style.paddingBottom, left: style.paddingLeft, right: style.paddingRight, top: style.paddingTop }
  })).toEqual({ bottom: "0px", left: "0px", right: "0px", top: "0px" })
  await expect.poll(() => card.evaluate((node) => {
    const style = getComputedStyle(node)
    return { bottom: style.paddingBottom, left: style.paddingLeft, right: style.paddingRight }
  })).toEqual({ bottom: "19px", left: "21px", right: "25px" })
  await expect.poll(() => chrome.evaluate((node) => {
    const style = getComputedStyle(node)
    return { borderBottom: style.borderBottomWidth, left: style.paddingLeft, right: style.paddingRight }
  })).toEqual({ borderBottom: "0px", left: "21px", right: "25px" })
  const cardRadius = await card.evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      bottomLeft: Number.parseFloat(style.borderBottomLeftRadius),
      bottomRight: Number.parseFloat(style.borderBottomRightRadius),
      topLeft: Number.parseFloat(style.borderTopLeftRadius),
      topRight: Number.parseFloat(style.borderTopRightRadius),
    }
  })
  expect(cardRadius.topLeft).toBeGreaterThan(0)
  expect(cardRadius.topRight).toBeGreaterThan(0)
  if (testInfo.project.name === "mobile") {
    expect(cardRadius.bottomLeft).toBe(0)
    expect(cardRadius.bottomRight).toBe(0)
  } else {
    expect(cardRadius.bottomLeft).toBeGreaterThan(0)
    expect(cardRadius.bottomRight).toBeGreaterThan(0)
  }
  for (const dark of [false, true]) {
    await page.evaluate((nextDark) => document.documentElement.classList.toggle("dark", nextDark), dark)
    await expect.poll(async () => {
      const cardBackground = await card.evaluate((node) => getComputedStyle(node).backgroundColor)
      const pageBackground = await host.evaluate((node) => getComputedStyle(node).backgroundColor)
      return Boolean(cardBackground) && cardBackground !== pageBackground
    }).toBe(true)
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"))

  // Flow chrome consumes its own row before the child-app card.
  await expect.poll(async () => {
    const chromeBox = await chrome.boundingBox()
    const focusedBox = await focused.boundingBox()
    if (!chromeBox || !focusedBox) return null
    return focusedBox.y >= chromeBox.y + chromeBox.height - 1
  }).toBe(true)

  await page.evaluate(() => {
    document.documentElement.dataset.keyboardVisible = "true"
  })
  await expect.poll(() => card.evaluate((node) =>
    getComputedStyle(node).paddingBottom
  )).toBe("0px")
})

test("preserves the loading gutter while allowing a larger device inset", async ({ page }) => {
  await page.unroute("**/api/apps/recipebot")
  await page.route("**/api/apps/recipebot", () => new Promise(() => {}))
  await page.goto("/react/apps/recipebot/open")
  const loading = page.locator('[data-slot="app-stage-card"][data-state="loading"]')
  await expect(loading).toBeVisible()
  await page.evaluate(() => {
    const root = document.documentElement
    root.style.setProperty("--safe-area-bottom", "9px")
    root.style.setProperty("--safe-area-left", "27px")
    root.style.setProperty("--safe-area-right", "7px")
  })

  await expect.poll(() => loading.evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      top: style.paddingTop,
      bottom: style.paddingBottom,
      left: style.paddingLeft,
      right: style.paddingRight,
    }
  })).toEqual({ top: "16px", bottom: "16px", left: "27px", right: "16px" })
})

test("restores the focused-frame preparing gutter inside the ready host card", async ({ page }) => {
  await page.unroute("**/api/iframe-token*")
  await page.route("**/api/iframe-token*", () => new Promise(() => {}))
  await page.goto("/react/apps/recipebot/open")

  const loading = page.locator('[data-slot="focused-app-surface"][data-state="loading"]')
  const card = page.locator('[data-slot="app-stage-card"][data-state="ready"]')
  await expect(loading).toBeVisible()
  await expect.poll(() => card.evaluate((node) => {
    const style = getComputedStyle(node)
    return { bottom: style.paddingBottom, left: style.paddingLeft, right: style.paddingRight, top: style.paddingTop }
  })).toEqual({ bottom: "16px", left: "16px", right: "16px", top: "16px" })
})

test("restores the focused-frame unavailable gutter inside the ready host card", async ({ page }) => {
  await page.unroute("**/api/apps/recipebot")
  await page.route("**/api/apps/recipebot", (route) => route.fulfill({
    json: { app: { ...app, status: "stopped" } },
  }))
  await page.goto("/react/apps/recipebot/open")

  const unavailable = page.locator('[data-slot="focused-app-surface"][data-state="unavailable"]')
  const card = page.locator('[data-slot="app-stage-card"][data-state="ready"]')
  await expect(unavailable).toBeVisible()
  await expect.poll(() => card.evaluate((node) => {
    const style = getComputedStyle(node)
    return { bottom: style.paddingBottom, left: style.paddingLeft, right: style.paddingRight, top: style.paddingTop }
  })).toEqual({ bottom: "24px", left: "24px", right: "24px", top: "24px" })
})

test("preserves the error gutter while allowing a larger device inset", async ({ page }) => {
  await page.unroute("**/api/apps/recipebot")
  await page.route("**/api/apps/recipebot", (route) => route.fulfill({
    status: 503,
    json: { error: "App unavailable" },
  }))
  await page.goto("/react/apps/recipebot/open")
  const error = page.locator('[data-slot="app-stage-card"][data-state="error"]')
  await expect(error).toBeVisible()
  await page.evaluate(() => {
    const root = document.documentElement
    root.style.setProperty("--safe-area-bottom", "31px")
    root.style.setProperty("--safe-area-left", "11px")
    root.style.setProperty("--safe-area-right", "29px")
  })

  await expect.poll(() => error.evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      top: style.paddingTop,
      bottom: style.paddingBottom,
      left: style.paddingLeft,
      right: style.paddingRight,
    }
  })).toEqual({ top: "24px", bottom: "31px", left: "24px", right: "29px" })
})
