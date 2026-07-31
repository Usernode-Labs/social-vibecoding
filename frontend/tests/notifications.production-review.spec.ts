import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

test.skip(process.env.SV_PRODUCTION_READONLY !== "true", "This suite exercises the production-review build profile only.")

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: null } }))
  await page.route("**/api/notifications?limit=20", (route) => route.fulfill({ json: {
    unread: 1,
    hasMore: false,
    nextBefore: null,
    pendingInvites: [{ kind: "collab", appId: 7, appSlug: "recipebot", appName: "RecipeBot", invitedBy: "ava", createdAt: "2026-07-28T12:00:00.000Z" }],
    notifications: [
      { id: 1, kind: "mention", readAt: null, appId: 4, appSlug: "recipebot", appName: "RecipeBot", createdAt: "2026-07-28T12:00:00.000Z", messageContent: "Can we add a pantry filter?", sourceUsername: "ava" },
    ],
  } }))
})

test("production review mode exposes notifications but cannot mark them read or mutate invitations", async ({ page }) => {
  let markReadRequests = 0
  let inviteMutationRequests = 0
  await page.route("**/api/notifications/read", (route) => {
    markReadRequests += 1
    return route.fulfill({ json: { unread: 0 } })
  })
  await page.route("**/api/invites/**", (route) => { inviteMutationRequests += 1; return route.fulfill({ json: { ok: true } }) })
  await page.goto("/react/notifications")
  await expect(page.getByRole("alert")).toContainText("Read-only")
  await expect(page.getByRole("alert")).toContainText("Marking activity as read and accepting or declining invitations are unavailable.")
  await expect(page.getByRole("button", { name: "Mark all read" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Mark read" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Accept" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Decline" })).toBeDisabled()
  await page.getByRole("link", { name: "Open activity: Can we add a pantry filter?" }).click()
  await expect.poll(() => markReadRequests).toBe(0)
  expect(inviteMutationRequests).toBe(0)
})

test("production review mode has no critical or serious accessibility violations", async ({ page }) => {
  await page.goto("/react/notifications")
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})
