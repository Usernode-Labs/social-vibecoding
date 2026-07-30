import type { Meta, StoryObj } from "@storybook/react-vite"

import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"

const meta = {
  title: "Elements/Primitives/Textarea",
  component: Textarea,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="w-screen max-w-lg px-4"><Story /></div>],
  args: { "aria-label": "Feedback", placeholder: "Describe the issue or suggestion…" },
} satisfies Meta<typeof Textarea>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Filled: Story = { args: { defaultValue: "The pantry controls are difficult to find on a small screen." } }
export const Disabled: Story = { args: { defaultValue: "Read-only feedback", disabled: true } }
export const Invalid: Story = {
  render: () => (
    <Field data-invalid>
      <FieldLabel htmlFor="textarea-invalid">Feedback</FieldLabel>
      <Textarea aria-invalid id="textarea-invalid" value="" readOnly />
      <FieldDescription>Describe what should improve.</FieldDescription>
      <FieldError>Feedback is required.</FieldError>
    </Field>
  ),
}
