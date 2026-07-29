import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

const content = "# Pantry improvements\n\nKeep weekly cooking simple.\n\n## User-facing changes\n\n- Filter recipes by pantry items.\n\n## Technical implementation\n\n- Index ingredients by normalized name."
const versions = [
  { version: 2, built_at: "2026-07-28T12:00:00Z", shared_to_group_at: null },
  { version: 1, built_at: "2026-07-27T12:00:00Z", shared_to_group_at: null },
]

test.beforeEach(async ({ page }) => {
  await page.route("**/api/sessions/41/spec", (route) => route.fulfill({ json: { spec: content, versions } }))
  await page.route("**/api/sessions/41/specs/1", (route) => route.fulfill({ json: { spec: { version: 1, content: "# Earlier plan\n\nLegacy detail." } } }))
  await page.route("**/api/apps/recipebot/mention-suggestions", (route) => route.fulfill({ json: { users: [{ username: "Mira" }, { username: "Sam" }] } }))
})

test("renders the owner-authorized latest spec with accessible content tabs", async ({ page }) => {
  await page.goto("/react/apps/recipebot/dev/sessions/41/spec")
  const spec = page.getByTestId("session-spec")
  await expect(spec).toContainText("Filter recipes by pantry items.")
  await spec.getByRole("tab", { name: "Technical" }).click()
  await expect(spec).toContainText("Index ingredients by normalized name.")
  await expect(spec.getByRole("link", { name: /legacy Dev/i })).toHaveCount(0)
})

test("loads an immutable historical version and can return to the latest content", async ({ page }) => {
  await page.goto("/react/apps/recipebot/dev/sessions/41/spec")
  const picker = page.getByRole("combobox", { name: "Spec version" })
  await picker.click()
  await page.getByRole("option", { name: "v1" }).click()
  await expect(page.getByTestId("session-spec")).toContainText("Earlier plan")

  await picker.click()
  await page.getByRole("option", { name: "v2 · latest" }).click()
  await expect(page.getByTestId("session-spec")).toContainText("Filter recipes by pantry items.")
  await expect(page.getByTestId("session-spec")).not.toContainText("Earlier plan")
})

test("shares the selected immutable version to the app discussion and reloads canonical metadata", async ({ page }) => {
  let shared = false
  let shareRequests = 0
  await page.unroute("**/api/sessions/41/spec")
  await page.route("**/api/sessions/41/spec", (route) => route.fulfill({
    json: {
      spec: content,
      versions: versions.map((version) => version.version === 2 && shared
        ? { ...version, shared_to_group_at: "2026-07-29T12:00:00Z" }
        : version),
    },
  }))
  await page.route("**/api/sessions/41/specs/2/share", async (route) => {
    shareRequests += 1
    shared = true
    await route.fulfill({ json: { ok: true, appSlug: "recipebot", messageId: 99 } })
  })

  await page.goto("/react/apps/recipebot/dev/sessions/41/spec")
  await page.getByRole("button", { name: "Share to group" }).click()
  await expect(page.getByRole("heading", { name: "Share spec version 2 to the app discussion?" })).toBeVisible()
  await page.getByRole("button", { name: "Share to group" }).last().click()

  await expect.poll(() => shareRequests).toBe(1)
  await expect(page.getByRole("button", { name: "Shared to group" })).toBeDisabled()
  await expect(page.getByText("Version 2 was shared to the app discussion.")).toBeVisible()
})

test("privately shares the selected version with a suggested collaborator", async ({ page }) => {
  let body: unknown = null
  await page.route("**/api/sessions/41/specs/2/share-user", async (route) => {
    body = route.request().postDataJSON()
    await route.fulfill({ json: { ok: true, recipient: { username: "Mira" } } })
  })

  await page.goto("/react/apps/recipebot/dev/sessions/41/spec")
  await page.getByRole("button", { name: "Share privately" }).click()
  await page.getByRole("button", { name: "@Mira" }).click()
  await page.getByRole("button", { name: "Share privately" }).last().click()

  await expect.poll(() => body).toEqual({ username: "Mira" })
  await expect(page.getByText("Version 2 was shared with @Mira.")).toBeVisible()
})

test("preserves the private-share dialog and exact server rejection", async ({ page }) => {
  await page.route("**/api/sessions/41/specs/2/share-user", (route) => route.fulfill({
    status: 400,
    json: { error: "That user doesn't have access to this app" },
  }))
  await page.goto("/react/apps/recipebot/dev/sessions/41/spec")
  await page.getByRole("button", { name: "Share privately" }).click()
  await page.getByLabel("Username").fill("outsider")
  await page.getByRole("button", { name: "Share privately" }).last().click()
  await expect(page.getByText("That user doesn't have access to this app")).toBeVisible()
  await expect(page.getByLabel("Username")).toHaveValue("outsider")
})

test("renders empty, denied and mobile accessible states", async ({ page }) => {
  await page.route("**/api/sessions/41/spec", (route) => route.fulfill({ json: { spec: "", versions: [] } }))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/react/apps/recipebot/dev/sessions/41/spec")
  await expect(page.getByTestId("session-spec")).toContainText("No spec yet")
  const result = await new AxeBuilder({ page }).analyze()
  expect(result.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])

  await page.unroute("**/api/sessions/41/spec")
  await page.route("**/api/sessions/41/spec", (route) => route.fulfill({ status: 404, json: { error: "Session not found" } }))
  await page.reload()
  await expect(page.getByRole("alert")).toContainText("Spec unavailable")
})

test("production review mode exposes sharing states without mutations", async ({ page }) => {
  test.skip(process.env.SV_PRODUCTION_READONLY !== "true", "This state is compiled only for the production-review profile.")
  let writes = 0
  await page.route("**/api/sessions/41/specs/*/share*", async (route) => {
    writes += 1
    await route.fulfill({ status: 500, json: { error: "must not write" } })
  })
  await page.goto("/react/apps/recipebot/dev/sessions/41/spec")
  await expect(page.getByRole("button", { name: "Share to group" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Share privately" })).toBeDisabled()
  await expect(page.getByText("Sharing is disabled while this local workspace reviews production data.")).toBeVisible()
  expect(writes).toBe(0)
})
