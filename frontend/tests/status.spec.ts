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

const denseApps = Array.from({ length: 38 }, (_, index) => ({
  name: index === 37 ? "Signal App" : `Quiet App ${String(index + 1).padStart(2, "0")}`,
  slug: index === 37 ? "signal-app" : `quiet-app-${index + 1}`,
  dbStatus: "ok",
  openSessions: index === 37 ? 1 : 0,
  openIssues: index === 37 ? 1 : 0,
  prod: { state: "running" },
}))

async function statusDotStyles(locator: import("@playwright/test").Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element)
    const root = getComputedStyle(document.documentElement)
    return {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      neutralBackground: root.getPropertyValue("--muted").trim(),
      neutralBorder: root.getPropertyValue("--border").trim(),
    }
  })
}

test("renders the public operational snapshot without admin diagnostics or controls", async ({ page }) => {
  await page.route("**/api/status", (route) => route.fulfill({ json: publicSnapshot }))
  await page.goto("/react/status")

  const status = page.getByTestId("operational-status")
  await expect(status.getByRole("heading", { level: 1 })).toHaveCount(1)
  await expect(status).toHaveCSS("max-width", "none")
  await expect(status).toContainText("Platform status")
  await expect(status).toContainText("2 / 3")
  await expect(status).toContainText("RecipeBot")
  await expect(status).toContainText("recipebot · session 11")
  await expect(status).toContainText("Container drift detected")
  const driftAlert = status.getByTestId("operational-drift-alert")
  await expect(driftAlert).toContainText("Service availability may be incomplete while operators restore the missing containers.")
  await expect(driftAlert.getByRole("listitem")).toHaveText(["Production container: app-recipebot"])
  await expect(status).toContainText("Deploy in progress")
  await expect(status).not.toContainText("private-model")
  await expect(status).not.toContainText("secret progress text")
  await expect(status).not.toContainText("operator-only event")
  await expect(status).not.toContainText("999,999")
  await expect(status).not.toContainText("97%")
  await expect(status).toContainText("outside this read-only React view")
  const summary = status.locator('dl[aria-label="Operational summary"]')
  await expect(summary).toHaveAttribute("data-surface", "container")
  await expect(summary.locator("dt")).toHaveCount(4)
  await expect(summary.locator("dd")).toHaveCount(4)
  await expect(summary.locator('[data-slot="card"]')).toHaveCount(0)
  await expect(status.getByRole("button", { name: "Refresh" })).toBeVisible()
  await expect(status.getByRole("button", { name: "Toggle navigation" })).toBeVisible()
  await expect(status.getByRole("button")).toHaveCount(2)
  await expect(status.getByRole("img", { name: "Node, synced" })).toBeVisible()
  await expect(status.getByRole("img", { name: "RecipeBot, running" })).toBeVisible()
  await expect(status.locator('[data-slot="badge"]')).toHaveCount(0)
})

test("explains node probe failures before exposing technical detail", async ({ page }) => {
  await page.route("**/api/status", (route) => route.fulfill({ json: {
    ...publicSnapshot,
    node: { ...publicSnapshot.node, status: "unreachable", error: "AggregateError" },
  } }))
  await page.goto("/react/status")

  const nodeCard = page.getByTestId("operational-node-card")
  await expect(nodeCard).toContainText("Node probe failed")
  await expect(nodeCard).toContainText("The node did not respond.")
  await expect(nodeCard).toContainText("Technical detail: AggregateError")
})

test("routes attention before the app wall and keeps healthy rows quiet", async ({ page }) => {
  await page.route("**/api/status", (route) => route.fulfill({ json: {
    ...publicSnapshot,
    summary: { ...publicSnapshot.summary, apps: 38, prodRunning: 38 },
    apps: denseApps,
  } }))
  await page.goto("/react/status")

  const status = page.getByTestId("operational-status")
  const rows = status.getByTestId("operational-app-row")
  const quietRows = rows.filter({ has: page.locator('[data-attention="false"]') })
  const signalRow = rows.filter({ has: page.locator('[data-attention="true"]') })
  await expect(rows).toHaveCount(38)
  await expect(quietRows).toHaveCount(37)
  await expect(signalRow).toHaveCount(1)

  const driftBox = await status.getByTestId("operational-drift-alert").boundingBox()
  const firstAppBox = await rows.first().boundingBox()
  expect(driftBox).not.toBeNull()
  expect(firstAppBox).not.toBeNull()
  expect(driftBox!.y).toBeLessThan(firstAppBox!.y)

  const nodeBox = await status.getByTestId("operational-node-card").boundingBox()
  const appsBox = await status.getByTestId("operational-apps").boundingBox()
  expect(nodeBox).not.toBeNull()
  expect(appsBox).not.toBeNull()
  expect(nodeBox!.height).toBeLessThan(appsBox!.height)

  const quietDot = quietRows.first().getByRole("img", { name: "Quiet App 01, running" })
  await expect(quietDot).toBeVisible()
  await expect(quietDot.locator('[data-status-role="neutral"]')).toHaveCount(1)
  await expect(quietRows.locator('[data-status-role="neutral"]')).toHaveCount(37)
  const quietStyles = await statusDotStyles(quietDot.locator(".status-dot"))
  expect(quietStyles.backgroundColor).toBe(quietStyles.neutralBackground)
  expect(quietStyles.borderColor).toBe(quietStyles.neutralBorder)

  const quietMetadata = quietRows.first().locator('[data-attention="false"]')
  const signalMetadata = signalRow.locator('[data-attention="true"]')
  const quietWeight = Number(await quietMetadata.evaluate((element) => getComputedStyle(element).fontWeight))
  const signalWeight = Number(await signalMetadata.evaluate((element) => getComputedStyle(element).fontWeight))
  expect(signalWeight).toBeGreaterThan(quietWeight)
  await expect(signalRow.getByRole("img", { name: "Signal App, running" })).toBeVisible()
  await expect(status.locator('[data-slot="badge"]')).toHaveCount(0)
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
