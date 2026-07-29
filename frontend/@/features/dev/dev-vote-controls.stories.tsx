import type { Meta, StoryObj } from "@storybook/react-vite"

import { DevVoteControls } from "@/features/dev/dev-vote-controls"

const meta = {
  title: "Dev/Vote controls",
  component: DevVoteControls,
  parameters: { layout: "padded" },
} satisfies Meta<typeof DevVoteControls>

export default meta
type Story = StoryObj<typeof meta>

export const ProposalNeedsVote: Story = {
  args: { kind: "proposal", yesCount: 2, noCount: 1, required: 4, selectedVote: null, onVote: () => undefined },
}

export const GovernanceVoteSelected: Story = {
  args: { kind: "governance", yesCount: 3, noCount: 0, required: 4, selectedVote: "up", onVote: () => undefined },
}

export const Recording: Story = {
  args: { kind: "proposal", yesCount: 2, noCount: 1, required: 4, selectedVote: "yes", pending: true, onVote: () => undefined },
}

export const ReadOnly: Story = {
  args: { kind: "governance", yesCount: 1, noCount: 0, required: 3, disabled: true, onVote: () => undefined },
}
