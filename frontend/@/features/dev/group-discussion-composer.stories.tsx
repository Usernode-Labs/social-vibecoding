import type { Meta, StoryObj } from "@storybook/react-vite"

import { GroupDiscussionComposer } from "@/features/dev/group-discussion"

const meta = {
  title: "Dev/Group discussion composer",
  component: GroupDiscussionComposer,
  parameters: { layout: "fullscreen" },
  decorators: [(Story) => <div className="mx-auto min-h-dvh max-w-3xl bg-background p-4 sm:p-8"><Story /></div>],
  args: {
    disabled: false,
    onSend: () => undefined,
    slug: "recipebot",
    writable: true,
  },
} satisfies Meta<typeof GroupDiscussionComposer>

export default meta
type Story = StoryObj<typeof meta>

export const Ready: Story = {}

export const Replying: Story = {
  args: {
    onCancelReply: () => undefined,
    replyTarget: {
      source: "message",
      refMsgId: 301,
      author: "ava",
      snippet: "The filters should stay visible when the keyboard opens.",
    },
  },
}

export const Reconnecting: Story = {
  args: { disabled: true },
}

export const CollaboratorsTyping: Story = {
  args: { typingUsers: ["mira", "sam"] },
}
