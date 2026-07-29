import type { ReactNode } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, within } from "storybook/test"

import { ExploreView } from "@/features/apps/explore"
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

const recipeBot: AppRecord = {
  ...gameCorner,
  id: "recipebot",
  slug: "recipebot",
  name: "RecipeBot",
  tagline: "Find a recipe for what you have at home",
}

const onQueryChange = fn()
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
  title: "Apps/Explore route",
  component: ExploreView,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <EvidenceFrame>
        <Story />
      </EvidenceFrame>
    ),
  ],
} satisfies Meta<typeof ExploreView>

export default meta
type Story = StoryObj<typeof meta>

const baseArgs = {
  apps: [gameCorner, recipeBot],
  onQueryChange,
  onRetry,
  query: "",
}

export const Catalog: Story = {
  args: baseArgs,
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Route evidence",
    })
    const canvas = within(region)
    await expect(
      canvas.getByRole("link", { name: "View details for Game Corner" })
    ).toHaveAttribute("href", "/apps/game-corner")
    await expect(canvas.queryByRole("link", { name: /Open Game Corner/ })).toBeNull()
    await expect(canvas.getByRole("link", { name: "Create dApp" })).toHaveAttribute(
      "href",
      "/create"
    )
  },
}

export const Loading: Story = {
  args: { ...baseArgs, apps: null },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Route evidence",
    })
    const canvas = within(region)
    await expect(
      canvas.getByRole("status", { name: "Loading Explore" })
    ).toBeVisible()
    await expect(canvas.getByRole("searchbox", { name: "Search dApps" })).toBeDisabled()
  },
}

export const EmptyCollection: Story = {
  args: { ...baseArgs, apps: [] },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Route evidence",
    })
    await expect(within(region).getByText("No dApps yet")).toBeVisible()
  },
}

export const FilteredResults: Story = {
  args: { ...baseArgs, query: "recipe" },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Route evidence",
    })
    const canvas = within(region)
    await expect(canvas.getByRole("heading", { name: "Results" })).toBeVisible()
    await expect(canvas.getByText("RecipeBot")).toBeVisible()
    await expect(canvas.queryByText("Game Corner")).toBeNull()
  },
}

export const NoResults: Story = {
  args: { ...baseArgs, query: "missing" },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Route evidence",
    })
    const canvas = within(region)
    await expect(canvas.getByText("No matching dApps")).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Clear search" }))
    await expect(onQueryChange).toHaveBeenCalledWith("")
  },
}

export const Error: Story = {
  args: { ...baseArgs, error: true },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Route evidence",
    })
    const canvas = within(region)
    await expect(canvas.getByRole("searchbox", { name: "Search dApps" })).toBeDisabled()
    await userEvent.click(canvas.getByRole("button", { name: "Try again" }))
    await expect(onRetry).toHaveBeenCalled()
  },
}

export const Narrow: Story = {
  args: baseArgs,
  decorators: [(Story) => <div className="w-80 max-w-full"><Story /></div>],
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Route evidence",
    })
    await expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth)
    await expect(within(region).getAllByRole("listitem")).toHaveLength(2)
  },
}

export const CatalogDark: Story = {
  args: baseArgs,
  globals: { theme: "dark" },
}
