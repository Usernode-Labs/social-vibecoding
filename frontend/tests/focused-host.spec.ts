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
  await page.route("**/api/apps/recipebot", (route) => {
    appRequests += 1
    return route.fulfill({ json: { app } })
  })
  await page.route("**/api/iframe-token", (route) => {
    tokenRequests += 1
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

  await expect(page.getByRole("img", { name: "RecipeBot, offline" })).toBeVisible()
  await expect(page.getByTestId("focused-app-frame")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(1)
  await page.getByRole("button", { name: "Retry" }).click()

  await expect.poll(() => appRequests).toBeGreaterThan(settledAppRequests)
  await expect(page.getByTestId("focused-app-frame")).toBeVisible()
})

test("refreshes the iframe token on cadence without reloading an unchanged source", async ({ page }) => {
  await page.clock.install()
  await page.goto("/react/apps/recipebot/open")
  await expect(page.getByRole("img", { name: "RecipeBot, running" })).toBeVisible()

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
