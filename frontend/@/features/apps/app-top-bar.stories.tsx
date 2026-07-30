import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, within } from "storybook/test"

import { ShellAttentionProvider } from "@/components/platform-menu-trigger"
import { SidebarProvider } from "@/components/ui/sidebar"
import { AppTopBar } from "@/features/apps/app-top-bar"
import type { AppTopBarProps } from "@/features/apps/app-top-bar"
import type { AppDetail } from "@/lib/apps-api"

const app = {
  id: "recipebot",
  slug: "recipebot",
  name: "RecipeBot",
  status: "running",
  tagline: "Plan meals from what you already have.",
  active_users: 24,
  is_favorited: true,
  is_collaborator: true,
  your_apps_hidden: false,
  favorite_order: 0,
  open_prs: 2,
  active_sessions: 1,
  open_issues: 4,
  can_collaborate: true,
} satisfies AppDetail

type StoryArgs = Pick<
  AppTopBarProps,
  "app" | "consoleError" | "fallbackTitle" | "onOpenOverflow" | "placement"
> & {
  backTo?: string
  label?: string
  mode: "improve" | "nested" | "use"
}

const meta = {
  title: "Features/Apps/App top bar",
  render: (args) => {
    const common = {
      app: args.app,
      consoleError: args.consoleError,
      fallbackTitle: args.fallbackTitle,
      onOpenOverflow: args.onOpenOverflow,
      placement: args.placement,
    }
    return args.mode === "nested"
      ? <AppTopBar {...common} backTo={args.backTo || "/"} label={args.label || "App"} mode="nested" />
      : <AppTopBar {...common} mode={args.mode} />
  },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <SidebarProvider>
        <ShellAttentionProvider count={0}>
          <div className="relative min-h-40"><Story /></div>
        </ShellAttentionProvider>
      </SidebarProvider>
    ),
  ],
  args: { app, mode: "use" },
} satisfies Meta<StoryArgs>

export default meta
type Story = StoryObj<typeof meta>

export const UseMode: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole("heading", { level: 1, name: "RecipeBot" })).toBeTruthy()
    await expect(canvas.getByRole("button", { name: "Improve" })).toBeTruthy()
    await expect(canvas.getByRole("button", { name: "Close RecipeBot" })).toBeTruthy()
  },
}

export const ImproveMode: Story = {
  args: { mode: "improve" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Use" })).toBeTruthy()
  },
}

export const Nested: Story = {
  args: {
    backTo: "/apps/recipebot/dev",
    label: "Members",
    mode: "nested",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole("heading", { level: 1, name: "RecipeBot · Members" })).toBeTruthy()
    const trailing = canvasElement.querySelector('[data-slot="top-bar-action"]')
    await expect(trailing).toBeTruthy()
    await expect(within(trailing as HTMLElement).getByRole("button", { name: "Back" })).toBeTruthy()
  },
}

export const ConsoleError: Story = {
  args: { consoleError: true, onOpenOverflow: fn() },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Open developer console, errors" })
    ).toBeTruthy()
  },
}

export const LoadingIdentity: Story = {
  args: { app: null, fallbackTitle: "Loading app" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole("heading", { level: 1, name: "Loading app" })).toBeTruthy()
    await expect(canvas.queryByRole("button", { name: /Close/ })).toBeNull()
  },
}

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
}
