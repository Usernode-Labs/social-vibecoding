import type { Meta, StoryObj } from "@storybook/react-vite"

import { WalletLinkSettingsView } from "@/features/account/wallet-link-settings"

const request = {
  expiresAt: new Date(Date.now() + 8 * 60 * 1000).toISOString(),
  qr: {
    type: "tx" as const,
    to: "usernode-platform-address",
    amount: 1,
    memo: JSON.stringify({ app: "vibecode", type: "link_wallet", token: "single-use-demo-token" }),
    confirmTitle: "Link Wallet",
    confirmSubtitle: "Link your Usernode wallet to your Social Vibecoding account.",
  },
}

const meta = {
  title: "Account/Wallet link settings",
  component: WalletLinkSettingsView,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="mx-auto max-w-3xl"><Story /></div>],
  args: { onCancel: () => undefined, onCopy: () => undefined, onRetry: () => undefined, onStart: () => undefined },
} satisfies Meta<typeof WalletLinkSettingsView>

export default meta
type Story = StoryObj<typeof meta>

export const LinkAvailable: Story = {
  args: { phase: { kind: "unlinked" } },
}

export const AwaitingQr: Story = {
  args: { phase: { kind: "awaiting", delivery: "qr", request, remainingSeconds: 472 } },
}

export const AwaitingNative: Story = {
  args: { phase: { kind: "awaiting", delivery: "native", request, remainingSeconds: 472 } },
}

export const Linked: Story = {
  args: {
    phase: {
      kind: "linked",
      pubkey: "abcdef0123456789abcdef0123456789abcdef0123456789",
    },
  },
}

export const Error: Story = {
  args: { phase: { kind: "error", message: "The wallet link request expired. Start a new request." } },
}

export const ReadOnly: Story = {
  args: { phase: { kind: "unlinked" }, readOnly: true },
}
