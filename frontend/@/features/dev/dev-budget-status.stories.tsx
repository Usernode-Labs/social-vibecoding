import type { Meta, StoryObj } from "@storybook/react-vite"

import { DevBudgetStatusView } from "@/features/dev/dev-budget-status"

const sharedBudget = {
  spentCents: 125,
  limitCents: 500,
  globalSpentCents: 1_250,
  globalLimitCents: 5_000,
  byokSpentCents: 0,
  aiEnabled: true,
}

const meta = {
  title: "Dev/Budget status",
  component: DevBudgetStatusView,
  parameters: { layout: "padded" },
} satisfies Meta<typeof DevBudgetStatusView>

export default meta
type Story = StoryObj<typeof meta>

export const SharedAllowance: Story = {
  args: { budget: sharedBudget, hasApiKey: false, keyLast4: null },
}

export const PersonalKeySpillover: Story = {
  args: {
    budget: { ...sharedBudget, spentCents: 500, byokSpentCents: 83 },
    hasApiKey: true,
    keyLast4: "4f2a",
  },
}

export const UserAllowanceExhausted: Story = {
  args: {
    budget: { ...sharedBudget, spentCents: 500 },
    hasApiKey: false,
    keyLast4: null,
  },
}

export const SharedAllowanceExhausted: Story = {
  args: {
    budget: { ...sharedBudget, globalSpentCents: 5_000 },
    hasApiKey: false,
    keyLast4: null,
  },
}

export const AiUnavailable: Story = {
  args: {
    budget: { ...sharedBudget, aiEnabled: false },
    hasApiKey: false,
    keyLast4: null,
  },
}
