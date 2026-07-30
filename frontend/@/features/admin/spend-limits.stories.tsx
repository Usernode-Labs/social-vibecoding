import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, within } from "storybook/test"

import {
  SpendLimitsCards,
  SpendLimitsForm,
  type SpendLimitsDraft,
} from "@/features/admin/spend-limits"

const limits = {
  user_daily_limit_cents: 2_500,
  global_daily_limit_cents: 20_000,
  system_tokens_daily_limit_cents: 2_500,
}

function FormFixture({
  canWrite = true,
  error = null,
  saving = false,
}: {
  canWrite?: boolean
  error?: string | null
  saving?: boolean
}) {
  const [draft, setDraft] = useState<SpendLimitsDraft>({
    global: "20000",
    system: "2500",
    user: "2500",
  })
  return <SpendLimitsForm canWrite={canWrite} draft={draft} error={error} onChange={setDraft} onSubmit={fn()} saving={saving} />
}

const meta = {
  title: "Features/Admin/Spend limits",
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="mx-auto max-w-5xl"><Story /></div>],
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const Summary: Story = {
  render: () => <SpendLimitsCards limits={limits} />,
}

// Preserve the existing manifest state until the source-derived authority
// adopts the more descriptive Summary name.
export const Defaults: Story = Summary

export const EditableForm: Story = {
  render: () => <FormFixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = canvas.getByLabelText("Default per-user daily cap")
    await userEvent.clear(input)
    await userEvent.type(input, "3000")
    await expect(input).toHaveValue(3000)
    await expect(canvas.getByRole("button", { name: "Save limits" })).toBeEnabled()
  },
}

export const Saving: Story = {
  render: () => <FormFixture saving />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Saving…" })).toBeDisabled()
  },
}

export const Invalid: Story = {
  render: () => <FormFixture error="Enter whole, non-negative cent amounts for every limit." />,
}

export const ReadOnly: Story = {
  render: () => <FormFixture canWrite={false} />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Save limits" })).toBeDisabled()
  },
}
