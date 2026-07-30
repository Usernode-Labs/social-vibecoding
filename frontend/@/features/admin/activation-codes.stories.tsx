import type { Meta, StoryObj } from "@storybook/react-vite"

import { ActivationCodesList } from "@/features/admin/activation-codes"

const meta = { title: "Features/Admin/Activation codes", component: ActivationCodesList, parameters: { layout: "padded" }, decorators: [(Story) => <div className="mx-auto max-w-3xl"><Story /></div>] } satisfies Meta<typeof ActivationCodesList>
export default meta
type Story = StoryObj<typeof meta>

export const AvailableAndUsed: Story = { args: { codes: [{ id: 1, code: "c82ea91f11ad", created_at: "2026-07-27", used_at: null }, { id: 2, code: "deaf2b58a554", created_at: "2026-07-20", used_at: "2026-07-21", used_by_username: "ava" }] } }
export const CopyReady: Story = { args: { canRevoke: true, codes: [{ id: 1, code: "c82ea91f11ad", created_at: "2026-07-27", used_at: null }], onCopy: () => undefined, onRevoke: () => undefined } }
export const Empty: Story = { args: { codes: [] } }
