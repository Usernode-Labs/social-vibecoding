import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

const seasons = [
  { season_id: 8, name: "Summer build", is_active: true },
  { season_id: 7, name: "Spring build", is_active: false },
]

async function mockNativeProfile(page: import("@playwright/test").Page) {
  await page.addInitScript(() => Object.defineProperty(window, "usernode", {
    configurable: true,
    value: { getProfileInfo: async () => ({ participantId: 42 }) },
  }))
  await page.route("**/challenges-api/seasons", (route) => route.fulfill({ json: seasons }))
  await page.route("**/challenges-api/me/ranking**", (route) => route.fulfill({ json: { total_points: 950, rank: 9, total_participants: 40, total_tokens: 12, season_name: "Summer build" } }))
  await page.route("**/challenges-api/challenges**", (route) => route.fulfill({ json: route.request().url().includes("season_id=7") ? [{ id: 3, goal: "Spring research", task: "Share findings", event_id: 2, schedule_end: "2026-05-01T00:00:00Z" }] : [
    { id: 1, goal: "Ship your project", task: "Publish the work", event_id: 4, schedule_end: "2026-07-20T00:00:00Z" },
    { id: 2, goal: "Not yet completed", event_id: 4 },
  ] }))
  await page.route("**/challenges-api/me/breakdown**", (route) => route.fulfill({ json: route.request().url().includes("season_id=7")
    ? { challenge_progress: [{ challenge_id: 3, event_id: 2, state: "completed" }] }
    : { challenge_progress: [{ challenge_id: 1, event_id: 4, state: "earned", earned_points: 300 }, { challenge_id: 2, event_id: 4, state: "in_progress" }] } }))
}

test("makes the native-profile capability boundary explicit outside Usernode", async ({ page }) => {
  await page.goto("/react/account/profile")

  await expect(page.getByTestId("profile")).toContainText("Profile unavailable")
  await expect(page.getByTestId("profile")).toContainText("finish registration")
})

test("has no critical or serious accessibility violations without a native bridge", async ({ page }) => {
  await page.goto("/react/account/profile")
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})

test("retains completed challenges and their reported points across available seasons", async ({ page }) => {
  await mockNativeProfile(page)
  await page.goto("/react/account/profile")

  const profile = page.getByTestId("profile")
  const history = profile.getByTestId("profile-challenge-history")
  await expect(history).toContainText("Ship your project")
  await expect(history).toContainText("300 points")
  await expect(history).toContainText("Spring research")
  await expect(history).toContainText("Points not reported")
  await expect(history).not.toContainText("Not yet completed")

  await profile.getByRole("button", { name: "Spring build" }).click()
  await expect(history).toContainText("Spring research")
  await expect(history).not.toContainText("Ship your project")
})

test("keeps profile data visible when completed challenge history cannot load", async ({ page }) => {
  await mockNativeProfile(page)
  await page.route("**/challenges-api/challenges**", (route) => route.fulfill({ status: 404, json: { error: "not found" } }))
  await page.goto("/react/account/profile")

  await expect(page.getByTestId("profile")).toContainText("950")
  await expect(page.getByTestId("profile-challenge-history-error")).toContainText("Completed challenges unavailable")
  await expect(page.getByTestId("profile-challenge-history-error")).toContainText("Request failed (404)")
})

test("explains when the native profile has no completed challenge records", async ({ page }) => {
  await mockNativeProfile(page)
  await page.route("**/challenges-api/me/breakdown**", (route) => route.fulfill({ json: { challenge_progress: [] } }))
  await page.goto("/react/account/profile")

  await expect(page.getByTestId("profile-challenge-history-empty")).toContainText("No completed challenges yet")
})

test("has no critical or serious accessibility violations with completed challenge history", async ({ page }) => {
  await mockNativeProfile(page)
  await page.goto("/react/account/profile")
  await expect(page.getByTestId("profile-challenge-history")).toBeVisible()
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})
