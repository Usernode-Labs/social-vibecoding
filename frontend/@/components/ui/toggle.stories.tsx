import type { Meta, StoryObj } from "@storybook/react-vite"
import { Bell } from "lucide-react"
import { expect, userEvent, within } from "storybook/test"

import { PlatformIcon } from "@/components/platform-icon"
import { Toggle } from "@/components/ui/toggle"

const meta = {
  title: "Elements/Primitives/Toggle",
  component: Toggle,
  parameters: { layout: "centered" },
  args: { children: "Notifications" },
} satisfies Meta<typeof Toggle>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Pressed: Story = { args: { defaultPressed: true } }
export const Outline: Story = { args: { variant: "outline" } }
export const WithIcon: Story = { args: { children: <><PlatformIcon data-icon="inline-start" icon={Bell} />Notifications</> } }
export const Disabled: Story = { args: { disabled: true } }
export const Interaction: Story = {
  play: async ({ canvasElement }) => {
    const toggle = within(canvasElement).getByRole("button", { name: "Notifications" })
    await userEvent.click(toggle)
    await expect(toggle).toHaveAttribute("aria-pressed", "true")
  },
}
