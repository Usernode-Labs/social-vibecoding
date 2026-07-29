import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, within } from "storybook/test"

import { DevConsoleProvider } from "@/components/dev-console-provider"
import { FocusedAppFrame } from "@/features/apps/focused-app-frame"
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
  title: "Apps/Focused app frame",
  component: FocusedAppFrame,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <DevConsoleProvider>
        <div className="grid min-h-screen gap-6 bg-background p-4">
          <section aria-label="Light" className="flex min-h-80 bg-background text-foreground">
            <Story />
          </section>
          <section aria-label="Dark" className="dark flex min-h-80 bg-background text-foreground">
            <Story />
          </section>
        </div>
      </DevConsoleProvider>
    ),
  ],
  args: {
    app,
    iframeToken: null,
    innerPath: null,
    offline: false,
    onFrameLoad: fn(),
    onRetry: fn(),
  },
} satisfies Meta<typeof FocusedAppFrame>

export default meta
type Story = StoryObj<typeof meta>

function light(canvasElement: HTMLElement) {
  return within(within(canvasElement).getByRole("region", { name: "Light" }))
}

// Ready iframe content is intentionally browser-fixture evidence, not a
// Storybook mock. The presentation-only Ready state lives in AppChrome.
export const TokenUnavailable: Story = {
  play: async ({ canvasElement }) => {
    await expect(light(canvasElement).getByRole("status")).toHaveTextContent("Preparing RecipeBot")
    await expect(canvasElement.querySelector("iframe")).toBeNull()
  },
}

export const OfflineRetry: Story = {
  args: { offline: true },
  play: async ({ canvasElement }) => {
    await userEvent.click(light(canvasElement).getByRole("button", { name: "Retry" }))
    await expect(meta.args.onRetry).toHaveBeenCalled()
    await expect(canvasElement.querySelector("iframe")).toBeNull()
  },
}

export const UnsafeDestination: Story = {
  args: { app: { ...app, url: "://invalid" }, iframeToken: "storybook-token" },
  play: async ({ canvasElement }) => {
    await expect(light(canvasElement).getByRole("alert")).toHaveTextContent("App can't open")
    await expect(canvasElement.querySelector("iframe")).toBeNull()
  },
}

export const SelfHosted: Story = {
  args: { app: { ...app, self_hosted: true } },
  play: async ({ canvasElement }) => {
    await expect(light(canvasElement).getByRole("alert")).toHaveTextContent("RecipeBot opens in Dev")
  },
}

export const NotRunning: Story = {
  args: { app: { ...app, status: "building", url: null } },
  play: async ({ canvasElement }) => {
    await expect(light(canvasElement).getByRole("alert")).toHaveTextContent("App isn't ready")
  },
}
