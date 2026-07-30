import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"

import { DevSessionActivity } from "@/features/dev/dev-session-activity"
import type { DevSessionStatus } from "@/lib/dev-chat-api"

const working = {
  busy: true,
  phase: "cc",
  progress: [{ text: "Reviewing the component graph" }],
  estimate: { text: "About two minutes", remainingSeconds: 120 },
  resolving: false,
  sync: null,
} satisfies DevSessionStatus

const meta = {
  title: "Blocks/Dev/Session activity",
  component: DevSessionActivity,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="mx-auto max-w-2xl"><Story /></div>],
  args: { status: working },
} satisfies Meta<typeof DevSessionActivity>

export default meta
type Story = StoryObj<typeof meta>

export const Working: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Reviewing the component graph")).toBeTruthy()
  },
}

export const ResolvingConflicts: Story = {
  args: {
    status: { ...working, progress: [], resolving: true },
  },
}

export const Syncing: Story = {
  args: {
    status: { ...working, busy: false, progress: [], sync: { phase: "fetching" } },
  },
}

export const Idle: Story = {
  args: { status: null },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByText("Current activity")).toBeNull()
  },
}
