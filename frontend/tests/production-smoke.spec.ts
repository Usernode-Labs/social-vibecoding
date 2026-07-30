import { expect, test } from "@playwright/test"

test.skip(
  process.env.SV_REAL_PRODUCTION_SMOKE !== "true",
  "This suite is reserved for the real-production read-only gate.",
)

test("reads the live public status contract through the guarded local shell", async ({ page }) => {
  const statusResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/status"
  )

  await page.goto("/react/status")

  await expect(page.getByRole("heading", { level: 1, name: "Platform status" })).toBeVisible()
  await expect(page.getByTestId("operational-status").getByText("Status unavailable")).toHaveCount(0)
  await expect((await statusResponse).status()).toBe(200)
})

test("reads the live public leaderboard contract through the guarded local shell", async ({ page }) => {
  const leaderboardResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/leaderboard/prs"
  )

  await page.goto("/react/community/leaderboard")

  await expect(page.getByRole("heading", { level: 1, name: "Kudos leaderboard" })).toBeVisible()
  await expect((await leaderboardResponse).status()).toBe(200)
  await expect(page.getByTestId("leaderboard").locator('[data-slot="skeleton"]')).toHaveCount(0)
  await expect(page.getByTestId("leaderboard").getByText("Leaderboard unavailable")).toHaveCount(0)
})
