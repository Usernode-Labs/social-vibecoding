import { expect, test, type Locator } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

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
      while (distance < 64 && ownsPoint(centerX + deltaX * (distance + 1), centerY + deltaY * (distance + 1))) distance += 1
      return distance
    }
    const left = scan(-1, 0)
    const right = scan(1, 0)
    const top = scan(0, -1)
    const bottom = scan(0, 1)
    return { effectiveHeight: top + bottom + 1, effectiveWidth: left + right + 1, visualHeight: rectangle.height, visualWidth: rectangle.width }
  })
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { isAdmin: true, canAdminWrite: true } } }))
  await page.route("**/api/admin/codes", (route) => route.fulfill({ json: [
    { id: 1, code: "c82ea91f11ad", created_at: "2026-07-27T10:00:00.000Z" },
    { id: 2, code: "deaf2b58a554", created_at: "2026-07-20T10:00:00.000Z", used_at: "2026-07-21T10:00:00.000Z", used_by_username: "ava" },
  ] }))
})

test("creates an activation code with the established POST contract", async ({ page }) => {
  let creationRequests = 0
  await page.route("**/api/admin/codes", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    creationRequests += 1
    expect(route.request().postData()).toBeNull()
    await route.fulfill({ json: { id: 3, code: "newcode123456", created_at: "2026-07-28T10:00:00.000Z" } })
  })
  await page.goto("/react/admin/codes")
  const route = page.getByTestId("activation-codes")
  await expect(route).not.toHaveClass(/(?:mx-auto|max-w-)/)
  await expect(page.getByRole("heading", { exact: true, level: 1, name: "Activation codes" })).toHaveCount(1)
  await expect(route).toContainText("c82ea91f11ad")
  await expect(route).toContainText("Used by ava")
  await expect(route).toContainText("1 available, 1 used")
  await page.getByRole("button", { name: "Generate code" }).click()
  await expect(page.getByTestId("activation-codes")).toContainText("newcode123456")
  expect(creationRequests).toBe(1)
  const managementLink = page.getByRole("link", { name: "Manage codes" })
  await expect(managementLink).toHaveAttribute("data-slot", "action-anchor")
  await expect(managementLink).toHaveAttribute("href", "/#admin/codes")
})

test("copies an activation code locally without calling a server mutation", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (text: string) => { (window as unknown as { __copiedActivationCode?: string }).__copiedActivationCode = text; return Promise.resolve() } } })
  })
  await page.goto("/react/admin/codes")
  await page.getByRole("button", { name: "Copy activation code c82ea91f11ad" }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __copiedActivationCode?: string }).__copiedActivationCode)).toBe("c82ea91f11ad")
  await expect(page.getByRole("button", { name: "Copy activation code c82ea91f11ad" })).toContainText("Copied")
})

test("keeps used provenance visible by default and masks it locally", async ({ page }) => {
  let mutationRequests = 0
  await page.route("**/api/admin/codes**", async (route) => {
    if (route.request().method() !== "GET") mutationRequests += 1
    await route.fallback()
  })
  await page.goto("/react/admin/codes")
  const route = page.getByTestId("activation-codes")
  await expect(route.getByText("deaf2b58a554", { exact: true })).toBeVisible()
  await expect(route).toContainText("Used by ava")
  const hide = page.getByRole("button", { name: "Hide used code details" })
  await expect(hide).toHaveAttribute("aria-pressed", "true")
  const hitTarget = await probeHitTarget(hide)
  if (await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches)) {
    expect(hitTarget.effectiveHeight).toBeGreaterThanOrEqual(48)
    expect(hitTarget.effectiveWidth).toBeGreaterThanOrEqual(48)
  } else {
    expect(hitTarget.visualHeight).toBeLessThan(48)
    expect(hitTarget.visualWidth).toBeLessThan(48)
  }
  await hide.click()
  await expect(route).not.toContainText("deaf2b58a554")
  await expect(route).not.toContainText("Used by ava")
  await expect(route).toContainText("Used details hidden")
  await expect(page.getByRole("button", { name: "Copy activation code deaf2b58a554" })).toHaveCount(0)
  const show = page.getByRole("button", { name: "Show used code details" })
  await expect(show).toHaveAttribute("aria-pressed", "false")
  await show.click()
  await expect(route.getByText("deaf2b58a554", { exact: true })).toBeVisible()
  await expect(route).toContainText("Used by ava")
  expect(mutationRequests).toBe(0)
})

test("surfaces the server creation error directly", async ({ page }) => {
  await page.route("**/api/admin/codes", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    await route.fulfill({ status: 429, json: { error: "Too many unused activation codes." } })
  })
  await page.goto("/react/admin/codes")
  await page.getByRole("button", { name: "Generate code" }).click()
  await expect(page.getByRole("alert")).toContainText("Too many unused activation codes.")
})

test("confirms and revokes an unused code with the established DELETE contract", async ({ page }) => {
  let revokeRequests = 0
  await page.route("**/api/admin/codes/1", async (route) => {
    expect(route.request().method()).toBe("DELETE")
    revokeRequests += 1
    await route.fulfill({ json: { ok: true } })
  })
  await page.goto("/react/admin/codes")
  await page.getByRole("button", { name: "Revoke activation code c82ea91f11ad" }).click()
  await expect(page.getByRole("alertdialog")).toContainText("This invalidates c82ea91f11ad")
  await page.getByRole("button", { name: "Revoke code" }).click()
  await expect(page.getByTestId("activation-codes")).not.toContainText("c82ea91f11ad")
  expect(revokeRequests).toBe(1)
})

test("keeps a failed revocation visible and retains the code", async ({ page }) => {
  await page.route("**/api/admin/codes/1", (route) => route.fulfill({ status: 400, json: { error: "Code not found or already used" } }))
  await page.goto("/react/admin/codes")
  await page.getByRole("button", { name: "Revoke activation code c82ea91f11ad" }).click()
  await page.getByRole("button", { name: "Revoke code" }).click()
  await expect(page.getByRole("alert")).toContainText("Code not found or already used")
  await expect(page.getByTestId("activation-codes")).toContainText("c82ea91f11ad")
})

test("keeps generation usable on a narrow mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 })
  await page.goto("/react/admin/codes")
  const topBar = page.locator('[data-slot="top-bar"]')
  const identity = topBar.locator('[data-slot="top-bar-identity"]')
  const actions = topBar.locator('[data-slot="top-bar-action"]')
  const title = topBar.getByRole("heading", { level: 1, name: "Activation codes" })
  await expect(title).toBeVisible()
  await expect(title).toHaveCSS("white-space", "normal")
  await expect(page.getByRole("button", { name: "Generate code" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Revoke activation code c82ea91f11ad" })).toBeVisible()
  const identityBox = await identity.boundingBox()
  const actionsBox = await actions.boundingBox()
  expect(identityBox).not.toBeNull()
  expect(actionsBox).not.toBeNull()
  expect(actionsBox!.y).toBeGreaterThanOrEqual(identityBox!.y + identityBox!.height)
})

test("view-only administrators cannot generate activation codes", async ({ page }) => {
  let creationRequests = 0
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { isAdmin: true, canAdminWrite: false } } }))
  await page.route("**/api/admin/codes", async (route) => {
    if (route.request().method() === "POST") creationRequests += 1
    await route.fallback()
  })
  await page.goto("/react/admin/codes")
  await expect(page.getByRole("alert")).toContainText("View-only administrator")
  await expect(page.getByRole("button", { name: "Generate code" })).toBeDisabled()
  const revoke = page.getByRole("button", { name: "Revoke activation code c82ea91f11ad" })
  await expect(revoke).toBeDisabled()
  await expect(revoke).not.toHaveClass(/bg-destructive/)
  expect(creationRequests).toBe(0)
})

test("production review mode disables generation and revocation without mutation requests", async ({ page }) => {
  test.skip(process.env.SV_PRODUCTION_READONLY !== "true", "This state is compiled only for the production-review profile.")
  let mutationRequests = 0
  await page.route("**/api/admin/codes", async (route) => {
    if (route.request().method() !== "GET") mutationRequests += 1
    await route.fallback()
  })
  await page.goto("/react/admin/codes")
  await expect(page.getByRole("alert")).toContainText("Changes unavailable")
  await expect(page.getByRole("button", { name: "Generate code" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Revoke activation code c82ea91f11ad" })).toBeDisabled()
  expect(mutationRequests).toBe(0)
})

test("has no critical or serious accessibility violations", async ({ page }) => {
  await page.goto("/react/admin/codes")
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})
