import type { Meta, StoryObj } from "@storybook/react-vite"
import { Bot, CalendarClock } from "lucide-react"

import { PlatformIcon } from "@/components/platform-icon"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"

const meta = {
  title: "Elements/Conversation/Marker",
  component: Marker,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="w-screen max-w-xl px-4"><Story /></div>],
} satisfies Meta<typeof Marker>

export default meta
type Story = StoryObj<typeof meta>

export const Status: Story = {
  render: () => <Marker><MarkerIcon><PlatformIcon icon={Bot} /></MarkerIcon><MarkerContent>Builder is responding…</MarkerContent></Marker>,
}

export const Separator: Story = {
  render: () => <Marker variant="separator"><MarkerContent>Today</MarkerContent></Marker>,
}

export const Border: Story = {
  render: () => <Marker variant="border"><MarkerIcon><PlatformIcon icon={CalendarClock} /></MarkerIcon><MarkerContent>Session resumed at 09:42</MarkerContent></Marker>,
}
