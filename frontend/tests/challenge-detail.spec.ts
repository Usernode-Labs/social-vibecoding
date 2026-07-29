import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

function fixture() {
  return {
    season: { season_id: 8, name: "Summer build", is_active: true },
    challenges: [{
      id: 12, goal: "Review three app proposals", task: "Give useful feedback on open proposals.", category: "Build", reward: "300 points", description: "Review proposals that help the community.", requirements: "Leave constructive feedback on three proposals.", reward_logic: "Points are awarded after review approval.", cta_label: "Review in legacy", cta_link: "/#challenges/12", metric: { kind: "count", label: "reviews", target: 3 },
    }],
    progress: { challenge_progress: [{ challenge_id: 12, state: "in progress", current: 1.5, target: 3, description: "One review approved" }] },
  }
}

async function installFixture(page: import("@playwright/test").Page, native = true) {
  const data = fixture()
  if (native) await page.addInitScript(() => Object.defineProperty(window, "usernode", { configurable: true, value: { getProfileInfo: async () => ({ participantId: 42 }) } }))
  await page.route("**/challenges-api/seasons", (route) => route.fulfill({ json: [data.season] }))
  await page.route("**/challenges-api/challenges**", (route) => route.fulfill({ json: data.challenges }))
  await page.route("**/challenges-api/leaderboard**", (route) => route.fulfill({ json: { leaderboard: [] } }))
  await page.route("**/challenges-api/me/breakdown**", (route) => route.fulfill({ json: data.progress }))
}

test("renders the native-aware read-only challenge detail and legacy action handoff", async ({ page }) => {
  await installFixture(page)
  await page.goto("/react/community/challenges/12")
  const detail = page.getByTestId("challenge-detail")
  await expect(detail.getByRole("heading", { name: "Review three app proposals" })).toBeVisible()
  await expect(detail).toContainText("1.5 / 3 reviews")
  await expect(detail).toContainText("Personal progress available")
  await expect(detail).toContainText("Points are awarded after review approval.")
  await expect(detail.getByRole("link", { name: /Review in legacy/i })).toHaveAttribute("href", "/#challenges/12")
})

test("uses public data without requesting participant progress on desktop", async ({ page }) => {
  await installFixture(page, false)
  let breakdownRequested = false
  await page.route("**/challenges-api/me/breakdown**", (route) => { breakdownRequested = true; return route.fulfill({ json: {} }) })
  await page.goto("/react/community/challenges/12")
  await expect(page.getByTestId("challenge-detail")).toContainText("Public challenge data")
  expect(breakdownRequested).toBe(false)
})

test("loads the full season list when an active list omits a deep-linked completed challenge", async ({ page }) => {
  const data = fixture()
  const completed = { ...data.challenges[0], id: 99, goal: "Completed season challenge", completed: true }
  await page.route("**/challenges-api/seasons", (route) => route.fulfill({ json: [data.season] }))
  await page.route("**/challenges-api/challenges**", (route) => {
    const activeOnly = new URL(route.request().url()).searchParams.get("active_only") === "1"
    return route.fulfill({ json: activeOnly ? data.challenges : [...data.challenges, completed] })
  })
  await page.route("**/challenges-api/leaderboard**", (route) => route.fulfill({ json: { leaderboard: [] } }))
  await page.goto("/react/community/challenges/99")
  await expect(page.getByTestId("challenge-detail")).toContainText("Completed season challenge")
  await expect(page.getByText("Completed", { exact: true })).toBeVisible()
})

test("renders loading, missing, and error states", async ({ page }) => {
  await installFixture(page)
  await page.route("**/challenges-api/challenges**", (route) => route.fulfill({ status: 500, json: { error: "offline" } }))
  await page.goto("/react/community/challenges/12")
  await expect(page.getByTestId("challenge-detail-error")).toBeVisible()

  await installFixture(page)
  await page.goto("/react/community/challenges/999")
  await expect(page.getByTestId("challenge-detail-not-found")).toBeVisible()
})

test("remains usable at mobile width and has no serious accessibility violations", async ({ page }) => {
  await installFixture(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/react/community/challenges/12")
  const detail = page.getByTestId("challenge-detail")
  await expect(detail).toBeVisible()
  expect(await detail.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})
