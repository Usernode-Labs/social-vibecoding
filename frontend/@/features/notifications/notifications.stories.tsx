import type { Meta, StoryObj } from "@storybook/react-vite"

import { NotificationsContent } from "@/features/notifications/notifications"

const data = {
  unread: 2,
  invites: [{ kind: "collab" as const, appId: 41, appSlug: "recipebot", appName: "RecipeBot", invitedBy: "ava", createdAt: "2026-07-28T12:00:00.000Z" }],
  hasMore: true,
  nextBefore: { createdAt: "2026-07-28T10:00:00.000Z", id: 4 },
  items: [
    { id: 4, kind: "mention", readAt: null, appId: 41, appSlug: "recipebot", appName: "RecipeBot", createdAt: "2026-07-28T11:00:00.000Z", messageContent: "Could you review the pantry filter?", sourceUsername: "ava" },
    { id: 3, kind: "reply", readAt: null, appId: null, appSlug: null, appName: null, createdAt: "2026-07-28T10:00:00.000Z", messageContent: "The community proposal has a reply.", sourceUsername: "mira" },
    { id: 2, kind: "session_done", readAt: null, appId: 41, appSlug: "recipebot", appName: "RecipeBot", createdAt: "2026-07-28T09:00:00.000Z", prTitle: "This must remain in Work" },
  ],
}

const meta = {
  title: "Platform/Activity",
  component: NotificationsContent,
  parameters: { layout: "fullscreen" },
  decorators: [(Story) => <Story />],
  args: {
    data,
    error: null,
    inviteError: null,
    loadMoreError: null,
    loadingMore: false,
    liveState: "connected",
    markingAll: false,
    mutatingInvite: null,
    onOpen: () => undefined,
    onRefresh: () => undefined,
    onLoadMore: () => undefined,
    onMarkAll: () => undefined,
    onInviteAction: () => undefined,
  },
} satisfies Meta<typeof NotificationsContent>

export default meta
type Story = StoryObj<typeof meta>

export const WithInvitationAndPagination: Story = {}
export const Empty: Story = { args: { data: { items: [], invites: [], unread: 0, hasMore: false, nextBefore: null } } }
export const Loading: Story = { args: { data: null, liveState: "connecting" } }
export const Error: Story = { args: { data: null, error: "Request failed (503)", liveState: "unavailable" } }
