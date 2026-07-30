import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, within } from "storybook/test"

import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"

const meta = {
  title: "Elements/Primitives/Switch",
  component: Switch,
  parameters: { layout: "centered" },
  args: { "aria-label": "Completion alerts" },
} satisfies Meta<typeof Switch>

export default meta
type Story = StoryObj<typeof meta>

export const Off: Story = {}
export const On: Story = { args: { defaultChecked: true } }
export const Small: Story = { args: { defaultChecked: true, size: "sm" } }
export const Disabled: Story = { args: { disabled: true } }
export const WithField: Story = {
  render: () => (
    <Field className="w-80" orientation="horizontal">
      <FieldContent><FieldLabel htmlFor="switch-field">Completion alerts</FieldLabel><FieldDescription>Notify me when builds finish.</FieldDescription></FieldContent>
      <Switch aria-label="Completion alerts" id="switch-field" />
    </Field>
  ),
  play: async ({ canvasElement }) => {
    const control = within(canvasElement).getByRole("switch", { name: "Completion alerts" })
    await userEvent.click(control)
    await expect(control).toBeChecked()
  },
}
