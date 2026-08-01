import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

async function expectFullCanvasRoute(page: import("@playwright/test").Page, testId: string, title: string) {
  const route = page.getByTestId(testId)
  await expect(route.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible()
  await expect(route.locator("h1")).toHaveCount(1)
  expect(await route.getAttribute("class")).not.toMatch(/\b(?:mx-auto|max-w-)/)
}

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
  await expectFullCanvasRoute(page, "challenge-detail", "Review three app proposals")
  await expect(detail.getByRole("link", { name: "All challenges" })).toHaveCount(0)
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
  const detail = page.getByTestId("challenge-detail")
  const terminal = detail.getByTestId("challenge-terminal-content")
  await expect(detail).toContainText("Completed season challenge")
  await expect(terminal.getByRole("region", { name: "Reward earned" })).toBeVisible()
  await expect(terminal.getByRole("button")).toHaveCount(0)
  await expect(terminal.locator('[data-slot="action-link"]')).toHaveCount(1)
  const continuation = terminal.getByRole("link", { name: "View season history" })
  await expect(continuation).toHaveAttribute("href", "/react/community/challenges")
  const continuationBox = await continuation.boundingBox()
  expect(continuationBox).not.toBeNull()
  expect(Math.round(continuationBox!.height)).toBe(await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches) ? 48 : 32)
  await expect(terminal).not.toContainText("Review in legacy")
  const results = await new AxeBuilder({ page }).include('[data-testid="challenge-terminal-content"]').analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})

test("removes residual actions from a missed challenge without dead-ending the page", async ({ page }) => {
  const data = fixture()
  data.progress.challenge_progress = [{ challenge_id: 12, state: "missed" }]
  await page.addInitScript(() => Object.defineProperty(window, "usernode", { configurable: true, value: { getProfileInfo: async () => ({ participantId: 42 }) } }))
  await page.route("**/challenges-api/seasons", (route) => route.fulfill({ json: [data.season] }))
  await page.route("**/challenges-api/challenges**", (route) => route.fulfill({ json: data.challenges }))
  await page.route("**/challenges-api/leaderboard**", (route) => route.fulfill({ json: { leaderboard: [] } }))
  await page.route("**/challenges-api/me/breakdown**", (route) => route.fulfill({ json: data.progress }))

  await page.goto("/react/community/challenges/12")
  const terminal = page.getByTestId("challenge-terminal-content")
  await expect(terminal.locator('[data-challenge-phase="missed"]')).toBeVisible()
  await expect(terminal.getByRole("button")).toHaveCount(0)
  await expect(terminal.locator('[data-slot="action-link"]')).toHaveCount(1)
  await expect(terminal.getByRole("link", { name: "View season history" })).toHaveAttribute("href", "/react/community/challenges")
  await expect(terminal).not.toContainText("Review in legacy")
})

test("renders loading, missing, and error states", async ({ page }) => {
  let releaseChallenges!: () => void
  const challengesReady = new Promise<void>((resolve) => {
    releaseChallenges = resolve
  })
  await installFixture(page)
  await page.route("**/challenges-api/challenges**", async (route) => {
    await challengesReady
    await route.fulfill({ json: fixture().challenges })
  })
  await page.goto("/react/community/challenges/12")
  await expectFullCanvasRoute(page, "challenge-detail-loading", "Challenge")
  releaseChallenges()
  await expectFullCanvasRoute(page, "challenge-detail", "Review three app proposals")

  await installFixture(page)
  await page.route("**/challenges-api/challenges**", (route) => route.fulfill({ status: 500, json: { error: "offline" } }))
  await page.goto("/react/community/challenges/12")
  await expectFullCanvasRoute(page, "challenge-detail-error", "Challenge unavailable")

  await installFixture(page)
  await page.goto("/react/community/challenges/999")
  const notFound = page.getByTestId("challenge-detail-not-found")
  await expectFullCanvasRoute(page, "challenge-detail-not-found", "Challenge not found")
  await expect(notFound.getByRole("link", { name: "All challenges" })).toHaveCount(0)
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
