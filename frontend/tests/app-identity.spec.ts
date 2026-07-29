import { expect, test, type Page } from "@playwright/test"

import { appIdentitySlot } from "../@/features/apps/app-identity-contract"

const baseApp = {
  id: "immutable-recipebot-id",
  slug: "recipebot",
  name: "RecipeBot",
  status: "running",
  tagline: "Find a recipe for what you have at home",
  description: null,
  active_users: 24,
  is_favorited: false,
  is_collaborator: false,
  your_apps_hidden: false,
  favorite_order: null,
  open_prs: 0,
  active_sessions: 0,
  open_issues: 0,
  icon_url: null,
}

async function routeAuthenticatedShell(
  page: Page,
  apps: Array<typeof baseApp>,
  user: Record<string, unknown> = { id: 7, username: "ava", canAdminWrite: false }
) {
  await page.route("**/api/apps", (route) => route.fulfill({ json: { apps } }))
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user } }))
}

test("keeps fallback identity artwork stable when an app name changes", async ({ page }) => {
  let appName = "RecipeBot"
  await page.route("**/api/apps", (route) => route.fulfill({ json: { apps: [{ ...baseApp, name: appName }] } }))
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: 7, username: "ava", canAdminWrite: false } } }))

  await page.goto("/react/")
  const fallback = page.getByTestId("app-card-recipebot").first().locator("[data-identity-slot]")
  const slotBeforeRename = await fallback.getAttribute("data-identity-slot")
  await expect(fallback).toHaveClass(/app-identity/)

  appName = "Pantry Planner"
  await page.reload()
  const slotAfterRename = await page.getByTestId("app-card-recipebot").first().locator("[data-identity-slot]").getAttribute("data-identity-slot")
  expect(slotAfterRename).toBe(slotBeforeRename)
})

test("uses the frozen v1 slot mapping for the first and last palette slots", async ({ page }) => {
  const apps = [
    { ...baseApp, id: "identity-4", slug: "slot-one", name: "Slot One" },
    { ...baseApp, id: "identity-1", slug: "slot-eight", name: "Slot Eight" },
  ]
  await routeAuthenticatedShell(page, apps)

  await page.goto("/react/")
  await expect(page.getByTestId("app-card-slot-one").first().locator("[data-identity-slot]")).toHaveAttribute("data-identity-slot", "1")
  await expect(page.getByTestId("app-card-slot-eight").first().locator("[data-identity-slot]")).toHaveAttribute("data-identity-slot", "8")
})

test("keeps a complete grapheme as the fallback monogram", async ({ page }) => {
  await routeAuthenticatedShell(page, [{ ...baseApp, name: "👩‍🍳 RecipeBot" }])

  await page.goto("/react/")
  await expect(page.getByTestId("app-card-recipebot").first().locator("[data-identity-slot]")).toHaveText("👩‍🍳")
})

test("uses the legacy slug when the immutable app id is empty", () => {
  const legacyApp = { ...baseApp, id: " ", slug: "recipebot" }
  const equivalentImmutableApp = { ...baseApp, id: "recipebot", slug: "unused" }

  expect(appIdentitySlot(legacyApp)).toBe(appIdentitySlot(equivalentImmutableApp))
})

test("rejects an identity with no immutable id or legacy slug", () => {
  expect(() => appIdentitySlot({ ...baseApp, id: " ", slug: "\t" }))
    .toThrow("AppIdentity requires a non-empty app id or legacy slug")
})

test("keeps identity and status boundaries visible in forced colors", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" })
  await routeAuthenticatedShell(page, [baseApp])

  await page.goto("/react/")
  await expect.poll(() => page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true)

  const identity = page.getByTestId("app-card-recipebot").first().locator(".app-identity")
  await expect(identity).toBeVisible()
  const identityBoundary = await identity.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      border: style.borderColor,
      borderStyle: style.borderStyle,
      borderWidth: style.borderWidth,
      foreground: style.color,
    }
  })
  expect(identityBoundary.borderStyle).toBe("solid")
  expect(identityBoundary.borderWidth).not.toBe("0px")
  expect(identityBoundary.border).not.toBe(identityBoundary.background)
  expect(identityBoundary.foreground).not.toBe(identityBoundary.background)

  await page.evaluate(() => {
    const status = document.createElement("span")
    status.className = "status-dot inline-flex size-2.5 shrink-0 rounded-full border"
    status.dataset.statusRole = "positive"
    status.dataset.testid = "forced-colors-status-dot"
    status.setAttribute("aria-label", "RecipeBot, running")
    status.setAttribute("role", "img")
    document.body.append(status)
  })

  const status = page.getByTestId("forced-colors-status-dot")
  await expect(status).toBeVisible()
  const statusBoundary = await status.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      border: style.borderColor,
      borderStyle: style.borderStyle,
      borderWidth: style.borderWidth,
      outline: style.outlineColor,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    }
  })
  expect(statusBoundary.borderStyle).toBe("solid")
  expect(statusBoundary.borderWidth).not.toBe("0px")
  expect(statusBoundary.border).not.toBe(statusBoundary.background)
  expect(statusBoundary.outlineStyle).toBe("solid")
  expect(statusBoundary.outlineWidth).not.toBe("0px")
  expect(statusBoundary.outline).not.toBe(statusBoundary.border)
})
