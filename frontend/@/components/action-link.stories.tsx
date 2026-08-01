import type { Meta, StoryObj } from "@storybook/react-vite"
import { ArrowRight, ExternalLink } from "lucide-react"
import { expect, within } from "storybook/test"

import { ActionAnchor, ActionLink } from "@/components/action-link"
import { PlatformIcon } from "@/components/platform-icon"

const meta = {
  title: "Elements/Action link",
  component: ActionLink,
  args: {
    children: "Open activity",
    to: "/notifications",
    variant: "outline",
  },
} satisfies Meta<typeof ActionLink>

export default meta
type Story = StoryObj<typeof meta>

export const InternalOutline: Story = {
  render: () => <ActionLink size="sm" to="/notifications" variant="outline">Open activity<PlatformIcon data-icon="inline-end" icon={ArrowRight} /></ActionLink>,
  play: async ({ canvasElement }) => {
    const link = within(canvasElement).getByRole("link", { name: "Open activity" })
    await expect(link).toHaveAttribute("href", "/notifications")
    await expect(link.tagName).toBe("A")
    const icon = link.querySelector('[data-slot="platform-icon"]')
    await expect(getComputedStyle(icon!).width).toBe("16px")
    await expect(getComputedStyle(icon!).height).toBe("16px")
  },
}

export const InternalPrimary: Story = {
  args: { children: "Continue", variant: "default" },
}

export const Disabled: Story = {
  args: { children: "Unavailable", disabled: true },
  play: async ({ canvasElement }) => {
    const link = within(canvasElement).getByText("Unavailable")
    await expect(link).toHaveAttribute("aria-disabled", "true")
    await expect(link).toHaveAttribute("tabindex", "-1")
  },
}

export const External: Story = {
  render: () => (
    <ActionAnchor href="https://example.com" rel="noreferrer" target="_blank">
      Open source
      <PlatformIcon data-icon="inline-end" icon={ExternalLink} />
    </ActionAnchor>
  ),
  play: async ({ canvasElement }) => {
    const link = within(canvasElement).getByRole("link", { name: "Open source" })
    const icon = link.querySelector('[data-slot="platform-icon"]')
    await expect(getComputedStyle(icon!).width).toBe("16px")
    await expect(getComputedStyle(icon!).height).toBe("16px")
  },
}
