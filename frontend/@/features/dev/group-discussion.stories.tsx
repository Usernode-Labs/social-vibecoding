import type { Meta, StoryObj } from "@storybook/react-vite"

import { GroupDiscussionTranscript } from "@/features/dev/group-discussion"
import type { GroupChatMessage } from "@/lib/group-chat-api"

const messages: GroupChatMessage[] = [
  { id: 1, user_id: 4, username: "mira", content: "The recipe search feels much clearer now. Could the next pass make dietary filters easier to find?", msg_type: "message", created_at: "2026-07-28T09:00:00.000Z", reactions: [{ emoji: "👍", count: 2, users: ["mira", "sam"] }] },
  { id: 2, user_id: 5, username: "sam", content: "Yes — I’ll keep the change small and preserve the existing pantry flow.", msg_type: "message", created_at: "2026-07-28T09:03:00.000Z", metadata: { quote: { source: "message", author: "mira", snippet: "Could the next pass make dietary filters easier to find?" }, attachments: [{ id: "notes-1", kind: "markdown", filename: "filter-notes.md", sizeBytes: 1024 }] } },
  { id: 3, user_id: null, username: null, content: "A proposal was promoted for review.", msg_type: "vote", created_at: "2026-07-28T09:05:00.000Z" },
]

const meta = {
  title: "Blocks/Dev/Group discussion",
  component: GroupDiscussionTranscript,
  parameters: { layout: "fullscreen" },
  decorators: [(Story) => <div className="min-h-dvh bg-background"><Story /></div>],
} satisfies Meta<typeof GroupDiscussionTranscript>

export default meta
type Story = StoryObj<typeof meta>

/** The route's networking is exercised by Playwright fixtures; this records its reusable responsive presentation. */
export const ReadOnly: Story = { args: { messages, slug: "recipebot" } }
export const CollaboratorReactions: Story = { args: { messages, onReact: () => undefined, slug: "recipebot", writable: true } }
export const CollaboratorReplies: Story = { args: { messages, onReply: () => undefined, slug: "recipebot", writable: true } }
export const CollaboratorEditing: Story = { args: { currentUserId: 4, messages, onEdit: () => undefined, slug: "recipebot", writable: true } }
export const UnreadNotification: Story = { args: { messages: [{ ...messages[0], has_unread_notification: true }, ...messages.slice(1)], onMarkRead: () => undefined, slug: "recipebot" } }
export const Empty: Story = { args: { messages: [], slug: "recipebot" } }
