import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"

import { DevVisualEvidence } from "@/features/dev/dev-visual-evidence"
import type { DevVisuals } from "@/lib/dev-chat-api"

const visuals = {
  captures: [
    {
      index: 0,
      path: "/apps/recipebot/open",
      viewport: "desktop",
      before: null,
      after: { png: "0123456789abcdef0123456789abcdef" },
      beforeFellBack: true,
    },
    {
      index: 1,
      path: "/settings",
      viewport: "mobile",
      before: { png: "abcdef0123456789abcdef0123456789" },
      after: { png: "11111111111111111111111111111111" },
    },
  ],
} satisfies DevVisuals

const meta = {
  title: "Blocks/Dev/Visual evidence",
  component: DevVisualEvidence,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="mx-auto max-w-4xl"><Story /></div>],
  args: { visuals },
} satisfies Meta<typeof DevVisualEvidence>

export default meta
type Story = StoryObj<typeof meta>

export const Comparisons: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const title = canvas.getByText("Before and after").closest('[data-slot="card-title"]')
    const icon = title?.querySelector(':scope > [data-slot="platform-icon"]')
    await expect(icon).not.toBeNull()
    await expect(getComputedStyle(icon!).width).toBe("16px")
    await expect(getComputedStyle(icon!).height).toBe("16px")
    await expect(canvas.getAllByRole("region", { name: /Visual comparison/ })).toHaveLength(2)
    await expect(canvas.getByText(/production capture used the home route/)).toBeTruthy()
  },
}

export const NoCaptures: Story = {
  args: { visuals: { captures: [] } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("heading")).toBeNull()
  },
}
