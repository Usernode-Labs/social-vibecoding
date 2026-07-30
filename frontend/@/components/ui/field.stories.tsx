import type { Meta, StoryObj } from "@storybook/react-vite"

import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"

const meta = {
  title: "Elements/Primitives/Field",
  component: Field,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="w-screen max-w-lg px-4"><Story /></div>],
} satisfies Meta<typeof Field>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Field>
      <FieldLabel htmlFor="field-name">App name</FieldLabel>
      <Input id="field-name" placeholder="RecipeBot" />
      <FieldDescription>Use a name collaborators will recognize.</FieldDescription>
    </Field>
  ),
}

export const Invalid: Story = {
  render: () => (
    <Field data-invalid>
      <FieldLabel htmlFor="field-url">Repository URL</FieldLabel>
      <Input aria-invalid id="field-url" value="not-a-url" readOnly />
      <FieldError>Enter a complete GitHub repository URL.</FieldError>
    </Field>
  ),
}

export const Responsive: Story = {
  render: () => (
    <FieldGroup>
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="field-alerts">Completion alerts</FieldLabel>
          <FieldDescription>Notify me when a build finishes.</FieldDescription>
        </FieldContent>
        <Switch aria-label="Completion alerts" defaultChecked id="field-alerts" />
      </Field>
    </FieldGroup>
  ),
}

export const Fieldset: Story = {
  render: () => (
    <FieldSet>
      <FieldLegend>Account</FieldLegend>
      <FieldGroup>
        <Field><FieldLabel htmlFor="field-username">Username</FieldLabel><Input id="field-username" /></Field>
        <FieldSeparator>Security</FieldSeparator>
        <Field><FieldTitle>Password</FieldTitle><FieldDescription>At least eight characters.</FieldDescription></Field>
      </FieldGroup>
    </FieldSet>
  ),
}
