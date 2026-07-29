import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

const publicSnapshot = {
  version: "abcdef1",
  now: "2026-07-28T12:00:00.000Z",
  isAdmin: false,
  deployProgress: { deploying: true, sha: "abcdef123456" },
  summary: {
    apps: 3,
    prodRunning: 2,
    prodMissing: 1,
    stagingRunning: 1,
    stagingCap: 8,
    workersInFlight: 2,
    workersWarmIdle: 1,
    workersOrphaned: 0,
    stuckSessions: 1,
    // Deliberately sent by this fixture to prove the React view does not
    // render admin-sensitive values even if an upstream payload has them.
    globalSpendCents: 999999,
    globalSpendCap: 1000000,
    hostMemUsedPct: 97,
    dbPoolWaiting: 3,
  },
  node: { status: "Synced", peers: 3, bestTipHeight: 12480, peerBestTipHeight: 12483, hasFullUtxoDb: true },
  apps: [{ name: "RecipeBot", slug: "recipebot", dbStatus: "running", openSessions: 2, openIssues: 1, prod: { state: "running" } }],
  workers: [{ state: "running", workerMode: "in-flight", sessionId: 11, appSlug: "recipebot", username: "ava", uptimeSeconds: 73, model: "private-model", lastProgress: "secret progress text" }],
  stuckSessions: [{ id: 14, appSlug: "game-corner", username: "sam", branchName: "feature/puzzle", ageSeconds: 3720 }],
  driftContainers: [{ kind: "production", expected: "app-recipebot" }],
  host: { memUsedPct: 97 },
  db: { waiting: 3 },
  llmUsage: [{ username: "ava", costCents: 999999 }],
  events: [{ message: "operator-only event" }],
}

test("renders the public operational snapshot without admin diagnostics or controls", async ({ page }) => {
  await page.route("**/api/status", (route) => route.fulfill({ json: publicSnapshot }))
  await page.goto("/react/status")

  const status = page.getByTestId("operational-status")
  await expect(status).toContainText("Platform status")
  await expect(status).toContainText("2 / 3")
  await expect(status).toContainText("RecipeBot")
  await expect(status).toContainText("recipebot · session 11")
  await expect(status).toContainText("Container drift detected")
  await expect(status).toContainText("Deploy in progress")
  await expect(status).not.toContainText("private-model")
  await expect(status).not.toContainText("secret progress text")
  await expect(status).not.toContainText("operator-only event")
  await expect(status).not.toContainText("999,999")
  await expect(status).not.toContainText("97%")
  await expect(status).toContainText("outside this read-only React view")
  await expect(status.getByRole("button", { name: "Refresh" })).toBeVisible()
  await expect(status.getByRole("button")).toHaveCount(1)
})

test("refreshes the public snapshot on request", async ({ page }) => {
  let read = 0
  await page.route("**/api/status", (route) => {
    read += 1
    return route.fulfill({ json: { ...publicSnapshot, summary: { ...publicSnapshot.summary, apps: read, prodRunning: read }, apps: [] } })
  })
  await page.goto("/react/status")
  await expect.poll(() => read).toBeGreaterThan(0)
  await expect(page.getByTestId("operational-status")).toContainText(`${read} / ${read}`)
  const beforeRefresh = read
  await page.getByRole("button", { name: "Refresh" }).click()
  await expect.poll(() => read).toBeGreaterThan(beforeRefresh)
  await expect(page.getByTestId("operational-status")).toContainText(`${read} / ${read}`)
})

test("renders a request error without showing stale operational controls", async ({ page }) => {
  await page.route("**/api/status", (route) => route.fulfill({ status: 503, json: { error: "unavailable" } }))
  await page.goto("/react/status")
  const status = page.getByTestId("operational-status")
  await expect(status.getByRole("alert")).toContainText("Status unavailable")
  await expect(status.getByRole("alert")).toContainText("Request failed (503)")
  await expect(status.getByText("Apps", { exact: true })).toHaveCount(0)
})

test("has no critical or serious accessibility violations", async ({ page }) => {
  await page.route("**/api/status", (route) => route.fulfill({ json: publicSnapshot }))
  await page.goto("/react/status")
  await expect(page.getByTestId("operational-status")).toContainText("Platform status")
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})
