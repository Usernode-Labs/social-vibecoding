import type { Meta, StoryObj } from "@storybook/react-vite"

import { DevSavedDraftsView } from "@/features/dev/dev-saved-drafts"

const drafts = [
  { id: "draft-1", text: "Also make the header sticky when scrolling.", savedAt: "2026-07-29T00:00:00.000Z" },
  { id: "draft-2", text: "Rename the Submit button to Publish.", savedAt: "2026-07-29T00:01:00.000Z" },
]

const meta = {
  title: "Dev/Saved drafts",
  component: DevSavedDraftsView,
  args: {
    drafts,
    onDelete: () => undefined,
    onEdit: () => undefined,
    onSend: () => undefined,
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof DevSavedDraftsView>

export default meta
type Story = StoryObj<typeof meta>

export const ReadyToSend: Story = {}
export const BuilderWorking: Story = { args: { streaming: true } }
