import type { Meta, StoryObj } from "@storybook/react-vite"

import { SharedSessionDetailContent } from "@/features/dev/shared-session"
import { TopicDiscussionContent } from "@/features/dev/topic-discussion-transcript"
import type { GroupChatMessage } from "@/lib/group-chat-api"
import type { SharedSession } from "@/lib/shared-session-api"

const session: SharedSession = { id: 41, session_title: "Improve pantry search", branch_name: "feature/pantry-search", status: "active", username: "Mira", shared_at: "2026-07-28T09:30:00.000Z", chat_count: 2, linked_issues: [84], staging_url: "https://preview.example.test" }
const messages: GroupChatMessage[] = [
  { id: 1, user_id: 2, username: "Mira", content: "I’m testing the smallest useful pantry filter.", msg_type: "message", created_at: "2026-07-28T09:32:00.000Z" },
  { id: 2, user_id: 5, username: "Sam", content: "Keeping the existing search terms intact sounds right.", msg_type: "message", created_at: "2026-07-28T09:35:00.000Z" },
]

const meta = { title: "Features/Dev/Shared session detail", component: SharedSessionDetailContent, parameters: { layout: "fullscreen" } } satisfies Meta<typeof SharedSessionDetailContent>
export default meta
type Story = StoryObj<typeof meta>

export const Collaborator: Story = {
  args: {
    slug: "recipebot",
    session,
    children: <TopicDiscussionContent capability="allowed" currentUserId={2} messages={messages} onEdit={() => {}} onReact={() => {}} onReply={() => {}} onSend={() => {}} slug="recipebot" writable />,
  },
}
export const ViewOnly: Story = {
  args: {
    slug: "recipebot",
    session: { ...session, status: "paused", staging_url: null, busy: false },
    children: <TopicDiscussionContent capability="denied" messages={messages} slug="recipebot" />,
  },
}
