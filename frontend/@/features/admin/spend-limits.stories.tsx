import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, within } from "storybook/test"

import {
  SpendLimitsForm,
  SpendLimitsSummary,
  type SpendLimitsDraft,
  type SpendLimitsFieldErrors,
  type SpendLimitsNotice,
} from "@/features/admin/spend-limits"

const limits = {
  user_daily_limit_cents: 2_500,
  global_daily_limit_cents: 20_000,
  system_tokens_daily_limit_cents: 2_500,
}

function FormFixture({
  canWrite = true,
  fieldErrors = {},
  notice = null,
  saving = false,
}: {
  canWrite?: boolean
  fieldErrors?: SpendLimitsFieldErrors
  notice?: SpendLimitsNotice | null
  saving?: boolean
}) {
  const [draft, setDraft] = useState<SpendLimitsDraft>({
    global: "200.00",
    system: "25.00",
    user: "25.00",
  })
  return (
    <SpendLimitsForm
      canWrite={canWrite}
      draft={draft}
      fieldErrors={fieldErrors}
      notice={notice}
      onChange={(key, value) => setDraft((current) => ({ ...current, [key]: value }))}
      onSubmit={fn()}
      saving={saving}
    />
  )
}

const meta = {
  title: "Features/Admin/Spend limits",
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="mx-auto max-w-5xl"><Story /></div>],
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const Summary: Story = {
  render: () => <SpendLimitsSummary limits={limits} />,
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
    await userEvent.type(input, "30.00")
    await expect(input).toHaveValue("30.00")
    await expect(canvas.getByRole("button", { name: "Save limits" })).toBeEnabled()
  },
}

export const Saving: Story = {
  render: () => <FormFixture saving />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Saving limits…" })).toBeDisabled()
  },
}

export const Invalid: Story = {
  render: () => <FormFixture fieldErrors={{ global: "Enter a non-negative dollar amount with no more than two decimal places." }} />,
}

export const SaveFailed: Story = {
  render: () => <FormFixture notice={{ kind: "error", message: "The service is unavailable. Your entries remain in the form; the current limits above are still the last confirmed server values." }} />,
}

export const Saved: Story = {
  render: () => <FormFixture notice={{ kind: "success", message: "The current limits now match the values confirmed by the server." }} />,
}

export const ReadOnly: Story = {
  render: () => <FormFixture canWrite={false} />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Save limits" })).toBeDisabled()
  },
}
