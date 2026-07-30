import type { Meta, StoryObj } from "@storybook/react-vite"
import { Bell, ExternalLink, Search, Trophy } from "lucide-react"

import { PlatformIcon } from "@/components/platform-icon"

const meta = {
  title: "Elements/Platform icon",
  component: PlatformIcon,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="flex items-center gap-4 rounded-lg border p-4"><Story /></div>],
} satisfies Meta<typeof PlatformIcon>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = { args: { icon: Trophy, "aria-label": "Trophy" } }
export const SmallInline: Story = { args: { icon: ExternalLink, size: "sm", "aria-label": "Open externally" } }
export const Control: Story = { args: { icon: Bell, size: "md", "aria-label": "Notifications" } }
export const LargeFeature: Story = { args: { icon: Search, size: "lg", "aria-label": "Search" } }
