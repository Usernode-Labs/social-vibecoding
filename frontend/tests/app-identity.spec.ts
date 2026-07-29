import { expect, test, type Page } from "@playwright/test"

import "../public/app-shortcut-contract.js"
import {
  appIdentityHash,
  appIdentitySlot,
  serializeAppIdentity,
} from "../@/lib/app-identity-contract"

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

  await page.goto("/react/explore")
  const fallback = page.getByTestId("explore-app-card-recipebot").locator("[data-identity-slot]")
  const slotBeforeRename = await fallback.getAttribute("data-identity-slot")
  await expect(fallback).toHaveClass(/app-identity/)

  appName = "Pantry Planner"
  await page.reload()
  const slotAfterRename = await page.getByTestId("explore-app-card-recipebot").locator("[data-identity-slot]").getAttribute("data-identity-slot")
  expect(slotAfterRename).toBe(slotBeforeRename)
})

test("uses the frozen v1 slot mapping for the first and last palette slots", async ({ page }) => {
  const apps = [
    { ...baseApp, id: "identity-4", slug: "slot-one", name: "Slot One" },
    { ...baseApp, id: "identity-1", slug: "slot-eight", name: "Slot Eight" },
  ]
  await routeAuthenticatedShell(page, apps)

  await page.goto("/react/explore")
  await expect(page.getByTestId("explore-app-card-slot-one").locator("[data-identity-slot]")).toHaveAttribute("data-identity-slot", "1")
  await expect(page.getByTestId("explore-app-card-slot-eight").locator("[data-identity-slot]")).toHaveAttribute("data-identity-slot", "8")
})

test("keeps a complete grapheme as the fallback monogram", async ({ page }) => {
  await routeAuthenticatedShell(page, [{ ...baseApp, name: "👩‍🍳 RecipeBot" }])

  await page.goto("/react/explore")
  await expect(page.getByTestId("explore-app-card-recipebot").locator("[data-identity-slot]")).toHaveText("👩‍🍳")
})

test("fails closed to a monogram when API artwork is not a governed app icon", async ({ page }) => {
  await routeAuthenticatedShell(page, [{
    ...baseApp,
    icon_url: "https://127.0.0.1/private.png",
  }])

  await page.goto("/react/explore")
  const card = page.getByTestId("explore-app-card-recipebot")
  await expect(card.locator("img")).toHaveCount(0)
  await expect(card.locator("[data-identity-slot]")).toHaveText("R")
})

test("uses the legacy slug when the immutable app id is empty", () => {
  const legacyApp = { ...baseApp, id: " ", slug: "recipebot" }
  const equivalentImmutableApp = { ...baseApp, id: "recipebot", slug: "unused" }

  expect(appIdentitySlot(legacyApp)).toBe(appIdentitySlot(equivalentImmutableApp))
  expect(appIdentityHash(legacyApp)).not.toBe(appIdentityHash(equivalentImmutableApp))
  expect(serializeAppIdentity(legacyApp).identity_key).toBe("slug:recipebot")
  expect(serializeAppIdentity(equivalentImmutableApp).identity_key).toBe("id:recipebot")
})

test("rejects an identity with no immutable id or legacy slug", () => {
  expect(() => appIdentitySlot({ ...baseApp, id: " ", slug: "\t" }))
    .toThrow("AppIdentity requires a non-empty app id or legacy slug")
})

test("serializes stable identity separately from mutable appearance", () => {
  const original = serializeAppIdentity(baseApp)
  const renamed = serializeAppIdentity({ ...baseApp, name: "Pantry Planner" })
  const reillustrated = serializeAppIdentity({ ...baseApp, icon_url: "/app-icons/0123456789abcdef0123456789abcdef" })

  expect(original).toMatchObject({
    contract: "usernode.app-identity",
    contract_version: 1,
    hash_algorithm: "fnv1a64",
    identity_key: "id:immutable-recipebot-id",
    slot: appIdentitySlot(baseApp),
    display_name: "RecipeBot",
    monogram: "R",
    artwork_ref: null,
  })
  expect(original.identity_hash).toMatch(/^fnv1a64:[0-9a-f]{16}$/)
  expect(original.appearance_hash).toMatch(/^fnv1a64:[0-9a-f]{16}$/)
  expect(renamed.identity_hash).toBe(original.identity_hash)
  expect(renamed.slot).toBe(original.slot)
  expect(renamed.appearance_hash).not.toBe(original.appearance_hash)
  expect(reillustrated.identity_hash).toBe(original.identity_hash)
  expect(reillustrated.appearance_hash).not.toBe(original.appearance_hash)
})

test("normalizes numeric and numeric-string API ids to the same immutable tuple", () => {
  const numeric = serializeAppIdentity({ ...baseApp, id: 900001 })
  const stringified = serializeAppIdentity({ ...baseApp, id: "900001" })

  expect(numeric.identity_key).toBe("id:900001")
  expect(stringified.identity_key).toBe(numeric.identity_key)
  expect(stringified.identity_hash).toBe(numeric.identity_hash)
  expect(stringified.slot).toBe(numeric.slot)
})

test("preserves the frozen FNV-1a 32 palette mapping while hashes use FNV-1a 64", () => {
  function legacySlot(id: string | number | null, slug: string) {
    const rawIdentity = String(id ?? "").trim() || slug.trim()
    let hash = 0x811c9dc5
    for (const byte of new TextEncoder().encode(`usernode:app-identity:v1:${rawIdentity}`)) {
      hash ^= byte
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash % 8 + 1
  }

  for (const app of [
    { ...baseApp, id: "immutable-recipebot-id", slug: "recipebot" },
    { ...baseApp, id: "identity-4", slug: "slot-one" },
    { ...baseApp, id: "identity-1", slug: "slot-eight" },
    { ...baseApp, id: " ", slug: "legacy-app" },
    { ...baseApp, id: 900001, slug: "numeric-app" },
  ]) {
    expect(appIdentitySlot(app)).toBe(legacySlot(app.id, app.slug))
    expect(appIdentityHash(app)).toMatch(/^fnv1a64:[0-9a-f]{16}$/)
  }
})

test("keeps identity and status boundaries visible in forced colors", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" })
  await routeAuthenticatedShell(page, [baseApp])

  await page.goto("/react/explore")
  await expect.poll(() => page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true)

  const identity = page.getByTestId("explore-app-card-recipebot").locator(".app-identity")
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
