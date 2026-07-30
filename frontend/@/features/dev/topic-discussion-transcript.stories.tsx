import type { Meta, StoryObj } from "@storybook/react-vite"

import { TopicDiscussionContent } from "@/features/dev/topic-discussion-transcript"
import type { GroupChatMessage } from "@/lib/group-chat-api"

const messages: GroupChatMessage[] = [
  {
    id: 301,
    user_id: 7,
    username: "ava",
    content: "The filters should stay visible when the keyboard opens.",
    msg_type: "message",
    metadata: null,
    created_at: "2026-07-29T09:00:00.000Z",
    reactions: [{ emoji: "👍", count: 2, users: ["ava", "mira"] }],
  },
  {
    id: 302,
    user_id: 8,
    username: "mira",
    content: "Agreed. I added that constraint to this proposal.",
    msg_type: "message",
    metadata: {
      quote: {
        source: "message",
        author: "ava",
        snippet: "The filters should stay visible when the keyboard opens.",
      },
    },
    created_at: "2026-07-29T09:05:00.000Z",
    reactions: [],
  },
]

const meta = {
  title: "Blocks/Dev/Topic discussion",
  component: TopicDiscussionContent,
  parameters: { layout: "fullscreen" },
  decorators: [(Story) => <div className="mx-auto min-h-dvh max-w-3xl bg-background p-4 sm:p-8"><Story /></div>],
  args: {
    messages,
    slug: "recipebot",
  },
} satisfies Meta<typeof TopicDiscussionContent>

export default meta
type Story = StoryObj<typeof meta>

export const Collaborator: Story = {
  args: {
    currentUserId: 7,
    onEdit: () => undefined,
    onReact: () => undefined,
    onReply: () => undefined,
    onSend: () => undefined,
    writable: true,
  },
}

export const CollaboratorEditing: Story = {
  args: {
    currentUserId: 7,
    onEdit: () => undefined,
    onReact: () => undefined,
    onReply: () => undefined,
    onSend: () => undefined,
    writable: true,
  },
}

export const ReplyStaged: Story = {
  args: {
    onCancelReply: () => undefined,
    onReact: () => undefined,
    onReply: () => undefined,
    onSend: () => undefined,
    replyTarget: {
      source: "message",
      refMsgId: 301,
      author: "ava",
      snippet: "The filters should stay visible when the keyboard opens.",
    },
    writable: true,
  },
}

export const ViewOnly: Story = {
  args: { viewOnly: true },
}

export const Reconnecting: Story = {
  args: {
    connectionState: "reconnecting",
    onReact: () => undefined,
    onSend: () => undefined,
    writable: true,
  },
}

export const CollaboratorTyping: Story = {
  args: {
    onSend: () => undefined,
    typingUsers: ["mira"],
    writable: true,
  },
}

export const Empty: Story = {
  args: {
    messages: [],
    onSend: () => undefined,
    writable: true,
  },
}

export const Loading: Story = {
  args: { messages: null },
}

export const Error: Story = {
  args: {
    error: "Request failed (503)",
    messages: null,
  },
}

export const ProductionReview: Story = {
  args: { productionReview: true },
}
