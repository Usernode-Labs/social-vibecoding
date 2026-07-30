import type { Meta, StoryObj } from "@storybook/react-vite"

import { ThemeSwitcherView } from "@/components/theme-switcher"

const meta = {
  title: "Blocks/Settings/Theme switcher",
  component: ThemeSwitcherView,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="w-64 rounded-lg border bg-background p-4 text-foreground"><Story /></div>],
} satisfies Meta<typeof ThemeSwitcherView>

export default meta
type Story = StoryObj<typeof meta>

export const LightSelected: Story = {
  args: { preference: "light", effectiveMode: "light", onPreferenceChange: () => undefined },
}

export const DarkSelected: Story = {
  args: { preference: "dark", effectiveMode: "dark", onPreferenceChange: () => undefined },
}

export const SystemSelected: Story = {
  args: { preference: "system", effectiveMode: "dark", onPreferenceChange: () => undefined },
}
