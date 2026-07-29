import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

const snapshot = {
  server: { name: "usernode-social-vibecoding", mode: "production", version: "abcdef0", uptimeMs: 7_250_000 },
  node: { status: "Synced", peers: 3, bestTipHeight: 12480, peerBestTipHeight: 12483, hasBeenSynced: true, hasFullUtxoDb: true },
  explorer: { status: "ok", host: "testnet-explorer.usernodelabs.org", chainId: "testnet", latencyMs: 42, hasBeenOk: true },
  services: { chainPoller: { enabled: true }, genesisAccounts: { loaded: true, count: 38 } },
  at: Date.parse("2026-07-28T12:00:00.000Z"),
}

test("renders the public node status snapshot and its chain services", async ({ page }) => {
  await page.route("**/api/node-status/full", (route) => route.fulfill({ json: snapshot }))
  await page.goto("/react/node-status")

  const status = page.getByTestId("node-status")
  await expect(status).toContainText("Node status")
  await expect(status).toContainText("12,480 / 12,483")
  await expect(status).toContainText("testnet-explorer.usernodelabs.org")
  await expect(status).toContainText("Chain-dependent services")
  await expect(status).toContainText("38 records loaded")
})

test("makes probe failures explicit without hiding the other snapshot data", async ({ page }) => {
  await page.route("**/api/node-status/full", (route) => route.fulfill({ json: { ...snapshot, node: { ...snapshot.node, status: "unreachable", hasFullUtxoDb: false, error: "request timeout" }, explorer: { ...snapshot.explorer, status: "unreachable", error: "connection refused" } } }))
  await page.goto("/react/node-status")

  const status = page.getByTestId("node-status")
  await expect(status).toContainText("Partial UTXO database")
  await expect(status).toContainText("Node probe failed")
  await expect(status).toContainText("Explorer probe failed")
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
  await expect(page.getByTestId("node-status")).toContainText("Node status")
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})
