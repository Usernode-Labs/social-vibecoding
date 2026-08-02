import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({
    json: { user: { id: 7, username: "ava", canAdminWrite: false } },
  }))
  await page.route("**/api/notifications?*", (route) => route.fulfill({
    json: { notifications: [], unread: 0, hasMore: false, nextBefore: null },
  }))
  await page.route("**/api/node-status/full", (route) => route.fulfill({
    json: { node: { status: "synced" } },
  }))
  await page.route("**/api/sessions/9", (route) => route.fulfill({ json: {
    session: { id: 9, app_slug: "recipebot", app_name: "RecipeBot", branch_name: "feature/pantry", session_title: "Improve pantry search", pr_title: null, status: "active", staging_url: "https://preview.example.test", testing_path: "/pantry", testing_md: "Search for a pantry staple and confirm its filter.", created_at: "2026-07-28T12:00:00.000Z" },
    messages: [],
  } }))
  await page.route("**/api/sessions/9/ensure-staging", (route) => route.fulfill({ json: { status: "ready", url: "https://preview.example.test" } }))
  await page.route("**/api/iframe-token*", (route) => {
    if (new URL(route.request().url()).searchParams.get("app") !== "recipebot") {
      return route.fulfill({ status: 400, json: { error: "app query parameter is required" } })
    }
    return route.fulfill({ json: { token: "preview-token" } })
  })
  await page.route("https://preview.example.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>Preview</title><main>Preview ready</main>" }))
})

test("opens a server-authorized preview only after its secure host is reachable", async ({ page }) => {
  await page.goto("/react/apps/recipebot/dev/sessions/9/preview")
  await expect(page.getByTestId("staging-preview")).toBeVisible()
  await expect(page.getByTitle("Staging preview")).toHaveAttribute("src", /https:\/\/preview\.example\.test\/pantry\?token=preview-token/)
  await expect(page.getByRole("button", { name: "Back" })).toBeVisible()
  const externalPreview = page.getByRole("link", { name: "Open externally" })
  await expect(externalPreview).toHaveAttribute("data-slot", "action-anchor")
  await expect(externalPreview).toHaveAttribute("href", "https://preview.example.test/pantry?token=preview-token")
  await expect(externalPreview).toHaveAttribute("target", "_blank")
  await expect(externalPreview).toHaveAttribute("rel", "noreferrer")
  const staged = page.locator('[data-slot="app-stage-boundary"]')
  await expect(staged).toHaveAttribute("data-status-tone", "info")
  await expect(staged.getByText("Staged", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "How to test this change" }).click()
  await expect(page.getByText("Search for a pantry staple and confirm its filter.")).toBeVisible()
})

test("has no critical or serious accessibility violations", async ({ page }) => {
  await page.goto("/react/apps/recipebot/dev/sessions/9/preview")
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})

test("exposes the developer console only from the active preview chrome", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("usernode:devConsoleMode", "always"))
  await page.goto("/react/apps/recipebot/dev/sessions/9/preview")

  const trigger = page.getByRole("button", { name: "Open developer console" })
  await expect(page.locator('[data-slot="staged-console-control"]')).toHaveAttribute("data-status-tone", "info")
  await expect(trigger).toBeVisible()
  await trigger.click()
  await expect(page.getByRole("heading", { name: "Developer console" })).toBeVisible()
})

test("keeps preview chrome and its iframe inside web-owned safe-area slots", async ({ page }) => {
  await page.goto("/react/apps/recipebot/dev/sessions/9/preview")
  const preview = page.locator('[data-slot="hosted-app-stage"][data-state="ready"]')
  const card = page.locator('[data-slot="app-stage-card"][data-state="ready"]')
  const header = page.locator('[data-slot="top-bar"]')
  const frame = page.locator('[data-slot="staging-preview-frame"]')
  await expect(preview).toBeVisible()
  await page.evaluate(() => {
    const root = document.documentElement
    root.style.setProperty("--safe-area-bottom", "17px")
    root.style.setProperty("--safe-area-left", "21px")
    root.style.setProperty("--safe-area-right", "25px")
  })

  await expect.poll(() => preview.evaluate((node) => getComputedStyle(node).paddingBottom)).toBe("0px")
  await expect.poll(() => card.evaluate((node) => {
    const style = getComputedStyle(node)
    return { bottom: style.paddingBottom, left: style.paddingLeft, right: style.paddingRight }
  })).toEqual({ bottom: "17px", left: "21px", right: "25px" })
  await expect.poll(() => header.evaluate((node) => {
    const style = getComputedStyle(node)
    return { borderBottom: style.borderBottomWidth, left: style.paddingLeft, right: style.paddingRight }
  })).toEqual({ borderBottom: "0px", left: "21px", right: "25px" })
  await expect.poll(() => frame.evaluate((node) => {
    const style = getComputedStyle(node)
    return { left: style.marginLeft, right: style.marginRight }
  })).toEqual({ left: "0px", right: "0px" })

  for (const dark of [false, true]) {
    await page.locator("html").evaluate((node, nextDark) => node.classList.toggle("dark", nextDark), dark)
    await expect.poll(async () => {
      const cardBackground = await card.evaluate((node) => getComputedStyle(node).backgroundColor)
      const pageBackground = await preview.evaluate((node) => getComputedStyle(node).backgroundColor)
      return Boolean(cardBackground) && cardBackground !== pageBackground
    }).toBe(true)
  }
})

test("preserves the preview loading gutter while allowing a larger device inset", async ({ page }) => {
  await page.unroute("**/api/sessions/9")
  await page.route("**/api/sessions/9", () => new Promise(() => {}))
  await page.goto("/react/apps/recipebot/dev/sessions/9/preview")
  const loading = page.locator('[data-slot="hosted-app-stage"][data-state="loading"]')
  const loadingCard = loading.locator('[data-slot="app-stage-card"][data-state="loading"]')
  await expect(loadingCard).toBeVisible()
  await expect(loadingCard.locator('[data-slot="card-title"] > [data-slot="platform-icon"]')).toHaveCSS("width", "16px")
  await expect(loadingCard.locator('[data-slot="card-title"] > [data-slot="platform-icon"]')).toHaveCSS("height", "16px")
  const loadingRecoveryLink = loadingCard.getByRole("link", { name: "Return to session" })
  await expect(loadingRecoveryLink).toHaveAttribute("data-slot", "action-link")
  await expect(loadingRecoveryLink).toHaveAttribute("href", "/react/apps/recipebot/dev/sessions/9")
  await page.evaluate(() => {
    const root = document.documentElement
    root.style.setProperty("--safe-area-bottom", "9px")
    root.style.setProperty("--safe-area-left", "31px")
    root.style.setProperty("--safe-area-right", "7px")
  })

  await expect.poll(() => loadingCard.evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      top: style.paddingTop,
      bottom: style.paddingBottom,
      left: style.paddingLeft,
      right: style.paddingRight,
    }
  })).toEqual({ top: "24px", bottom: "24px", left: "31px", right: "24px" })
})

test("preserves the preview error gutter while allowing a larger device inset", async ({ page }) => {
  await page.unroute("**/api/sessions/9")
  await page.route("**/api/sessions/9", (route) => route.fulfill({
    status: 503,
    json: { error: "Preview unavailable" },
  }))
  await page.goto("/react/apps/recipebot/dev/sessions/9/preview")
  const error = page.locator('[data-slot="hosted-app-stage"][data-state="error"]')
  const errorCard = error.locator('[data-slot="app-stage-card"][data-state="error"]')
  await expect(errorCard).toBeVisible()
  const errorRecoveryLink = errorCard.getByRole("link", { name: "Return to session" })
  await expect(errorRecoveryLink).toHaveAttribute("data-slot", "action-link")
  await expect(errorRecoveryLink).toHaveAttribute("href", "/react/apps/recipebot/dev/sessions/9")
  await page.evaluate(() => {
    const root = document.documentElement
    root.style.setProperty("--safe-area-bottom", "29px")
    root.style.setProperty("--safe-area-left", "11px")
    root.style.setProperty("--safe-area-right", "27px")
  })

  await expect.poll(() => errorCard.evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      top: style.paddingTop,
      bottom: style.paddingBottom,
      left: style.paddingLeft,
      right: style.paddingRight,
    }
  })).toEqual({ top: "24px", bottom: "29px", left: "24px", right: "27px" })
})
