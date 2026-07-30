import type { Meta, StoryObj } from "@storybook/react-vite"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const meta = {
  title: "Elements/Primitives/Label",
  component: Label,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Label>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => <div className="grid w-72 gap-2"><Label htmlFor="label-name">App name</Label><Input id="label-name" /></div>,
}

export const DisabledPeer: Story = {
  render: () => <div className="grid w-72 gap-2"><Label htmlFor="label-disabled">Repository</Label><Input disabled id="label-disabled" value="Unavailable" readOnly /></div>,
}
