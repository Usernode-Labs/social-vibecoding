import type { ReactNode } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, within } from "storybook/test"

import { HomeView } from "@/features/apps/home"
import { homeActivityItems } from "@/features/apps/home-explore-model"
import type { AppRecord } from "@/lib/apps-api"
import type { NotificationsPage } from "@/lib/notifications-api"

const recipeBot: AppRecord = {
  id: "recipebot",
  slug: "recipebot",
  name: "RecipeBot",
  status: "running",
  tagline: "Find a recipe for what you have at home",
  description: null,
  active_users: 24,
  is_favorited: true,
  is_collaborator: true,
  your_apps_hidden: false,
  favorite_order: 0,
  open_prs: 0,
  active_sessions: 0,
  open_issues: 0,
  icon_url: null,
}

const pantryPlanner: AppRecord = {
  ...recipeBot,
  id: "pantry-planner",
  slug: "pantry-planner",
  name: "Pantry Planner",
  is_collaborator: false,
  favorite_order: 1,
}

const gameCorner: AppRecord = {
  ...recipeBot,
  id: "game-corner",
  slug: "game-corner",
  name: "Game Corner",
  status: "building",
  is_favorited: false,
  is_collaborator: false,
  favorite_order: null,
}

const onMoveApp = fn()
const onActivityRetry = fn()
const onReorderingChange = fn()
const onRetry = fn()

function EvidenceFrame({
  children,
}: {
  children: ReactNode
}) {
  return (
    <section
      aria-label="Route evidence"
      className="w-full max-w-5xl overflow-hidden bg-background text-foreground"
    >
      {children}
    </section>
  )
}

const meta = {
  title: "Apps/Home route",
  component: HomeView,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <EvidenceFrame>
        <Story />
      </EvidenceFrame>
    ),
  ],
} satisfies Meta<typeof HomeView>

export default meta
type Story = StoryObj<typeof meta>

const baseArgs = {
  activity: [
    {
      id: "invite:collab:9",
      title: "Collaborator invitation",
      detail: "@ava invited you to RecipeBot.",
    },
    {
      id: "notification:1",
      title: "Can we add a pantry filter?",
      detail: "RecipeBot · @ava",
    },
    {
      id: "notification:3",
      title: "A reply worth reading",
      detail: "RecipeBot · @sam",
    },
    {
      id: "notification:4",
      title: "A fourth item",
      detail: "Game Corner",
    },
  ],
  apps: [recipeBot, pantryPlanner, gameCorner],
  onActivityRetry,
  onMoveApp,
  onReorderingChange,
  onRetry,
}

export const PersonalApps: Story = {
  args: baseArgs,
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Route evidence",
    })
    const canvas = within(region)
    await expect(
      canvas.getByRole("link", { name: "Open RecipeBot" })
    ).toHaveAttribute("href", "/apps/recipebot/open")
    await expect(canvas.queryByText("Game Corner")).toBeNull()
    await expect(
      within(canvas.getByRole("list", { name: "Your apps" })).getAllByRole(
        "listitem"
      )
    ).toHaveLength(2)
    await expect(canvas.getByRole("link", { name: "View all activity" })).toHaveAttribute(
      "href",
      "/notifications"
    )
    const activitySection = canvas
      .getByRole("heading", { name: "Needs attention" })
      .closest("section")
    await expect(activitySection).toBeTruthy()
    await expect(activitySection?.querySelectorAll("li")).toHaveLength(3)
  },
}

export const Loading: Story = {
  args: { ...baseArgs, activity: null, apps: null },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Route evidence",
    })
    await expect(
      within(region).getByRole("status", { name: "Loading Home" })
    ).toBeVisible()
  },
}

export const ActivityError: Story = {
  args: { ...baseArgs, activityError: true },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Route evidence",
    })
    const canvas = within(region)
    await expect(
      canvas.getByRole("link", { name: "Open RecipeBot" })
    ).toBeVisible()
    const alert = canvas.getByRole("alert")
    await expect(alert).toHaveTextContent("Activity couldn’t load")
    await userEvent.click(
      within(alert).getByRole("button", { name: "Try again" })
    )
    await expect(onActivityRetry).toHaveBeenCalled()
  },
}

export const ActivityLoading: Story = {
  args: { ...baseArgs, activity: null },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Route evidence",
    })
    const canvas = within(region)
    await expect(
      canvas.getByRole("link", { name: "Open RecipeBot" })
    ).toBeVisible()
    await expect(
      canvas.getByRole("status", { name: "Loading Activity" })
    ).toBeVisible()
  },
}

const notificationPage: NotificationsPage = {
  hasMore: false,
  nextBefore: null,
  pendingInvites: [
    {
      appId: 9,
      appName: "RecipeBot",
      appSlug: "recipebot",
      createdAt: "2026-07-28T12:30:00.000Z",
      invitedBy: "ava",
      kind: "collab",
    },
  ],
  notifications: [
    {
      appId: 4,
      appName: "RecipeBot",
      appSlug: "recipebot",
      createdAt: "2026-07-28T12:00:00.000Z",
      id: 1,
      kind: "mention",
      messageContent: "Can we add a pantry filter?",
      readAt: null,
      sourceUsername: "ava",
    },
    {
      appId: 4,
      appName: "RecipeBot",
      appSlug: "recipebot",
      createdAt: "2026-07-28T11:00:00.000Z",
      id: 2,
      kind: "session_done",
      prTitle: "Finished recipe search",
      readAt: null,
    },
    {
      appId: 4,
      appName: "RecipeBot",
      appSlug: "recipebot",
      createdAt: "2026-07-28T10:00:00.000Z",
      id: 3,
      kind: "reply",
      messageContent: "Already read",
      readAt: "2026-07-28T10:30:00.000Z",
    },
    {
      appId: 4,
      appName: "RecipeBot",
      appSlug: "recipebot",
      createdAt: "2026-07-28T09:00:00.000Z",
      id: 4,
      kind: "reaction",
      messageContent: "A new reaction",
      readAt: null,
    },
  ],
}

export const ActivitySemantics: Story = {
  args: { ...baseArgs, activity: homeActivityItems(notificationPage) },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Route evidence",
    })
    const canvas = within(region)
    await expect(canvas.getByText("Collaborator invitation")).toBeVisible()
    await expect(canvas.getByText("Can we add a pantry filter?")).toBeVisible()
    await expect(canvas.getByText("A new reaction")).toBeVisible()
    await expect(canvas.queryByText("Finished recipe search")).toBeNull()
    await expect(canvas.queryByText("Already read")).toBeNull()
  },
}

export const FirstRun: Story = {
  args: { ...baseArgs, apps: [] },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Route evidence",
    })
    const canvas = within(region)
    await expect(canvas.getByText("No dApps yet")).toBeVisible()
    await expect(
      canvas.getByRole("link", { name: "Explore dApps" })
    ).toHaveAttribute("href", "/explore")
  },
}

export const EmptyCollection: Story = {
  args: { ...baseArgs, apps: [gameCorner] },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Route evidence",
    })
    await expect(within(region).getByText("No shortcuts yet")).toBeVisible()
  },
}

export const Error: Story = {
  args: { ...baseArgs, error: true },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Route evidence",
    })
    await userEvent.click(
      within(region).getByRole("button", { name: "Try again" })
    )
    await expect(onRetry).toHaveBeenCalled()
  },
}

export const Reordering: Story = {
  args: { ...baseArgs, reordering: true },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Route evidence",
    })
    const canvas = within(region)
    await userEvent.click(
      canvas.getByRole("button", { name: "Move Pantry Planner earlier" })
    )
    await expect(onMoveApp).toHaveBeenCalledWith("pantry-planner", -1)
    await userEvent.click(canvas.getByRole("button", { name: "Done" }))
    await expect(onReorderingChange).toHaveBeenCalledWith(false)
  },
}

export const ReorderError: Story = {
  args: {
    ...baseArgs,
    orderError: "Your app order changed elsewhere.",
    reordering: true,
  },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Route evidence",
    })
    await expect(within(region).getByRole("alert")).toHaveTextContent(
      "Your app order changed elsewhere."
    )
  },
}

export const ProductionReview: Story = {
  args: { ...baseArgs, canReorder: false },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Route evidence",
    })
    await expect(
      within(region).getByRole("button", { name: "Reorder" })
    ).toBeDisabled()
  },
}

export const PersonalAppsDark: Story = {
  args: baseArgs,
  globals: { theme: "dark" },
}

export const Narrow: Story = {
  args: baseArgs,
  decorators: [(Story) => <div className="w-80 max-w-full"><Story /></div>],
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Route evidence",
    })
    await expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth)
  },
}
