import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, within } from "storybook/test"

import { ShellAttentionProvider } from "@/components/platform-menu-trigger"
import { SidebarProvider } from "@/components/ui/sidebar"
import { RegisterView } from "@/features/auth/register"

const meta = {
  title: "Features/Authentication/Register form",
  component: RegisterView,
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
    activationCode: "",
    error: null,
    locationHash: "",
    onSubmit: fn((event) => event.preventDefault()),
    pending: false,
  },
} satisfies Meta<typeof RegisterView>

export default meta
type Story = StoryObj<typeof meta>

export const Ready: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByLabelText("Activation code")).toHaveValue("")
    await expect(canvas.getByRole("button", { name: "Create account" })).toBeEnabled()
  },
}

export const ActivationCodeSupplied: Story = {
  args: { activationCode: "WELCOME-2026" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByLabelText("Activation code")).toHaveValue("WELCOME-2026")
  },
}

export const Pending: Story = {
  args: { pending: true },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Creating account…" })).toBeDisabled()
  },
}

export const Error: Story = {
  args: { error: "This activation code has expired." },
}

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
}
