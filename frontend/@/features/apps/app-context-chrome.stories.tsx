import type { Meta, StoryObj } from "@storybook/react-vite"
import { useLocation } from "react-router-dom"
import { expect, userEvent, within } from "storybook/test"

import type { AppChromeProps } from "@/features/apps/app-chrome"
import { AppContextChrome } from "@/features/apps/app-context-chrome"
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

function LocationEvidence() {
  const location = useLocation()
  return <output data-testid="route-location">{location.pathname}</output>
}

type AppContextChromeStoryArgs = Pick<
  AppChromeProps,
  "app" | "consoleError" | "onOpenOverflow" | "onRetry" | "state"
> & {
  backTo?: string
  label?: string
  mode: "improve" | "nested" | "use"
}

/**
 * Storybook intersects discriminated-union component props while inferring
 * args, which collapses AppContextChromeProps to `never`. This story-only
 * adapter presents one normalized control shape, then restores the production
 * union before rendering.
 */
function AppContextChromeStory({
  backTo = "/apps/recipebot/dev",
  label = "Nested route",
  mode,
  ...shared
}: AppContextChromeStoryArgs) {
  if (mode === "nested") {
    return <AppContextChrome {...shared} backTo={backTo} label={label} mode="nested" />
  }
  return <AppContextChrome {...shared} mode={mode} />
}

const meta = {
  title: "Apps/App context chrome",
  component: AppContextChromeStory,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex min-h-40 flex-col gap-4 bg-background p-4 text-foreground">
        <Story />
        <LocationEvidence />
      </div>
    ),
  ],
  args: {
    app,
    mode: "improve",
    state: "ready",
  },
} satisfies Meta<AppContextChromeStoryArgs>

export default meta
type Story = StoryObj<AppContextChromeStoryArgs>

export const ImproveRoot: Story = {
  args: {
    app,
    mode: "improve",
    state: "ready",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getAllByRole("heading", { level: 1 })).toHaveLength(1)
    await userEvent.click(canvas.getByRole("button", { name: "Use" }))
    await expect(canvas.getByTestId("route-location")).toHaveTextContent("/apps/recipebot/open")
  },
}

export const CloseToHome: Story = {
  args: {
    app,
    mode: "improve",
    state: "ready",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Close RecipeBot" }))
    await expect(canvas.getByTestId("route-location")).toHaveTextContent("/")
  },
}

export const NestedRoute: Story = {
  args: {
    app,
    backTo: "/apps/recipebot/dev",
    label: "Session",
    mode: "nested",
    state: "ready",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole("heading", { level: 1, name: /RecipeBot.*Session/ })).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Back" }))
    await expect(canvas.getByTestId("route-location")).toHaveTextContent("/apps/recipebot/dev")
  },
}
