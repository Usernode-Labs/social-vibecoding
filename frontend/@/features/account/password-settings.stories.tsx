import type { Meta, StoryObj } from "@storybook/react-vite"

import { PasswordSettings } from "@/features/account/password-settings"

function installSigningBridge() {
  Object.defineProperty(window, "usernode", {
    configurable: true,
    value: {
      isNative: true,
      getBridgeInfo: async () => ({
        version: 3,
        capabilities: ["getNodeAddress", "signMessage"],
      }),
    },
  })
  Object.defineProperty(window, "signMessage", {
    configurable: true,
    value: async () => ({
      publicKey: "abcdef0123456789abcdef0123456789",
      signature: "deterministic-story-signature",
    }),
  })
}

function PasswordOnlySurface() {
  delete (window as Window & { usernode?: unknown }).usernode
  return <PasswordSettings walletPubkey={null} />
}

function LinkedWalletSurface() {
  installSigningBridge()
  return <PasswordSettings walletPubkey="abcdef0123456789abcdef0123456789" />
}

const meta = {
  title: "Blocks/Account/Password settings",
  component: PasswordSettings,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="mx-auto max-w-3xl"><Story /></div>],
  args: { walletPubkey: null },
} satisfies Meta<typeof PasswordSettings>

export default meta
type Story = StoryObj<typeof meta>

export const CurrentPassword: Story = {
  render: () => <PasswordOnlySurface />,
}

export const LinkedWallet: Story = {
  render: () => <LinkedWalletSurface />,
}

export const ReadOnly: Story = {
  render: () => <PasswordSettings readOnly walletPubkey={null} />,
}
