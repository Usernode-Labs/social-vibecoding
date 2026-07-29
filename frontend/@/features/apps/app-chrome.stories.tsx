import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, within } from "storybook/test"

import { AppChrome } from "@/features/apps/app-chrome"
import type { AppDetail } from "@/lib/apps-api"

const app = {
  id: "app-recipebot",
  slug: "recipebot",
  name: "RecipeBot",
  status: "running",
  tagline: "Plan meals from what you already have.",
  description: null,
  icon_url: null,
  active_users: 24,
  is_favorited: true,
  is_collaborator: true,
  your_apps_hidden: false,
  favorite_order: 0,
  open_prs: 2,
  active_sessions: 1,
  open_issues: 4,
  url: "https://recipebot.example.test/",
} satisfies AppDetail

const meta = {
  title: "Apps/App chrome",
  component: AppChrome,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="grid gap-6 bg-background p-4">
        <section aria-label="Light" className="relative min-h-40 bg-muted text-foreground">
          <Story />
        </section>
        <section aria-label="Dark" className="dark relative min-h-40 bg-muted text-foreground">
          <Story />
        </section>
      </div>
    ),
  ],
  args: {
    app,
    mode: "use",
    onClose: fn(),
    onBack: fn(),
    onImprove: fn(),
    onOpenOverflow: fn(),
    onRetry: fn(),
    onUse: fn(),
  },
} satisfies Meta<typeof AppChrome>

export default meta
type Story = StoryObj<typeof meta>

function light(canvasElement: HTMLElement) {
  return within(within(canvasElement).getByRole("region", { name: "Light" }))
}

export const Loading: Story = {
  args: { state: "loading" },
  play: async ({ canvasElement }) => {
    await expect(light(canvasElement).getByRole("img", { name: "RecipeBot, preparing" })).toBeTruthy()
  },
}

export const Ready: Story = {
  args: { mode: "use", state: "ready" },
  play: async ({ canvasElement }) => {
    const canvas = light(canvasElement)
    await expect(canvas.getByRole("group", { name: "RecipeBot controls" })).toBeTruthy()
    await expect(canvas.getByRole("heading", { level: 1, name: "RecipeBot" })).toBeTruthy()
    await expect(canvas.getByRole("img", { name: "RecipeBot, running" })).toBeTruthy()
    await userEvent.click(canvas.getByRole("button", { name: "Close RecipeBot" }))
    await expect(meta.args.onClose).toHaveBeenCalled()
  },
}

export const OfflineRetry: Story = {
  args: { mode: "use", state: "offline" },
  play: async ({ canvasElement }) => {
    const retry = light(canvasElement).getByRole("button", { name: "Retry" })
    await userEvent.click(retry)
    await expect(meta.args.onRetry).toHaveBeenCalled()
  },
}

export const SelfHosted: Story = {
  args: { state: "self-hosted" },
  play: async ({ canvasElement }) => {
    await expect(light(canvasElement).getByText("Self-hosted")).toBeVisible()
  },
}

export const NotRunning: Story = {
  args: {
    app: { ...app, status: "building" },
    state: "unavailable",
  },
  play: async ({ canvasElement }) => {
    await expect(light(canvasElement).getByText("Unavailable")).toBeVisible()
  },
}

export const NarrowFocused: Story = {
  args: { mode: "use", state: "ready" },
  decorators: [(Story) => <div className="relative min-h-screen max-w-80"><Story /></div>],
  parameters: { viewport: { defaultViewport: "mobile1" } },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", { name: "Light" })
    await expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth)
  },
}

export const ImproveMode: Story = {
  args: { mode: "improve", state: "ready" },
  play: async ({ canvasElement }) => {
    const canvas = light(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Use" }))
    await expect(meta.args.onUse).toHaveBeenCalled()
    await expect(canvas.queryByRole("button", { name: "Improve" })).toBeNull()
  },
}

export const NestedRoute: Story = {
  args: { mode: "nested", nestedLabel: "Settings", state: "ready" },
  play: async ({ canvasElement }) => {
    const canvas = light(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Back" }))
    await expect(meta.args.onBack).toHaveBeenCalled()
  },
}

export const ConsoleError: Story = {
  args: { consoleError: true, mode: "use", state: "ready" },
  play: async ({ canvasElement }) => {
    await expect(light(canvasElement).getByRole("button", { name: "App actions, developer console has errors" })).toBeTruthy()
  },
}
