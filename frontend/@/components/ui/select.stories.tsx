import type { Meta, StoryObj } from "@storybook/react-vite"

import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"

const meta = {
  title: "Elements/Primitives/Select",
  component: Select,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Select>

export default meta
type Story = StoryObj<typeof meta>

function ModelSelect({ disabled = false, defaultValue = "balanced" }: { disabled?: boolean; defaultValue?: string }) {
  return (
    <Select defaultValue={defaultValue} disabled={disabled}>
      <SelectTrigger aria-label="Model" className="w-64"><SelectValue placeholder="Choose a model" /></SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Recommended</SelectLabel>
          <SelectItem value="balanced">Balanced</SelectItem>
          <SelectItem value="fast">Fast</SelectItem>
          <SelectSeparator />
          <SelectItem value="deep">Deep reasoning</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

export const Default: Story = { render: () => <ModelSelect /> }
export const Placeholder: Story = { render: () => <ModelSelect defaultValue="" /> }
export const Disabled: Story = { render: () => <ModelSelect disabled /> }
