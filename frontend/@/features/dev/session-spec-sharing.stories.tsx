import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, within } from "storybook/test"

import { SpecSharingControls } from "@/features/dev/session-spec-viewer"

const meta = {
  title: "Blocks/Dev/Session spec sharing",
  component: SpecSharingControls,
  parameters: { layout: "padded" },
  args: {
    mentionSuggestions: ["Mira", "Sam", "Ava"],
    onShareGroup: async () => {},
    onShareUser: async (username: string) => ({ ok: true as const, recipient: { username } }),
    version: 3,
  },
} satisfies Meta<typeof SpecSharingControls>

export default meta
type Story = StoryObj<typeof meta>

export const Available: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Share privately" }))
    const dialog = within(document.body).getByRole("alertdialog")
    await expect(within(dialog).getByRole("list", { name: "Suggested recipients" })).toBeInTheDocument()
    await expect(within(dialog).getByText("3 suggested recipients available.")).toBeInTheDocument()
    await expect(within(dialog).getByLabelText("Username")).toHaveFocus()
  },
}
export const SharedToGroup: Story = { args: { alreadyShared: true } }
export const ProductionReview: Story = { args: { disabled: true } }
