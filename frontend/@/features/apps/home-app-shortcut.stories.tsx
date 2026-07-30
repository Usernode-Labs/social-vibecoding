import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, within } from "storybook/test"

import { HomeAppShortcut, type HomeAppShortcutProps } from "@/features/apps/home-app-shortcut"
import type { AppRecord } from "@/lib/apps-api"

const recipeBot: AppRecord = {
  id: "recipebot",
  slug: "recipebot",
  name: "RecipeBot",
  status: "running",
  tagline: "Find a recipe for what you have at home",
  description: null,
  active_users: 24,
  is_favorited: true,
  is_collaborator: false,
  your_apps_hidden: false,
  favorite_order: 0,
  open_prs: 0,
  active_sessions: 0,
  open_issues: 0,
  icon_url: null,
}

const meta = {
  title: "Apps/Home app shortcut",
  component: HomeAppShortcut,
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
} satisfies Meta<typeof HomeAppShortcut>

export default meta
type Story = StoryObj<typeof meta>

const args = { app: recipeBot, href: "/apps/recipebot", status: "running" as const }
const moveEarlier = fn()
const moveLater = fn()
const reorder = (position: number, overrides: Partial<NonNullable<HomeAppShortcutProps["reorder"]>> = {}) => ({
  position,
  total: 3,
  onMoveEarlier: moveEarlier,
  onMoveLater: moveLater,
  ...overrides,
})

function light(canvasElement: HTMLElement) {
  return within(within(canvasElement).getByRole("region", { name: "Light" }))
}

export const Running: Story = {
  args,
  play: async ({ canvasElement }) => {
    const canvas = light(canvasElement)
    await expect(canvas.getByRole("link", { name: "Open RecipeBot" })).toHaveAttribute("href", "/apps/recipebot")
    // Healthy is the quiet default on Home: no status line competes with launch.
    await expect(canvas.queryByText("Running")).not.toBeInTheDocument()
  },
}

export const Unavailable: Story = {
  args: { ...args, app: { ...recipeBot, status: "error" }, status: "unavailable" },
  play: async ({ canvasElement }) => {
    await expect(light(canvasElement).getByText("Unavailable")).toBeVisible()
  },
}

export const Collaborator: Story = {
  args: { ...args, app: { ...recipeBot, is_collaborator: true } },
  play: async ({ canvasElement }) => {
    await expect(light(canvasElement).getByText("Collaborator")).toBeVisible()
  },
}

export const ReorderFirst: Story = {
  args: { ...args, reorder: reorder(0) },
  play: async ({ canvasElement }) => {
    const canvas = light(canvasElement)
    await expect(canvas.getByRole("button", { name: "Move RecipeBot earlier" })).toBeDisabled()
    await expect(canvas.getByRole("button", { name: "Move RecipeBot later" })).toBeEnabled()
  },
}

export const ReorderMiddle: Story = {
  args: { ...args, reorder: reorder(1) },
  play: async ({ canvasElement }) => {
    const canvas = light(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Move RecipeBot earlier" }))
    await userEvent.click(canvas.getByRole("button", { name: "Move RecipeBot later" }))
    await expect(moveEarlier).toHaveBeenCalled()
    await expect(moveLater).toHaveBeenCalled()
  },
}

export const ReorderLast: Story = {
  args: { ...args, reorder: reorder(2) },
  play: async ({ canvasElement }) => {
    const canvas = light(canvasElement)
    await expect(canvas.getByRole("button", { name: "Move RecipeBot earlier" })).toBeEnabled()
    await expect(canvas.getByRole("button", { name: "Move RecipeBot later" })).toBeDisabled()
  },
}

export const ReorderPending: Story = {
  args: { ...args, reorder: reorder(1, { pending: true }) },
  play: async ({ canvasElement }) => {
    const canvas = light(canvasElement)
    await expect(canvas.getByRole("button", { name: "Move RecipeBot earlier" })).toBeDisabled()
    await expect(canvas.getByRole("button", { name: "Move RecipeBot later" })).toBeDisabled()
  },
}
