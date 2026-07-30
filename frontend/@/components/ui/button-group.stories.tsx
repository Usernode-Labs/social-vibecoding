import type { Meta, StoryObj } from "@storybook/react-vite"
import { ChevronDown } from "lucide-react"

import { PlatformIcon } from "@/components/platform-icon"
import { Button } from "@/components/ui/button"
import { ButtonGroup, ButtonGroupSeparator, ButtonGroupText } from "@/components/ui/button-group"

const meta = {
  title: "Elements/Primitives/Button group",
  component: ButtonGroup,
  parameters: { layout: "centered" },
} satisfies Meta<typeof ButtonGroup>

export default meta
type Story = StoryObj<typeof meta>

export const Actions: Story = {
  render: () => (
    <ButtonGroup aria-label="App actions">
      <Button variant="outline">Open</Button>
      <Button aria-label="More app actions" size="icon" variant="outline"><PlatformIcon icon={ChevronDown} /></Button>
    </ButtonGroup>
  ),
}

export const WithText: Story = {
  render: () => (
    <ButtonGroup aria-label="Vote">
      <Button variant="outline">Support</Button>
      <ButtonGroupSeparator />
      <ButtonGroupText>12 votes</ButtonGroupText>
    </ButtonGroup>
  ),
}

export const Vertical: Story = {
  render: () => <ButtonGroup aria-label="View options" orientation="vertical"><Button variant="outline">List</Button><Button variant="outline">Board</Button><Button variant="outline">By person</Button></ButtonGroup>,
}
