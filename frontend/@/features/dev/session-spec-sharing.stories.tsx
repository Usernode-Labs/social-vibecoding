import type { Meta, StoryObj } from "@storybook/react-vite"

import { SpecSharingControls } from "@/features/dev/session-spec-viewer"

const meta = {
  title: "Dev/Session spec sharing",
  component: SpecSharingControls,
  parameters: { layout: "padded" },
  args: {
    mentionSuggestions: ["Mira", "Sam", "Ava"],
    onShareGroup: async () => {},
    onShareUser: async (username: string) => ({ ok: true as const, recipient: { username } }),
    version: 3,
  },
} satisfies Meta<typeof SpecSharingControls>

export default meta
type Story = StoryObj<typeof meta>

export const Available: Story = {}
export const SharedToGroup: Story = { args: { alreadyShared: true } }
export const ProductionReview: Story = { args: { disabled: true } }
