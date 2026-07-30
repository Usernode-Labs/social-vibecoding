import type { Meta, StoryObj } from "@storybook/react-vite"

import { WalletAccessView } from "@/features/auth/wallet-access"

const meta = {
  title: "Features/Authentication/Wallet access",
  component: WalletAccessView,
  parameters: { layout: "centered" },
  args: {
    onAccountSubmit: () => undefined,
    onBack: () => undefined,
    onPasswordFallback: () => undefined,
    onRecoverySubmit: () => undefined,
    onSelect: () => undefined,
    onSignIn: () => undefined,
    pubkey: "ut1genesiswallet0123456789abcdefghijklmnopqrstuvwxyz",
  },
} satisfies Meta<typeof WalletAccessView>

export default meta
type Story = StoryObj<typeof meta>

export const Checking: Story = { args: { screen: "checking" } }
export const LinkedWallet: Story = { args: { linked: true, screen: "sign-in" } }
export const NewGenesisWallet: Story = { args: { screen: "options" } }
export const LinkExisting: Story = { args: { screen: "link" } }
export const Register: Story = { args: { screen: "register" } }
export const Recovery: Story = { args: { linked: true, screen: "recovery" } }
export const Linking: Story = {
  args: { busy: true, linkNotice: "Transaction sent. Waiting for confirmation…", screen: "linking" },
}
export const Ineligible: Story = { args: { screen: "ineligible" } }
export const LinkedNonGenesis: Story = { args: { linked: true, screen: "ineligible" } }
