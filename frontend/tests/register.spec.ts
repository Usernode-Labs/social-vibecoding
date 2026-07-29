import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

test("submits the existing activation-code registration contract and returns to Apps", async ({ page }) => {
  let registration: unknown
  await page.route("**/api/auth/register", async (route) => {
    registration = route.request().postDataJSON()
    await route.fulfill({ json: { user: { username: "ava" } } })
  })
  await page.route("**/api/apps", (route) => route.fulfill({ json: { apps: [] } }))

  await page.goto("/react/register?code=JOIN-AVA#app/recipebot/app")
  await expect(page.getByLabel("Activation code")).toHaveValue("JOIN-AVA")
  await expect(page.getByLabel("Username")).toBeFocused()
  await page.getByLabel("Username").fill("ava")
  await page.getByLabel("Password").fill("correct horse battery staple")
  await page.getByRole("button", { name: "Create account" }).click()

  await expect(page).toHaveURL(/\/react\/?#app\/recipebot\/app$/)
  expect(registration).toEqual({ code: "JOIN-AVA", username: "ava", password: "correct horse battery staple" })
})

test("explains a rejected activation code without leaving registration", async ({ page }) => {
  await page.route("**/api/auth/register", (route) => route.fulfill({ status: 400, json: { error: "Invalid or already used activation code" } }))

  await page.goto("/react/register")
  await page.getByLabel("Activation code").fill("EXPIRED")
  await page.getByLabel("Username").fill("ava")
  await page.getByLabel("Password").fill("correct horse battery staple")
  await page.getByRole("button", { name: "Create account" }).click()

  await expect(page.getByRole("alert")).toHaveText("Invalid or already used activation code")
  await expect(page).toHaveURL(/\/react\/register$/)
})

test("keeps registration visible when the account service cannot be reached", async ({ page }) => {
  await page.route("**/api/auth/register", (route) => route.abort("failed"))

  await page.goto("/react/register")
  await page.getByLabel("Activation code").fill("JOIN-AVA")
  await page.getByLabel("Username").fill("ava")
  await page.getByLabel("Password").fill("correct horse battery staple")
  await page.getByRole("button", { name: "Create account" }).click()

  await expect(page.getByRole("alert")).toHaveText("Network error")
  await expect(page).toHaveURL(/\/react\/register$/)
})

test("preserves a legacy fragment when moving between login and registration", async ({ page }) => {
  await page.goto("/react/register#app/recipebot/dev")
  await page.getByRole("link", { name: "Log in" }).click()
  await expect(page).toHaveURL(/\/react\/login#app\/recipebot\/dev$/)
  await page.getByRole("link", { name: "Register" }).click()
  await expect(page).toHaveURL(/\/react\/register#app\/recipebot\/dev$/)
})

test("has no critical or serious accessibility violations", async ({ page }) => {
  await page.goto("/react/register?code=JOIN-AVA")
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})
