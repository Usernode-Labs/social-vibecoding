import { expect, test } from "@playwright/test"

type LifecycleCase = {
  name: string
  expected: "open" | "in-progress" | "pending" | "completed" | "missed"
  challenge?: Record<string, unknown>
  progress?: Record<string, unknown>
}

const cases: LifecycleCase[] = [
  { name: "completed flag", expected: "completed", challenge: { completed: true } },
  { name: "earned progress state", expected: "completed", progress: { state: "earned" } },
  { name: "completed progress state", expected: "completed", progress: { state: "completed" } },
  { name: "earned progress points", expected: "completed", progress: { earned_points: 25 } },
  { name: "flat earned points", expected: "completed", challenge: { earned_points: 25 } },
  { name: "completed reward state fallback", expected: "completed", challenge: { reward_state: "completed" } },
  { name: "completed flat state fallback", expected: "completed", challenge: { state: "completed" } },
  { name: "pending progress state", expected: "pending", progress: { state: "pending" } },
  { name: "submitted raw progress state", expected: "pending", progress: { state: "submitted" } },
  { name: "pending progress points", expected: "pending", progress: { pending_points: 25 } },
  { name: "flat pending points", expected: "pending", challenge: { pending_points: 25 } },
  { name: "pending reward state fallback", expected: "pending", challenge: { reward_state: "pending" } },
  { name: "submitted flat state fallback", expected: "pending", challenge: { state: "submitted" } },
  { name: "missed progress state", expected: "missed", progress: { state: "missed" } },
  { name: "declined progress state", expected: "missed", progress: { state: "declined" } },
  { name: "expired raw progress state", expected: "missed", progress: { state: "expired" } },
  { name: "expired reward state fallback", expected: "missed", challenge: { reward_state: "expired" } },
  { name: "in-progress normalized state", expected: "in-progress", progress: { state: "in progress" } },
  { name: "progress current evidence", expected: "in-progress", progress: { current: 1 } },
  { name: "flat current evidence", expected: "in-progress", challenge: { current: 1 } },
  { name: "no lifecycle evidence", expected: "open" },
]

test("keeps feed and detail phases identical for every lifecycle disjunct", async ({ page }) => {
  test.setTimeout(120_000)
  let activeCase = cases[0]
  await page.addInitScript(() => Object.defineProperty(window, "usernode", {
    configurable: true,
    value: { getProfileInfo: async () => ({ participantId: 42 }) },
  }))
  await page.route("**/challenges-api/seasons", (route) => route.fulfill({
    json: [{ season_id: 8, name: "Lifecycle matrix", is_active: true }],
  }))
  await page.route("**/challenges-api/challenges**", (route) => route.fulfill({
    json: [{
      id: 120,
      goal: activeCase.name,
      reward: "25 points",
      enabled: true,
      ...activeCase.challenge,
    }],
  }))
  await page.route("**/challenges-api/leaderboard**", (route) => route.fulfill({ json: { leaderboard: [] } }))
  await page.route("**/challenges-api/me/breakdown**", (route) => route.fulfill({
    json: activeCase.progress
      ? { challenge_progress: [{ challenge_id: 120, ...activeCase.progress }] }
      : { challenge_progress: [] },
  }))

  for (const lifecycleCase of cases) {
    activeCase = lifecycleCase
    await test.step(lifecycleCase.name, async () => {
      await page.goto("/react/community/challenges")
      await expect(page.getByTestId("challenge-card-120")).toHaveAttribute("data-challenge-phase", lifecycleCase.expected)

      await page.goto("/react/community/challenges/120")
      await expect(page.getByTestId("challenge-detail").locator("[data-challenge-phase]")).toHaveAttribute("data-challenge-phase", lifecycleCase.expected)
    })
  }
})
