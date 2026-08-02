import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

/**
 * A deliberately mixed Fair Rewards stream, based on mobile PR #463. It is
 * both a route fixture and an executable presentation-contract matrix: the
 * UI must derive status and progress from server fields, never local scoring
 * prose or completion filtering.
 */
function challengeFixture() {
  const now = Date.now()
  const at = (millisecondsFromNow: number) => new Date(now + millisecondsFromNow).toISOString()

  return {
    season: { season_id: 8, name: "Summer build", is_active: true, ends_at: at(21 * 24 * 60 * 60 * 1000) },
    challenges: [
      {
        id: 1,
        goal: "Join the community showcase",
        task: "Share a useful app with the community.",
        category: "Community",
        reward: "250 points",
        featured: true,
        enabled: true,
        display_order: 1,
        schedule_end: at(21 * 24 * 60 * 60 * 1000),
        metric: { kind: "binary", label: "showcase" },
      },
      {
        id: 2,
        goal: "Review three app proposals",
        task: "Give useful feedback on open proposals.",
        category: "Build",
        reward: "300 points",
        enabled: true,
        display_order: 2,
        schedule_end: at(8 * 60 * 60 * 1000),
        metric: { kind: "count", label: "reviews", target: 3 },
      },
      {
        id: 3,
        goal: "Share Season feedback about the new rewards experience",
        task: "Complete the short feedback survey.",
        category: "Community",
        reward: "100 points",
        enabled: true,
        display_order: 3,
        schedule_end: at(3 * 24 * 60 * 60 * 1000),
        metric: { kind: "binary", label: "survey" },
      },
      {
        id: 4,
        goal: "Publish a useful tool",
        task: "Ship a small, useful app this season.",
        category: "Build",
        reward: "500 points",
        enabled: true,
        completed: true,
        display_order: 4,
        metric: { kind: "reputation", label: "reputation" },
      },
      {
        id: 5,
        goal: "Keep your profile current",
        task: "Complete the profile checklist.",
        category: "Community",
        reward: "75 points",
        enabled: true,
        display_order: 5,
        metric: { kind: "percentage", label: "profile" },
      },
    ],
    progress: {
      scope: "season",
      events: [{
        event_id: 80,
        total_points: 675,
        challenge_progress: [
        { challenge_id: 1, state: "none", current: 0, target: 1, pending_points: 0, earned_points: 0 },
        // Fractional values intentionally prove the rail is not integer-only.
        { challenge_id: 2, state: "in progress", current: 1.5, target: 3, pending_points: 0, earned_points: 0 },
        { challenge_id: 3, state: "pending", pending_points: 100, earned_points: 0, description: "Survey submitted and awaiting community review" },
        // The unknown metric must still render safely as a terminal card.
        { challenge_id: 4, state: "earned", pending_points: 0, earned_points: 500, description: "Approved" },
        // The near-complete rail proves its fill stops before the reward cell.
        { challenge_id: 5, state: "in progress", current: 99, target: 100, pending_points: 0, earned_points: 0 },
        ],
      }],
    },
    leaderboard: { leaderboard: [{ rank: 1, display_name: "Ava", total_points: 1200 }] },
  }
}

test.beforeEach(async ({ page }) => {
  const fixture = challengeFixture()
  await page.addInitScript(() => {
    Object.defineProperty(window, "usernode", {
      configurable: true,
      value: {
        getProfileInfo: async () => ({ participantId: 42 }),
      },
    })
  })
  await page.route("**/challenges-api/seasons", (route) => route.fulfill({ json: [fixture.season] }))
  // The native-aware request adds participant_id while the public browser
  // request does not. Both must receive the same challenge contract fixture.
  await page.route("**/challenges-api/challenges**", (route) => route.fulfill({ json: fixture.challenges }))
  await page.route("**/challenges-api/leaderboard**", (route) => route.fulfill({ json: fixture.leaderboard }))

  // The legacy contract has appeared under both challenge and leaderboard
  // paths. Keep this fixture explicit at the boundary while the React adapter
  // settles on one typed read path.
  await page.route("**/challenges-api/me/breakdown**", (route) => route.fulfill({ json: fixture.progress }))
})

test("renders the backend-driven challenges feed in perceived-time bands", async ({ page }) => {
  await page.goto("/react/community/challenges")
  const challenges = page.getByTestId("challenges")

  await expect(challenges.getByRole("heading", { level: 1 })).toHaveCount(1)
  await expect(challenges).toHaveCSS("max-width", "none")
  await expect(challenges.getByTestId("challenge-season-anchor")).toContainText("675")
  await expect(challenges.getByTestId("challenge-season-anchor")).toContainText("Current window")
  await expect(challenges.getByRole("heading", { name: "Featured" })).toBeVisible()
  await expect(challenges.getByRole("heading", { name: "Today" })).toBeVisible()
  await expect(challenges.getByRole("heading", { name: "This week" })).toBeVisible()
  await expect(challenges.getByRole("heading", { name: "Season", exact: true })).toBeVisible()
  await expect(challenges).toContainText("Join the community showcase")
  await expect(challenges).toContainText("Review three app proposals")
  await expect(challenges).toContainText("Share Season feedback")
  await expect(challenges).toContainText("Publish a useful tool")
})

test("keeps every atomic progress state readable inside the title-and-rail contract", async ({ page }) => {
  await page.goto("/react/community/challenges")
  const challenges = page.getByTestId("challenges")

  await expect(challenges.getByTestId("challenge-card-1")).toContainText("Not done")
  await expect(challenges.getByTestId("challenge-card-2")).toContainText("1.5 / 3 reviews")
  await expect(challenges.getByTestId("challenge-card-3")).toContainText("Survey submitted")
  await expect(challenges.getByTestId("challenge-card-4")).toContainText("Completed 500 pts")
  await expect(challenges.getByText("Publish a useful tool")).toBeVisible()
  // PR #463's AtomicChallengeCard keeps all instruction and category copy on
  // the detail surface. The stream remains one title plus one progress rail.
  await expect(challenges).not.toContainText("Share a useful app with the community.")
  await expect(challenges).not.toContainText("Community")
})

test("binds completed and in-progress rails to their governed visual contracts", async ({ page }) => {
  await page.goto("/react/community/challenges")
  const completedCard = page.getByTestId("challenge-card-4")
  const inProgressRail = page.getByTestId("challenge-card-2").getByRole("progressbar")
  const inProgressFill = inProgressRail.getByTestId("challenge-progress-fill")

  await expect(completedCard.getByRole("link")).toHaveAttribute("data-status-tone", "positive")
  await expect(completedCard.getByText("Completed 500 pts")).toHaveCSS("font-weight", "600")
  await expect(completedCard.getByRole("link")).toHaveCount(1)
  await expect(completedCard.getByRole("button")).toHaveCount(0)

  const railBox = await inProgressRail.boundingBox()
  const fillBox = await inProgressFill.boundingBox()
  expect(railBox).not.toBeNull()
  expect(fillBox).not.toBeNull()
  expect(fillBox!.y).toBeCloseTo(railBox!.y, 0)
  expect(fillBox!.height).toBeCloseTo(railBox!.height, 0)
  expect(fillBox!.width / railBox!.width).toBeCloseTo(0.5, 2)

  const nearCompleteCard = page.getByTestId("challenge-card-5")
  const nearCompleteFillBox = await nearCompleteCard.getByTestId("challenge-progress-fill").boundingBox()
  const nearCompleteRewardBox = await nearCompleteCard.getByTestId("challenge-reward").boundingBox()
  expect(nearCompleteFillBox).not.toBeNull()
  expect(nearCompleteRewardBox).not.toBeNull()
  expect(nearCompleteFillBox!.x + nearCompleteFillBox!.width).toBeLessThanOrEqual(nearCompleteRewardBox!.x)
})

test("renders fractional and unknown metrics without unsafe numeric output", async ({ page }) => {
  await page.goto("/react/community/challenges")
  const challenges = page.getByTestId("challenges")

  await expect(challenges).toContainText("1.5 / 3 reviews")
  await expect(challenges).not.toContainText("NaN")
  await expect(challenges).not.toContainText("Infinity")
})

test("renders continuous challenge rows in one linear band instead of cards", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/react/community/challenges")
  const first = page.getByTestId("challenge-card-4")
  const second = page.getByTestId("challenge-card-5")
  const firstBox = await first.boundingBox()
  const secondBox = await second.boundingBox()
  expect(firstBox).not.toBeNull()
  expect(secondBox).not.toBeNull()
  expect(secondBox!.x).toBeCloseTo(firstBox!.x, 0)
  expect(Math.abs(secondBox!.y - firstBox!.y)).toBeGreaterThan(Math.min(firstBox!.height, secondBox!.height) - 1)
  await expect(first).toHaveCSS("box-shadow", "none")
  await expect(second).toHaveCSS("box-shadow", "none")
})

test("renders leaderboard points as the row anchor without badges or cards", async ({ page }) => {
  await page.goto("/react/community/challenges")
  const leaderboard = page.getByRole("heading", { name: "Season leaderboard" }).locator("..")
  const row = page.getByTestId("challenge-leaderboard-row")

  await expect(row).toHaveCount(1)
  await expect(row).toContainText("#1")
  await expect(row).toContainText("Ava")
  await expect(row.getByLabel("1,200 points")).toBeVisible()
  await expect(leaderboard.getByRole("button")).toHaveCount(0)
})

test("keeps the dynamic feed usable at a mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/react/community/challenges")

  const challenges = page.getByTestId("challenges")
  await expect(challenges).toBeVisible()
  await expect(challenges.getByRole("heading", { name: "Featured" })).toBeVisible()
  const firstLink = challenges.getByTestId("challenge-card-1").getByRole("link")
  const firstLinkBox = await firstLink.boundingBox()
  expect(firstLinkBox).not.toBeNull()
  expect(firstLinkBox!.height).toBeGreaterThanOrEqual(48)
  expect(await challenges.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)

  const pendingCard = challenges.getByTestId("challenge-card-3")
  const pendingLink = pendingCard.getByRole("link")
  const pendingTitle = pendingCard.getByRole("heading", { name: "Share Season feedback about the new rewards experience" })
  const pendingStatus = pendingCard.getByText("Survey submitted and awaiting community review")
  const rewardVariants = pendingCard.getByTestId("challenge-reward").locator(":scope > span")
  await expect(pendingTitle).toHaveCSS("white-space", "normal")
  await expect(pendingStatus).toHaveCSS("white-space", "normal")
  await expect(rewardVariants.first()).toHaveText("100 pts")
  await expect(rewardVariants.first()).toBeVisible()
  await expect(rewardVariants.last()).toHaveText("Pending 100 pts")
  await expect(rewardVariants.last()).toBeHidden()
  await expect(pendingLink).toHaveAccessibleName("Share Season feedback about the new rewards experience, Survey submitted and awaiting community review, Pending 100 pts")
})

test("has no critical or serious accessibility violations", async ({ page }) => {
  await page.goto("/react/community/challenges")
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})
