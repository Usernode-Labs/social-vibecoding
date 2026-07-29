import { expect, test } from "@playwright/test"

const apps = { apps: [] }

const semanticFoundationVariables = [
  ...Array.from({ length: 8 }, (_, index) => index + 1).flatMap((slot) => [
    `--identity-${slot}-surface`,
    `--identity-${slot}-foreground`,
    `--identity-${slot}-border`,
  ]),
  ...["positive", "info", "warning", "negative"].flatMap((role) => [
    `--status-${role}-surface`,
    `--status-${role}-foreground`,
    `--status-${role}-border`,
  ]),
  "--attention-surface",
  "--attention-foreground",
  "--attention-border",
]

async function computedFoundationSnapshot(page: import("@playwright/test").Page, preference: "light" | "dark" | "system", colorScheme: "light" | "dark") {
  await page.emulateMedia({ colorScheme })
  await page.evaluate((selectedPreference) => localStorage.setItem("theme", selectedPreference), preference)
  await page.reload()
  const expectedMode = preference === "system" ? colorScheme : preference
  await expect(page.locator("html")).toHaveAttribute("data-theme", expectedMode)
  return page.evaluate((names) => Object.fromEntries(names.map((name) => [name, getComputedStyle(document.documentElement).getPropertyValue(name).trim()])), semanticFoundationVariables)
}

test("persists an explicit System preference while applying an effective mode", async ({ page }) => {
  await page.route("**/api/apps", (route) => route.fulfill({ json: apps }))
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: 7, username: "ava", canAdminWrite: false } } }))

  await page.goto("/react/")
  const systemMode = page.getByRole("button", { name: /Use system mode/ })
  if (!await systemMode.isVisible()) {
    await page.getByRole("button", { name: "Toggle navigation" }).click()
  }
  await page.getByRole("button", { name: "Use dark mode" }).click()
  await systemMode.click()

  await expect.poll(() => page.evaluate(() => localStorage.getItem("theme"))).toBe("system")
  await expect(page.locator("html")).toHaveAttribute("data-theme", /^(light|dark)$/)
})

test("System resolves identity, status, and attention tokens exactly like explicit Light and Dark", async ({ page }) => {
  await page.route("**/api/apps", (route) => route.fulfill({ json: apps }))
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: 7, username: "ava", canAdminWrite: false } } }))
  await page.goto("/react/")

  const explicitLight = await computedFoundationSnapshot(page, "light", "dark")
  const systemLight = await computedFoundationSnapshot(page, "system", "light")
  expect(systemLight).toEqual(explicitLight)

  const explicitDark = await computedFoundationSnapshot(page, "dark", "light")
  const systemDark = await computedFoundationSnapshot(page, "system", "dark")
  expect(systemDark).toEqual(explicitDark)
  expect(Object.values(systemLight).every(Boolean)).toBe(true)
  expect(Object.values(systemDark).every(Boolean)).toBe(true)
})
