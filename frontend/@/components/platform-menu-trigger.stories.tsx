import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"

import {
  PlatformMenuTrigger,
  ShellAttentionProvider,
} from "@/components/platform-menu-trigger"
import { SidebarProvider } from "@/components/ui/sidebar"

function TriggerFixture({ count }: { count: number }) {
  return (
    <SidebarProvider>
      <ShellAttentionProvider count={count}>
        <PlatformMenuTrigger />
      </ShellAttentionProvider>
    </SidebarProvider>
  )
}

const meta = {
  title: "Blocks/Shell/Platform menu trigger",
  component: PlatformMenuTrigger,
  parameters: { layout: "centered" },
} satisfies Meta<typeof PlatformMenuTrigger>

export default meta
type Story = StoryObj<typeof meta>

export const Idle: Story = {
  render: () => <TriggerFixture count={0} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole("button", { name: "Toggle navigation" })).toBeTruthy()
    await expect(canvas.queryByRole("img", { name: "Activity, needs attention" })).toBeNull()
  },
}

export const NeedsAttention: Story = {
  render: () => <TriggerFixture count={3} />,
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("img", { name: "Activity, needs attention" })
    ).toBeTruthy()
  },
}
