import type { Meta, StoryObj } from "@storybook/react-vite"

import { ThemeSwitcherView } from "@/components/theme-switcher"

const meta = {
  title: "Foundation/Theme switcher",
  component: ThemeSwitcherView,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="w-64 rounded-lg border bg-background p-4 text-foreground"><Story /></div>],
} satisfies Meta<typeof ThemeSwitcherView>

export default meta
type Story = StoryObj<typeof meta>

export const LightSelected: Story = {
  args: { mode: "light", onModeChange: () => undefined },
}

export const DarkSelected: Story = {
  args: { mode: "dark", onModeChange: () => undefined },
}
