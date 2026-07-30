import type { Meta, StoryObj } from "@storybook/react-vite"

import { AdminUsersList } from "@/features/admin/admin-users"

const meta = { title: "Features/Admin/Users list", component: AdminUsersList, parameters: { layout: "padded" }, decorators: [(Story) => <div className="mx-auto max-w-5xl"><Story /></div>] } satisfies Meta<typeof AdminUsersList>
export default meta
type Story = StoryObj<typeof meta>

export const MixedRoles: Story = { args: { users: [
  { id: 1, username: "ava", is_admin: true, apps_created: 5, app_quota: 3, cost_today_cents: 999, usernode_pubkey: "ut1verylongexamplewalletaddress00001", is_self: true },
  { id: 2, username: "milo", is_admin: true, admin_readonly: true, apps_created: 2, app_quota: 4, cost_today_cents: 235, daily_limit_cents: 2500 },
  { id: 3, username: "sam", apps_created: 1, app_quota: 3, cost_today_cents: 0, activation_code: "WELCOME-2026" },
] } }
