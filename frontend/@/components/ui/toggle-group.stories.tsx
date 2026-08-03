import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

const meta = {
  title: "Elements/Primitives/Toggle group",
  component: ToggleGroup,
  parameters: { layout: "centered" },
} satisfies Meta<typeof ToggleGroup>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => <ToggleGroup aria-label="Workspace view" defaultValue={["board"]}><ToggleGroupItem value="list">List</ToggleGroupItem><ToggleGroupItem value="board">Board</ToggleGroupItem><ToggleGroupItem value="people">By person</ToggleGroupItem></ToggleGroup>,
}

export const Segmented: Story = {
  render: () => <ToggleGroup aria-label="Theme" defaultValue={["system"]} spacing={0} variant="outline"><ToggleGroupItem value="light">Light</ToggleGroupItem><ToggleGroupItem value="dark">Dark</ToggleGroupItem><ToggleGroupItem value="system">System</ToggleGroupItem></ToggleGroup>,
}

export const ElevatedSelected: Story = {
  render: () => <ToggleGroup aria-label="Theme" defaultValue={["system"]} selectionVariant="elevated" size="sm" spacing={1}><ToggleGroupItem value="light">Light</ToggleGroupItem><ToggleGroupItem value="dark">Dark</ToggleGroupItem><ToggleGroupItem value="system">System</ToggleGroupItem></ToggleGroup>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const group = canvas.getByRole("group", { name: "Theme" })
    const unselected = canvas.getByRole("button", { name: "Light" })
    const selected = canvas.getByRole("button", { name: "System" })
    await expect(group).toHaveAttribute("data-surface", "recess")
    await expect(selected).toHaveAttribute("aria-pressed", "true")
    await expect(selected).toHaveAttribute("data-selection-variant", "elevated")
    await expect(getComputedStyle(selected).backgroundColor).not.toBe(getComputedStyle(unselected).backgroundColor)
  },
}

export const Vertical: Story = {
  render: () => <ToggleGroup aria-label="Visibility" defaultValue={["private"]} orientation="vertical" variant="outline"><ToggleGroupItem value="private">Private</ToggleGroupItem><ToggleGroupItem value="public">Public</ToggleGroupItem></ToggleGroup>,
}

export const Disabled: Story = {
  render: () => <ToggleGroup aria-label="Workspace view" defaultValue={["board"]} disabled><ToggleGroupItem value="list">List</ToggleGroupItem><ToggleGroupItem value="board">Board</ToggleGroupItem></ToggleGroup>,
}
