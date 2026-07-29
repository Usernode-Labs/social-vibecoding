import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

async function expectFullCanvasRoute(page: import("@playwright/test").Page, testId: string, title: string) {
  const route = page.getByTestId(testId)
  await expect(route.getByRole("heading", { level: 1, name: title })).toBeVisible()
  await expect(route.locator("h1")).toHaveCount(1)
  await expect.poll(() => route.evaluate((element) => getComputedStyle(element).maxWidth)).toBe("none")
}

test("explains the native capability boundary outside Usernode", async ({ page }) => {
  await page.goto("/react/account")

  await expectFullCanvasRoute(page, "account", "Account")
  await expect(page.getByTestId("account")).toContainText("Profile and rewards")
  await expect(page.getByTestId("native-device-unavailable")).toContainText("Open in Usernode")
  await expect(page.getByRole("link", { name: "View node status" })).toHaveAttribute("href", "/react/node-status")
})

test("shows native wallet and node data without deriving it in the web shell", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "usernode", {
      configurable: true,
      value: {
        getBridgeInfo: async () => ({ version: 3, capabilities: ["getNodeStatus", "getWalletState", "openNativeScreen"] }),
        getNodeStatus: async () => ({ status: "synced", localBestHeight: 12480, networkBestHeight: 12483, connectedPeers: 3, totalPeers: 8 }),
        getWalletState: async () => ({ address: "ut1verylongwalletaddress0000000000001", tokenAmount: 12.5, tokenSymbol: "UT", lastUpdatedMs: Date.parse("2026-07-28T12:00:00.000Z") }),
        openNativeScreen: async (screen: string) => { window.localStorage.setItem("opened-native-screen", screen); return true },
      },
    })
  })
  await page.goto("/react/account")

  const summary = page.getByTestId("native-device-summary")
  await expect(summary).toContainText("12.5 UT")
  await expect(summary).toContainText("12,480 / 12,483")
  await expect(summary).toContainText("ut1verylon…000001")
  await summary.getByRole("button", { name: "Open Usernode settings" }).click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem("opened-native-screen"))).toBe("settings")
})

test("updates only node status from the native push event", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "usernode", {
    configurable: true,
    value: {
      getBridgeInfo: async () => ({ version: 3, capabilities: ["getNodeStatus", "getWalletState"] }),
      getNodeStatus: async () => ({ status: "connecting", connectedPeers: 0, totalPeers: 8 }),
      getWalletState: async () => ({ address: "ut1address", tokenAmount: 4, tokenSymbol: "UT" }),
    },
  }))
  await page.goto("/react/account")
  await expect(page.getByTestId("native-device-summary")).toContainText("Connecting")

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("usernode:node-status", { detail: { status: "synced", connectedPeers: 3, totalPeers: 8 } })))
  await expect(page.getByTestId("native-device-summary")).toContainText("Synced")
})

test("has no critical or serious accessibility violations for an available native device", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "usernode", {
    configurable: true,
    value: {
      getBridgeInfo: async () => ({ version: 3, capabilities: ["getNodeStatus", "getWalletState"] }),
      getNodeStatus: async () => ({ status: "synced", connectedPeers: 3, totalPeers: 8 }),
      getWalletState: async () => ({ address: "ut1address", tokenAmount: 4, tokenSymbol: "UT" }),
    },
  }))
  await page.goto("/react/account")
  await expect(page.getByTestId("native-device-summary")).toBeVisible()
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([])
})
