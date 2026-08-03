import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"

import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { renderedAlpha } from "@/lib/rendered-color"

const meta = {
  title: "Elements/Primitives/Input",
  component: Input,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="w-screen max-w-sm px-4"><Story /></div>],
  args: { "aria-label": "App name", placeholder: "RecipeBot" },
} satisfies Meta<typeof Input>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByRole("textbox", { name: "App name" })
    await expect(input).toHaveAttribute("data-surface", "container")
    await expect(renderedAlpha(getComputedStyle(input).backgroundColor)).toBeGreaterThan(0)
    await expect(getComputedStyle(input).borderTopStyle).toBe("solid")
    await expect(getComputedStyle(input).borderTopWidth).not.toBe("0px")
  },
}
export const Filled: Story = { args: { defaultValue: "RecipeBot" } }
export const Disabled: Story = { args: { defaultValue: "Unavailable", disabled: true } }
export const Password: Story = { args: { "aria-label": "Password", type: "password", defaultValue: "secret-passphrase" } }
export const Invalid: Story = {
  render: () => (
    <Field data-invalid>
      <FieldLabel htmlFor="input-invalid">App name</FieldLabel>
      <Input aria-invalid id="input-invalid" value="" readOnly />
      <FieldDescription>Use up to 80 characters.</FieldDescription>
      <FieldError>App name is required.</FieldError>
    </Field>
  ),
}
