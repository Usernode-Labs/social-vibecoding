import type { Meta, StoryObj } from "@storybook/react-vite"
import { ArrowRight, Bell, LoaderCircle } from "lucide-react"
import { expect, userEvent, within } from "storybook/test"

import { PlatformIcon } from "@/components/platform-icon"
import { Button } from "@/components/ui/button"

const meta = {
  title: "Elements/Primitives/Button",
  component: Button,
  parameters: { layout: "centered" },
  args: { children: "Continue" },
} satisfies Meta<typeof Button>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Variants: Story = {
  render: () => (
    <div className="flex max-w-xl flex-wrap items-center gap-3">
      <Button>Default</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="destructive">Delete</Button>
      <Button variant="link">Learn more</Button>
    </div>
  ),
}

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button size="xs">Extra small</Button>
      <Button size="sm">Small</Button>
      <Button>Default</Button>
      <Button size="lg">Large</Button>
    </div>
  ),
}

export const WithIcons: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button>
        Continue
        <PlatformIcon data-icon="inline-end" icon={ArrowRight} />
      </Button>
      <Button aria-label="Open activity" size="icon" variant="outline">
        <PlatformIcon icon={Bell} />
      </Button>
    </div>
  ),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Open activity" })).toBeTruthy()
  },
}

export const Pending: Story = {
  render: () => (
    <Button disabled>
      <PlatformIcon className="animate-spin" data-icon="inline-start" icon={LoaderCircle} />
      Saving…
    </Button>
  ),
}

export const Disabled: Story = {
  args: { children: "Unavailable", disabled: true },
}

export const KeyboardFocus: Story = {
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole("button", { name: "Continue" })
    await userEvent.tab()
    await expect(button).toHaveFocus()
  },
}
