import { expect, test } from "@playwright/test"

import { nativeBridgeFixtures } from "./fixtures/native-bridge"

const expectNativeState = expect.configure({ timeout: 10_000 })

for (const fixture of nativeBridgeFixtures) {
  test(`native bridge contract: ${fixture.name}`, async ({ page }) => {
    if (fixture.bridgeInfo) {
      await page.addInitScript((bridge) => {
        Object.defineProperty(window, "usernode", {
          configurable: true,
          value: {
            isNative: true,
            getBridgeInfo: async () => bridge.bridgeInfo,
            getNodeStatus: async () => {
              ;(window as Window & { nativeBridgeUnexpectedNodeCall?: boolean }).nativeBridgeUnexpectedNodeCall = true
              return bridge.node ?? null
            },
            getWalletState: async () => bridge.wallet ?? null,
            openNativeScreen: async () => true,
          },
        })
      }, fixture)
    }

    await page.goto("/react/account")

    if (fixture.expectedState === "unavailable") {
      await expectNativeState(page.getByTestId("native-device-unavailable")).toBeVisible()
      return
    }
    if (fixture.expectedState === "unsupported") {
      await expectNativeState(page.getByTestId("native-device-unsupported")).toContainText("Update Usernode")
      await expect.poll(() => page.evaluate(() => (window as Window & { nativeBridgeUnexpectedNodeCall?: boolean }).nativeBridgeUnexpectedNodeCall === true)).toBe(false)
      return
    }

    await expectNativeState(page.getByTestId("native-device-summary")).toContainText("12.5 UT")
    await expectNativeState(page.getByTestId("native-device-summary")).toContainText("12,480 / 12,483")
  })
}

test("native bridge contract: malformed capability response is fail-closed", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "usernode", {
      configurable: true,
      value: { isNative: true, getBridgeInfo: async () => ({ version: 3, capabilities: "getWalletState" }) },
    })
  })

  await page.goto("/react/account")
  await expectNativeState(page.getByTestId("native-device-unavailable")).toBeVisible()
})
