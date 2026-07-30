import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"

import { RouteFallback } from "@/components/route-fallback"

const meta = {
  title: "Blocks/Shell/Route fallback",
  component: RouteFallback,
  parameters: { layout: "fullscreen" },
  decorators: [(Story) => <div className="flex min-h-80"><Story /></div>],
} satisfies Meta<typeof RouteFallback>

export default meta
type Story = StoryObj<typeof meta>

export const Loading: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status", { name: "Loading view" })).toBeTruthy()
  },
}
