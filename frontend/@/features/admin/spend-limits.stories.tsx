import type { Meta, StoryObj } from "@storybook/react-vite"

import { SpendLimitsCards } from "@/features/admin/spend-limits"

const meta = { title: "Admin/Spend limits", component: SpendLimitsCards, parameters: { layout: "padded" }, decorators: [(Story) => <div className="mx-auto max-w-5xl"><Story /></div>] } satisfies Meta<typeof SpendLimitsCards>
export default meta
type Story = StoryObj<typeof meta>
export const Defaults: Story = { args: { limits: { user_daily_limit_cents: 2500, global_daily_limit_cents: 20000, system_tokens_daily_limit_cents: 2500 } } }
