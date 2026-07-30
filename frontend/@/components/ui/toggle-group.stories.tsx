import type { Meta, StoryObj } from "@storybook/react-vite"

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

export const Vertical: Story = {
  render: () => <ToggleGroup aria-label="Visibility" defaultValue={["private"]} orientation="vertical" variant="outline"><ToggleGroupItem value="private">Private</ToggleGroupItem><ToggleGroupItem value="public">Public</ToggleGroupItem></ToggleGroup>,
}

export const Disabled: Story = {
  render: () => <ToggleGroup aria-label="Workspace view" defaultValue={["board"]} disabled><ToggleGroupItem value="list">List</ToggleGroupItem><ToggleGroupItem value="board">Board</ToggleGroupItem></ToggleGroup>,
}
