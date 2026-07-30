import type { Meta, StoryObj } from "@storybook/react-vite"

import { AdminOperationsOverview } from "@/features/admin/admin-overview"

const overview = {
  stuckApps: [{ slug: "recipebot", dbStatus: "creating", createdBy: "ava" }],
  orphanWorkers: [{ name: "recipebot-builder-7", appSlug: "recipebot", uptimeSeconds: 3900 }],
  llmToday: { totalSpendCents: 1234, users: [{ username: "ava", costCents: 999 }, { username: "milo", costCents: 235 }] },
}

const meta = {
  title: "Features/Admin/Operations overview",
  component: AdminOperationsOverview,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="mx-auto max-w-5xl"><Story /></div>],
} satisfies Meta<typeof AdminOperationsOverview>

export default meta
type Story = StoryObj<typeof meta>

export const Administrator: Story = { args: { user: { isAdmin: true, canAdminWrite: true, role: "admin" }, overview } }

export const ViewOnly: Story = { args: { user: { isAdmin: true, canAdminWrite: false, role: "view_admin" }, overview } }

export const AllClear: Story = { args: { user: { isAdmin: true, canAdminWrite: true, role: "admin" }, overview: { stuckApps: [], orphanWorkers: [], llmToday: { totalSpendCents: 0, users: [] } } } }
