import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"

import { ExploreAppCard } from "@/features/apps/explore-app-card"
import type { AppRecord } from "@/lib/apps-api"

const gameCorner: AppRecord = {
  id: "game-corner",
  slug: "game-corner",
  name: "Game Corner",
  status: "running",
  tagline: "A daily puzzle for the community",
  description: null,
  active_users: 8,
  is_favorited: false,
  is_collaborator: false,
  your_apps_hidden: false,
  favorite_order: null,
  open_prs: 0,
  active_sessions: 0,
  open_issues: 0,
  icon_url: null,
}

const meta = {
  title: "Blocks/Apps/Explore app card",
  component: ExploreAppCard,
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="grid w-full max-w-sm gap-6">
        <section aria-label="Light" className="bg-background p-4 text-foreground">
          <Story />
        </section>
        <section aria-label="Dark" className="dark bg-background p-4 text-foreground">
          <Story />
        </section>
      </div>
    ),
  ],
} satisfies Meta<typeof ExploreAppCard>

export default meta
type Story = StoryObj<typeof meta>

const args = { app: gameCorner, href: "/apps/game-corner", status: "running" as const }

function light(canvasElement: HTMLElement) {
  return within(within(canvasElement).getByRole("region", { name: "Light" }))
}

export const Running: Story = {
  args,
  play: async ({ canvasElement }) => {
    const canvas = light(canvasElement)
    await expect(canvas.getByRole("link", { name: "View details for Game Corner" })).toHaveAttribute("href", "/apps/game-corner")
    await expect(canvas.getByText("Running")).toBeVisible()
  },
}

export const Building: Story = {
  args: { ...args, app: { ...gameCorner, status: "building" }, status: "building" },
  play: async ({ canvasElement }) => {
    await expect(light(canvasElement).getByText("Building")).toBeVisible()
  },
}

export const AwaitingSecrets: Story = {
  args: { ...args, app: { ...gameCorner, status: "awaiting_secrets" }, status: "awaiting-secrets" },
  play: async ({ canvasElement }) => {
    await expect(light(canvasElement).getByText("Configuration required")).toBeVisible()
  },
}

export const Unavailable: Story = {
  args: { ...args, app: { ...gameCorner, status: "error" }, status: "unavailable" },
  play: async ({ canvasElement }) => {
    await expect(light(canvasElement).getByText("Unavailable")).toBeVisible()
  },
}

export const WithCommunity: Story = {
  args: { ...args, showCommunitySignal: true },
  play: async ({ canvasElement }) => {
    await expect(light(canvasElement).getByText("8 active")).toBeVisible()
  },
}

export const NoDescription: Story = {
  args: { ...args, app: { ...gameCorner, tagline: null, description: null } },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", { name: "Light" })
    await expect(region.querySelector("[data-slot='card-description']")).toBeNull()
    await expect(within(region).queryByText(/no description/i)).toBeNull()
  },
}
