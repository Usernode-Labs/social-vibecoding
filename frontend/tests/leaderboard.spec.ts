import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

async function expectFullCanvasRoute(page: import("@playwright/test").Page, testId: string, title: string) {
  const route = page.getByTestId(testId)
  await expect(route.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible()
  await expect(route.locator("h1")).toHaveCount(1)
  expect(await route.getAttribute("class")).not.toMatch(/\b(?:mx-auto|max-w-)/)
}

const prs = {
  window: "all",
  weekStart: null,
  items: [{
    session_id: 42,
    pr_number: 18,
    pr_url: "https://github.com/Usernode-Labs/social-vibecoding/pull/18",
    pr_title: "Make recipes easier to find",
    status: "merged",
    author_username: "ava",
    app_slug: "recipebot",
    app_name: "RecipeBot",
    kudos_count: 12,
  }],
}

const users = {
  window: "week",
  weekStart: "2026-07-27",
  items: [{
    username: "ava",
    kudos_received_prs_merged: 12,
    kudos_received: 14,
    prs_merged: 3,
    active_apps: [{ slug: "recipebot", name: "RecipeBot" }],
  }],
}

const avaProfile = {
  user: { user_id: 5, username: "ava" },
  stats: { kudos_merged: 12, prs_merged: 3, prs_total: 4 },
  nextBefore: "2026-07-10T10:00:00.000Z",
  items: [{
    session_id: 42,
    pr_number: 18,
    pr_url: "https://github.com/Usernode-Labs/social-vibecoding/pull/18",
    pr_title: "Make recipes easier to find",
    status: "merged",
    created_at: "2026-07-20T10:00:00.000Z",
    app_slug: "recipebot",
    app_name: "RecipeBot",
    kudos_count: 12,
  }],
}

const history = {
  nextBefore: "2026-07-20T10:00:00.000Z",
  items: [
    {
      type: "kudos",
      created_at: "2026-07-22T10:00:00.000Z",
      app: { slug: "recipebot", name: "RecipeBot" },
      pr: { sessionId: 42, number: 18, title: "Make recipes easier to find", author: "ava" },
    },
    {
      type: "bounty",
      created_at: "2026-07-21T10:00:00.000Z",
      app: { slug: "recipebot", name: "RecipeBot" },
      issue: { number: 12 },
      status: "open",
    },
    {
      type: "pr_vote",
      created_at: "2026-07-20T10:00:00.000Z",
      app: { slug: "recipebot", name: "RecipeBot" },
      pr: { sessionId: 44, number: 19, title: "Support pantry filters", author: "ava" },
      vote: "yes",
      status: "open",
    },
  ],
}

const voteHistory = {
  nextBefore: null,
  items: [{
    type: "proposal_vote",
    created_at: "2026-07-19T10:00:00.000Z",
    app: { slug: "recipebot", name: "RecipeBot" },
    issue: { number: 7, title: "Add grocery export", kind: "feature" },
    vote: "up",
    status: "open",
  }],
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/leaderboard/prs?window=all&limit=20", (route) => route.fulfill({ json: prs }))
  await page.route("**/api/leaderboard/prs?window=week&limit=20", (route) => route.fulfill({ json: { ...prs, window: "week" } }))
  await page.route("**/api/leaderboard/users?window=all&limit=20", (route) => route.fulfill({ json: { ...users, window: "all" } }))
  await page.route("**/api/leaderboard/users?window=week&limit=20", (route) => route.fulfill({ json: users }))
  await page.route("**/api/leaderboard/users/ava/prs?limit=50", (route) => route.fulfill({ json: avaProfile }))
  await page.route("**/api/leaderboard/users/ava/prs?limit=50&before=*", (route) => route.fulfill({ json: { ...avaProfile, nextBefore: null, items: [{ ...avaProfile.items[0], session_id: 41, pr_title: "Add saved searches" }] } }))
  await page.route("**/api/me/history?type=all&limit=50", (route) => route.fulfill({ json: history }))
  await page.route("**/api/me/history?type=kudos&limit=50", (route) => route.fulfill({ json: { ...history, nextBefore: null, items: history.items.slice(0, 2) } }))
  await page.route("**/api/me/history?type=votes&limit=50", (route) => route.fulfill({ json: voteHistory }))
  await page.route("**/api/me/history?type=all&limit=50&before=*", (route) => route.fulfill({ json: { nextBefore: null, items: [{ ...history.items[2], type: "proposal_vote", created_at: "2026-07-18T10:00:00.000Z", issue: { number: 1, title: "Improve discovery" }, pr: undefined, vote: "down" }] } }))
})

test("renders public proposal recognition with React detail and explicit GitHub destinations", async ({ page }) => {
  await page.goto("/react/community/leaderboard")

  await expectFullCanvasRoute(page, "leaderboard", "Kudos leaderboard")
  await expect(page.getByTestId("leaderboard")).toContainText("Make recipes easier to find")
  await expect(page.getByRole("link", { name: "View Make recipes easier to find" })).toHaveAttribute("href", "/react/apps/recipebot/dev/proposals/42")
  await expect(page.getByRole("link", { name: "Open Make recipes easier to find on GitHub" })).toHaveAttribute("href", "https://github.com/Usernode-Labs/social-vibecoding/pull/18")
})

test("preserves the user and period choices in browser-visible route state", async ({ page }) => {
  await page.goto("/react/community/leaderboard")
  await page.getByRole("button", { name: "Top users" }).click()
  await page.getByRole("button", { name: "This week" }).click()

  await expect(page).toHaveURL(/tab=users&window=week/)
  await expect(page.getByTestId("leaderboard")).toContainText("@ava")
  await expect(page.getByText("Active on RecipeBot")).toBeVisible()
})

test("uses a public profile deep link with browser-visible route state and keeps the private route signed in", async ({ page }) => {
  await page.goto("/react/community/leaderboard?tab=users&window=week")
  await expect(page.getByRole("link", { name: "My history" })).toHaveAttribute("href", "/react/community/leaderboard/history")
  await page.getByRole("link", { name: "View @ava's profile" }).click()

  await expect(page).toHaveURL(/\/community\/leaderboard\/users\/ava\?window=week/)
  await expectFullCanvasRoute(page, "leaderboard-profile", "@ava")
  await expect(page.getByTestId("leaderboard-profile")).toContainText("12 kudos on merged")
  await expect(page.getByRole("link", { name: "View Make recipes easier to find" })).toHaveAttribute("href", "/react/apps/recipebot/dev/proposals/42")
  await expect(page.getByRole("link", { name: "Top users" })).toHaveCount(0)
})

test("renders the private give-side history with typed React source destinations", async ({ page }) => {
  await page.goto("/react/community/leaderboard/history")

  await expectFullCanvasRoute(page, "leaderboard-history", "My history")
  await expect(page.getByRole("link", { name: "Kudos leaderboard" })).toHaveCount(0)
  await expect(page.getByTestId("leaderboard-history")).toContainText("Everything you’ve given")
  await expect(page.getByTestId("leaderboard-history")).toContainText("Make recipes easier to find")
  await expect(page.getByTestId("leaderboard-history")).toContainText("Pledged kudos on issue #12")
  await expect(page.getByRole("link", { name: "View Make recipes easier to find" })).toHaveAttribute("href", "/react/apps/recipebot/dev/proposals/42")
  await expect(page.getByRole("link", { name: "View Pledged kudos on issue #12" })).toHaveAttribute("href", "/react/apps/recipebot/dev/issues/12")
})

test("maps the two legacy filter chips to a typed private history feed", async ({ page }) => {
  await page.goto("/react/community/leaderboard/history")

  await page.getByRole("button", { name: "Kudos" }).click()
  await expect(page).toHaveURL(/kudos=0&votes=1/)
  await expect(page.getByTestId("leaderboard-history")).toContainText("Add grocery export")
  await expect(page.getByTestId("leaderboard-history")).not.toContainText("Pledged kudos on issue #12")

  await page.getByRole("button", { name: "Votes" }).click()
  await expect(page).toHaveURL(/kudos=0&votes=0/)
  await expect(page.getByRole("button", { name: "Kudos" })).toHaveAttribute("aria-pressed", "false")
  await expect(page.getByRole("button", { name: "Votes" })).toHaveAttribute("aria-pressed", "false")
})

test("appends a keyset page without replacing the earlier private history", async ({ page }) => {
  await page.goto("/react/community/leaderboard/history")
  await page.getByRole("button", { name: "Load more" }).click()

  await expect(page.getByTestId("leaderboard-history")).toContainText("Make recipes easier to find")
  await expect(page.getByTestId("leaderboard-history")).toContainText("Improve discovery")
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0)
})

test("makes an unsigned private history explicit", async ({ page }) => {
  await page.route("**/api/me/history?type=all&limit=50", (route) => route.fulfill({ status: 401, json: { error: "Unauthorized" } }))
  await page.goto("/react/community/leaderboard/history")
  await expect(page.getByRole("alert")).toContainText("Sign in to view your history")
})

test("keeps the history route usable at a mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/react/community/leaderboard/history")
  const historySurface = page.getByTestId("leaderboard-history")
  await expect(historySurface).toBeVisible()
  expect(await historySurface.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
})

test("loads another public-profile page without losing earlier proposals", async ({ page }) => {
  await page.goto("/react/community/leaderboard/users/ava")
  await page.getByRole("button", { name: "Load more" }).click()

  await expect(page.getByTestId("leaderboard-profile")).toContainText("Make recipes easier to find")
  await expect(page.getByTestId("leaderboard-profile")).toContainText("Add saved searches")
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0)
})

test("makes a missing public profile explicit", async ({ page }) => {
  await page.route("**/api/leaderboard/users/missing/prs?limit=50", (route) => route.fulfill({ status: 404, json: { error: "User not found" } }))
  await page.goto("/react/community/leaderboard/users/missing")
  await expectFullCanvasRoute(page, "leaderboard-profile", "@missing")
  await expect(page.getByRole("alert")).toContainText("User not found")
})

test("has no critical or serious accessibility violations", async ({ page }) => {
  await page.goto("/react/community/leaderboard")
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})

test("profile has no critical or serious accessibility violations", async ({ page }) => {
  await page.goto("/react/community/leaderboard/users/ava")
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})

test("private history has no critical or serious accessibility violations", async ({ page }) => {
  await page.goto("/react/community/leaderboard/history")
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})
