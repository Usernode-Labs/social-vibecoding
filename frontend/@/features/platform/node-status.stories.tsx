import type { Meta, StoryObj } from "@storybook/react-vite"

import { NodeStatusContent } from "@/features/platform/node-status"

const snapshot = {
  server: { name: "usernode-social-vibecoding", mode: "production", version: "abcdef0", uptimeMs: 7_250_000 },
  node: { status: "Synced", peers: 3, bestTipHeight: 12480, peerBestTipHeight: 12483, hasBeenSynced: true, hasFullUtxoDb: true },
  explorer: { status: "ok", host: "testnet-explorer.usernodelabs.org", chainId: "testnet", latencyMs: 42, hasBeenOk: true },
  services: { chainPoller: { enabled: true }, genesisAccounts: { loaded: true, count: 38 } },
  at: Date.parse("2026-07-28T12:00:00.000Z"),
}

const meta = {
  title: "Features/Platform/Node status",
  component: NodeStatusContent,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="mx-auto max-w-5xl"><Story /></div>],
} satisfies Meta<typeof NodeStatusContent>

export default meta
type Story = StoryObj<typeof meta>

export const Healthy: Story = { args: { snapshot } }
export const PartialAndOffline: Story = { args: { snapshot: { ...snapshot, node: { ...snapshot.node, status: "unreachable", hasFullUtxoDb: false, error: "request timeout" }, explorer: { ...snapshot.explorer, status: "unreachable", error: "connection refused" } } } }
