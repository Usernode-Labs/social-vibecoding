import type { Meta, StoryObj } from "@storybook/react-vite"
import { ArrowLeft, ArrowRight } from "lucide-react"

import { AppCard } from "@/features/apps/app-card"
import { PlatformIcon } from "@/components/platform-icon"
import { Button } from "@/components/ui/button"

const meta = {
  title: "Apps/AppCard",
  component: AppCard,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="w-[22rem] bg-background p-4"><Story /></div>],
} satisfies Meta<typeof AppCard>

export default meta
type Story = StoryObj<typeof meta>

export const Running: Story = {
  args: {
    app: {
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
    },
  },
}

export const Unavailable: Story = {
  args: {
    app: {
      id: "game-corner",
      slug: "game-corner",
      name: "Game Corner",
      status: "building",
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
    },
  },
}

export const ReorderControls: Story = {
  args: {
    app: {
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
    },
    footerActions: <div className="flex gap-1"><Button aria-label="Move RecipeBot earlier" disabled size="icon-sm" type="button" variant="outline"><PlatformIcon icon={ArrowLeft} /></Button><Button aria-label="Move RecipeBot later" size="icon-sm" type="button" variant="outline"><PlatformIcon icon={ArrowRight} /></Button></div>,
  },
}
