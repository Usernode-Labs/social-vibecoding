import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"

import { Metric } from "@/components/metric"

const meta = {
  title: "Elements/Metric",
  component: Metric,
  parameters: { layout: "centered" },
  decorators: [(Story) => <dl className="w-48 text-sm"><Story /></dl>],
} satisfies Meta<typeof Metric>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: { label: "Connected once", value: "Yes" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText("Connected once").tagName).toBe("DT")
    await expect(canvas.getByText("Yes").tagName).toBe("DD")
  },
}

export const Numeric: Story = {
  args: { label: "Chain height", value: "1,234,567", numeric: true },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("1,234,567")).toHaveClass("tabular-nums")
  },
}

export const LongValue: Story = {
  args: { label: "Endpoint", value: "A long adapter-fed value remains readable without changing the semantic pair." },
}
