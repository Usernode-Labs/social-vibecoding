import type { Meta, StoryObj } from "@storybook/react-vite"

import { Separator } from "@/components/ui/separator"

const meta = {
  title: "Elements/Primitives/Separator",
  component: Separator,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Separator>

export default meta
type Story = StoryObj<typeof meta>

export const Horizontal: Story = {
  render: () => <div className="flex w-80 flex-col gap-3"><p className="text-sm">Account</p><Separator /><p className="text-sm text-muted-foreground">Security settings</p></div>,
}

export const Vertical: Story = {
  render: () => <div className="flex h-6 items-center gap-3 text-sm"><span>List</span><Separator orientation="vertical" /><span>Board</span><Separator orientation="vertical" /><span>Timeline</span></div>,
}
