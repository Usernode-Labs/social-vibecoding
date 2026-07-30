import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"

import { AiSpendSummary } from "@/features/account/ai-spend-summary"

const meta = {
  title: "Blocks/Account/AI spend summary",
  component: AiSpendSummary,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="mx-auto max-w-3xl"><Story /></div>],
  args: { enabled: true },
  beforeEach: () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({
      spentCents: 125,
      limitCents: 500,
      globalSpentCents: 1_250,
      globalLimitCents: 5_000,
      byokSpentCents: 32,
      aiEnabled: true,
    }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    })
    return () => { globalThis.fetch = originalFetch }
  },
} satisfies Meta<typeof AiSpendSummary>

export default meta
type Story = StoryObj<typeof meta>

export const Ready: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(await canvas.findByText("$1.25 of $5.00")).toBeTruthy()
    await expect(await canvas.findByText("$0.32")).toBeTruthy()
  },
}

export const Disabled: Story = {
  args: { enabled: false },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByTestId("settings-ai-spend")).toBeNull()
  },
}
