export type NativeBridgeFixture = {
  name: string
  expectedState: "unavailable" | "unsupported" | "ready"
  bridgeInfo?: { version: number; capabilities: string[] }
  node?: Record<string, unknown>
  wallet?: Record<string, unknown>
}

/**
 * Deterministic substitutes for the native producer. They exercise the web
 * adapter's compatibility boundary; they do not simulate or certify Flutter.
 */
export const nativeBridgeFixtures: NativeBridgeFixture[] = [
  {
    name: "desktop-no-bridge",
    expectedState: "unavailable",
  },
  {
    name: "old-native-build",
    expectedState: "unsupported",
    bridgeInfo: { version: 2, capabilities: [] },
  },
  {
    name: "current-native-build",
    expectedState: "ready",
    bridgeInfo: { version: 3, capabilities: ["getNodeStatus", "getWalletState", "openNativeScreen"] },
    node: { status: "synced", localBestHeight: 12480, networkBestHeight: 12483, connectedPeers: 3, totalPeers: 8 },
    wallet: { address: "ut1fixturewalletaddress0000000000001", tokenAmount: 12.5, tokenSymbol: "UT", lastUpdatedMs: Date.parse("2026-07-28T12:00:00.000Z") },
  },
]
