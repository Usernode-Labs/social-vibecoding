import type { Meta, StoryObj } from "@storybook/react-vite"
import { CircleCheck } from "lucide-react"

import { PlatformIcon } from "@/components/platform-icon"
import { Badge } from "@/components/ui/badge"

const meta = {
  title: "Elements/Primitives/Badge",
  component: Badge,
  parameters: { layout: "centered" },
  args: { children: "Running" },
} satisfies Meta<typeof Badge>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Badge>Default</Badge>
      <Badge variant="secondary">Secondary</Badge>
      <Badge variant="outline">Outline</Badge>
      <Badge variant="ghost">Ghost</Badge>
      <Badge variant="destructive">Destructive</Badge>
      <Badge variant="link">Link</Badge>
    </div>
  ),
}
export const WithIcon: Story = {
  render: () => <Badge variant="secondary"><PlatformIcon data-icon="inline-start" icon={CircleCheck} size="xs" />Ready</Badge>,
}
