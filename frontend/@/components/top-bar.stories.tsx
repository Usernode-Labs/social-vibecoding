import type { Meta, StoryObj } from "@storybook/react-vite"
import { CheckCheck, Search } from "lucide-react"
import { expect, within } from "storybook/test"

import { ShellAttentionProvider } from "@/components/platform-menu-trigger"
import { PlatformIcon } from "@/components/platform-icon"
import { TopBar, type TopBarProps } from "@/components/top-bar"
import { Button } from "@/components/ui/button"
import { SidebarProvider } from "@/components/ui/sidebar"

function BarFixture({
  attention = 0,
  ...props
}: TopBarProps & { attention?: number }) {
  return (
    <SidebarProvider>
      <ShellAttentionProvider count={attention}>
        <div className="relative min-h-40 w-full">
          <TopBar {...props} />
          <p className="p-4 text-sm text-muted-foreground">
            Route content starts immediately below the bar.
          </p>
        </div>
      </ShellAttentionProvider>
    </SidebarProvider>
  )
}

const meta = {
  title: "Blocks/Shell/Top bar",
  component: TopBar,
  parameters: { layout: "fullscreen" },
  args: { title: "Explore" },
  render: (args) => <BarFixture {...args} />,
} satisfies Meta<typeof TopBar>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole("heading", { level: 1, name: "Explore" })).toBeTruthy()
    await expect(canvas.getAllByRole("heading", { level: 1 })).toHaveLength(1)
    await expect(canvas.getByRole("button", { name: "Toggle navigation" })).toBeTruthy()
  },
}

export const WithAttention: Story = {
  args: { title: "Home" },
  render: (args) => <BarFixture {...args} attention={3} />,
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("img", { name: "Activity, needs attention" })
    ).toBeTruthy()
  },
}

export const WithAction: Story = {
  args: {
    title: "Activity",
    action: (
      <Button size="sm" type="button" variant="outline">
        <PlatformIcon data-icon="inline-start" icon={CheckCheck} />
        Mark all read
      </Button>
    ),
  },
}

export const WithIconAction: Story = {
  args: {
    title: "Explore",
    action: (
      <Button
        aria-label="Search apps"
        className="size-12"
        title="Search apps"
        type="button"
        variant="ghost"
      >
        <PlatformIcon icon={Search} />
      </Button>
    ),
  },
}

export const NestedBack: Story = {
  args: { title: "Challenge: Spring Sprint", onBack: () => {} },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const trailing = canvasElement.querySelector('[data-slot="top-bar-action"]')
    await expect(trailing).toBeTruthy()
    await expect(within(trailing as HTMLElement).getByRole("button", { name: "Back" })).toBeTruthy()
    await expect(canvas.getAllByRole("heading", { level: 1 })).toHaveLength(1)
  },
}

export const LongTitle: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  args: {
    title:
      "A deliberately very long nested route title that must remain complete before utilities",
    onBack: () => {},
    action: (
      <Button size="sm" type="button" variant="outline">
        Act
      </Button>
    ),
  },
  play: async ({ canvasElement }) => {
    const title = within(canvasElement).getByRole("heading", { level: 1 })
    const style = getComputedStyle(title)
    await expect(style.overflow).toBe("visible")
    await expect(style.whiteSpace).toBe("normal")
    await expect(title.scrollWidth).toBeLessThanOrEqual(title.clientWidth)
    const trailing = canvasElement.querySelector('[data-slot="top-bar-action"]')
    const identity = canvasElement.querySelector('[data-slot="top-bar-identity"]')
    await expect(trailing).toBeTruthy()
    await expect(identity).toBeTruthy()
    await expect(trailing!.getBoundingClientRect().top).toBeGreaterThanOrEqual(identity!.getBoundingClientRect().bottom)
    await expect(within(trailing as HTMLElement).getByRole("button", { name: "Back" })).toBeTruthy()
  },
}

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  args: { title: "Home" },
}

export const Dark: Story = {
  globals: { theme: "dark" },
  args: { title: "Work" },
  render: (args) => <BarFixture {...args} attention={2} />,
}
