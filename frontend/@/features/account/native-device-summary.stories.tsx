import type { Meta, StoryObj } from "@storybook/react-vite"

import { NativeDeviceSummary } from "@/features/account/native-device-summary"

const meta = {
  title: "Account/Native device summary",
  component: NativeDeviceSummary,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="mx-auto max-w-3xl"><Story /></div>],
} satisfies Meta<typeof NativeDeviceSummary>

export default meta
type Story = StoryObj<typeof meta>

export const Loading: Story = { args: { state: { kind: "loading" } } }
export const OutsideUsernode: Story = { args: { state: { kind: "unavailable" } } }
export const Ready: Story = { args: { state: { kind: "ready", info: { version: 3, capabilities: ["getNodeStatus", "getWalletState", "openNativeScreen"] }, node: { status: "synced", localBestHeight: 12480, networkBestHeight: 12483, connectedPeers: 3, totalPeers: 8 }, wallet: { address: "ut1exampleusernodewalletaddress123456", tokenAmount: 1284.25, tokenSymbol: "UT", lastUpdatedMs: Date.parse("2026-07-28T12:00:00.000Z") } } } }
