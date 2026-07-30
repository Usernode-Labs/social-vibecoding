import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, within } from "storybook/test"

import { ShellAttentionProvider } from "@/components/platform-menu-trigger"
import { SidebarProvider } from "@/components/ui/sidebar"
import { LoginPasswordView } from "@/features/auth/login"

const meta = {
  title: "Features/Authentication/Login form",
  component: LoginPasswordView,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <SidebarProvider>
        <ShellAttentionProvider count={0}>
          <div className="flex min-h-screen flex-col"><Story /></div>
        </ShellAttentionProvider>
      </SidebarProvider>
    ),
  ],
  args: {
    error: null,
    locationHash: "",
    onRecovery: fn(),
    onSubmit: fn((event) => event.preventDefault()),
    onWallet: fn(),
    pending: false,
    walletDetected: false,
  },
} satisfies Meta<typeof LoginPasswordView>

export default meta
type Story = StoryObj<typeof meta>

export const Ready: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole("form")).toBeTruthy()
    await expect(canvas.getByRole("button", { name: "Log in" })).toBeEnabled()
  },
}

export const WalletAvailable: Story = {
  args: { walletDetected: true },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Use Usernode wallet" })).toBeTruthy()
  },
}

export const Pending: Story = {
  args: { pending: true },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Logging in…" })).toBeDisabled()
  },
}

export const Error: Story = {
  args: { error: "Username or password is incorrect." },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Username or password is incorrect.")).toBeTruthy()
  },
}

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
}
