import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

const snapshot = {
  server: { name: "usernode-social-vibecoding", mode: "production", version: "abcdef0", uptimeMs: 7_250_000 },
  node: { status: "Synced", peers: 3, bestTipHeight: 12480, peerBestTipHeight: 12483, hasBeenSynced: true, hasFullUtxoDb: true },
  explorer: { status: "ok", host: "testnet-explorer.usernodelabs.org", chainId: "testnet", latencyMs: 42, hasBeenOk: true },
  services: { chainPoller: { enabled: true }, genesisAccounts: { loaded: true, count: 38 } },
  at: Date.parse("2026-07-28T12:00:00.000Z"),
}

async function statusDotStyles(locator: import("@playwright/test").Locator, role: "negative" | "positive" | "warning") {
  return locator.evaluate((element, statusRole) => {
    const style = getComputedStyle(element)
    const root = getComputedStyle(document.documentElement)
    return {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      expectedBackground: root.getPropertyValue(`--status-${statusRole}-surface`).trim(),
      expectedBorder: root.getPropertyValue(`--status-${statusRole}-border`).trim(),
    }
  }, role)
}

test("renders the public node status snapshot and its chain services", async ({ page }) => {
  await page.route("**/api/node-status/full", (route) => route.fulfill({ json: snapshot }))
  await page.goto("/react/node-status")

  const status = page.getByTestId("node-status")
  await expect(status.getByRole("heading", { level: 1, name: "Node" })).toBeVisible()
  await expect(status.getByRole("heading", { level: 1 })).toHaveCount(1)
  await expect(status).toHaveCSS("max-width", "none")
  await expect(status).toContainText("12,480 / 12,483")
  await expect(status).toContainText("testnet-explorer.usernodelabs.org")
  await expect(status).toContainText("Chain-dependent services")
  await expect(status).toContainText("38 records loaded")
  await expect(status).toContainText("Production")
  await expect(status.getByRole("img", { name: "Node, synced" })).toBeVisible()
  await expect(status.getByRole("img", { name: "Explorer, available" })).toBeVisible()
  await expect(status.getByRole("img", { name: "Chain poller, enabled" })).toBeVisible()
  await expect(status.getByRole("img", { name: "Genesis accounts, loaded" })).toBeVisible()
  await expect(status.locator('[data-slot="badge"]')).toHaveCount(0)
})

test("makes probe failures explicit without hiding the other snapshot data", async ({ page }) => {
  await page.route("**/api/node-status/full", (route) => route.fulfill({ json: { ...snapshot, node: { ...snapshot.node, status: "unreachable", hasFullUtxoDb: false, error: "request timeout" }, explorer: { ...snapshot.explorer, status: "unreachable", error: "connection refused" } } }))
  await page.goto("/react/node-status")

  const status = page.getByTestId("node-status")
  await expect(status).toContainText("Partial UTXO database")
  await expect(status).toContainText("Node unavailable")
  await expect(status).toContainText("The node did not respond.")
  await expect(status).toContainText("Technical detail: request timeout")
  await expect(status).toContainText("Explorer unavailable")
  await expect(status).toContainText("The explorer did not respond.")
  await expect(status).toContainText("Technical detail: connection refused")
  const explorerStatus = status.getByRole("img", { name: "Explorer, unavailable" })
  await expect(explorerStatus).toBeVisible()
  const explorerDot = explorerStatus.locator('[data-status-role="negative"]')
  await expect(explorerDot).toHaveCount(1)
  const styles = await statusDotStyles(explorerDot, "negative")
  expect(styles.backgroundColor).toBe(styles.expectedBackground)
  expect(styles.borderColor).toBe(styles.expectedBorder)
  await expect(status.locator('[data-slot="badge"]')).toHaveCount(0)
})

test("renders unknown service states explicitly", async ({ page }) => {
  await page.route("**/api/node-status/full", (route) => route.fulfill({ json: {
    ...snapshot,
    services: { ...snapshot.services, anomalyProbe: { status: "brand_new_state" } },
  } }))
  await page.goto("/react/node-status")

  const status = page.getByTestId("node-status")
  const unknownStatus = status.getByRole("img", { name: "Anomaly probe, unknown" })
  await expect(unknownStatus).toBeVisible()
  const unknownDot = unknownStatus.locator('[data-status-role="warning"]')
  await expect(unknownDot).toHaveCount(1)
  const styles = await statusDotStyles(unknownDot, "warning")
  expect(styles.backgroundColor).toBe(styles.expectedBackground)
  expect(styles.borderColor).toBe(styles.expectedBorder)
  await expect(status.locator('[data-slot="badge"]')).toHaveCount(0)
})

test("renders a request error when the public status service is unavailable", async ({ page }) => {
  await page.route("**/api/node-status/full", (route) => route.fulfill({ status: 503, json: { error: "unavailable" } }))
  await page.goto("/react/node-status")

  await expect(page.getByTestId("node-status")).toContainText("Status unavailable")
  await expect(page.getByTestId("node-status")).toContainText("Request failed (503)")
})

test("has no critical or serious accessibility violations", async ({ page }) => {
  await page.route("**/api/node-status/full", (route) => route.fulfill({ json: snapshot }))
  await page.goto("/react/node-status")
  await expect(page.getByTestId("node-status").getByRole("heading", { level: 1, name: "Node" })).toBeVisible()
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})
