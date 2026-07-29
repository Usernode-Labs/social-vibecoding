import type { Meta, StoryObj } from "@storybook/react-vite"

import { SubmittedFeaturesList } from "@/features/admin/admin-features"

const meta = { title: "Admin/Submitted features", component: SubmittedFeaturesList, parameters: { layout: "padded" }, decorators: [(Story) => <div className="mx-auto max-w-5xl"><Story /></div>] } satisfies Meta<typeof SubmittedFeaturesList>
export default meta
type Story = StoryObj<typeof meta>

export const Ranked: Story = { args: { features: [
  { id: 1, title: "Share app templates", status: "open", app_name: "RecipeBot", app_slug: "recipebot", description: "Let members publish a reusable starter after an app is stable.", created_by_username: "ava", created_at: "2026-07-27T12:00:00Z", github_issue_number: 46, up_count: 28, down_count: 2 },
  { id: 2, title: "Offline recipe queue", status: "completed", app_name: "RecipeBot", app_slug: "recipebot", description: "Keep planned recipes visible while the host is unavailable.", created_by_username: "milo", created_at: "2026-07-22T12:00:00Z", up_count: 16, down_count: 1 },
] } }

export const Empty: Story = { args: { features: [] } }
