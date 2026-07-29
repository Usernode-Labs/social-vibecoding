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
  view_visibility: "public",
  can_manage: true,
  url: "https://recipebot.example.test",
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: { user: { id: 7, username: "ava", canAdminWrite: false } } }),
  )
  await page.route("**/api/notifications?*", (route) =>
    route.fulfill({
      json: {
        notifications: [],
        unread: 0,
        hasMore: false,
        nextBefore: null,
      },
    }),
  )
  await page.route("**/api/node-status/full", (route) =>
    route.fulfill({ json: { node: { status: "synced" } } }),
  )
  await page.route("**/api/apps/recipebot", (route) =>
    route.fulfill({ json: { app } }),
  )
  await page.route("**/api/iframe-token", (route) =>
    route.fulfill({ json: { token: "header.payload.signature" } }),
  )
  await page.route("https://recipebot.example.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <title>RecipeBot</title>
        <style>body { min-height: 2400px; } input { margin-top: 900px; }</style>
        <input aria-label="Recipe draft" value="">
        <script>
          window.__continuityMarker = crypto.randomUUID()
        </script>`,
    }),
  )
})

test("temporary navigation preserves focused-app state and restores trigger focus", async ({
  isMobile,
  page,
}) => {
  test.skip(!isMobile, "The temporary off-canvas navigation contract applies to narrow viewports.")

  await page.goto("/react/apps/recipebot/open")

  const child = page.frameLocator('[data-testid="focused-app-frame"]')
  const draft = child.getByRole("textbox", { name: "Recipe draft" })
  await expect(draft).toBeVisible()
  await draft.fill("tomatoes and chickpeas")

  const frame = page
    .frames()
    .find((candidate) => candidate.url().startsWith("https://recipebot.example.test/"))
  if (!frame) throw new Error("RecipeBot child frame did not load")

  await frame.evaluate(() => window.scrollTo(0, 720))
  const before = await frame.evaluate(() => ({
    marker: (window as Window & { __continuityMarker?: string }).__continuityMarker,
    scrollY: window.scrollY,
  }))

  const trigger = page.getByRole("button", { name: "Toggle navigation" })
  await trigger.click()
  const dialog = page.getByRole("dialog", { name: "Sidebar" })
  await expect(dialog.getByRole("navigation", { name: "Platform navigation" })).toBeVisible()

  await dialog.press("Escape")
  await expect(page.getByRole("navigation", { name: "Platform navigation" })).not.toBeVisible()
  await expect(trigger).toBeFocused()

  await expect(draft).toHaveValue("tomatoes and chickpeas")
  await expect
    .poll(() =>
      frame.evaluate(() => ({
        marker: (window as Window & { __continuityMarker?: string }).__continuityMarker,
        scrollY: window.scrollY,
      })),
    )
    .toEqual(before)
})

test("opening the contextual developer console preserves the focused app frame", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("usernode:devConsoleMode", "always"))
  await page.goto("/react/apps/recipebot/open")

  const child = page.frameLocator('[data-testid="focused-app-frame"]')
  const draft = child.getByRole("textbox", { name: "Recipe draft" })
  await expect(draft).toBeVisible()
  await draft.fill("tomatoes and chickpeas")

  const frame = page
    .frames()
    .find((candidate) => candidate.url().startsWith("https://recipebot.example.test/"))
  if (!frame) throw new Error("RecipeBot child frame did not load")

  await frame.evaluate(() => window.scrollTo(0, 720))
  const before = await frame.evaluate(() => ({
    marker: (window as Window & { __continuityMarker?: string }).__continuityMarker,
    scrollY: window.scrollY,
  }))

  await page.getByRole("button", { name: "Open developer console" }).click()
  await expect(page.getByRole("heading", { name: "Developer console" })).toBeVisible()
  await page.getByRole("button", { name: "Close" }).click()

  await expect(draft).toHaveValue("tomatoes and chickpeas")
  await expect
    .poll(() =>
      frame.evaluate(() => ({
        marker: (window as Window & { __continuityMarker?: string }).__continuityMarker,
        scrollY: window.scrollY,
      })),
    )
    .toEqual(before)
})
