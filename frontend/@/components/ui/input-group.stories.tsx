import type { Meta, StoryObj } from "@storybook/react-vite"
import { Search, Send, X } from "lucide-react"

import { PlatformIcon } from "@/components/platform-icon"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
} from "@/components/ui/input-group"

const meta = {
  title: "Elements/Primitives/Input group",
  component: InputGroup,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="w-screen max-w-xl px-4"><Story /></div>],
} satisfies Meta<typeof InputGroup>

export default meta
type Story = StoryObj<typeof meta>

export const SearchInput: Story = {
  render: () => (
    <InputGroup>
      <InputGroupAddon><PlatformIcon icon={Search} /><InputGroupText>Search</InputGroupText></InputGroupAddon>
      <InputGroupInput aria-label="Search apps" placeholder="Name or description" />
      <InputGroupAddon align="inline-end">
        <InputGroupButton aria-label="Clear search" size="icon-xs"><PlatformIcon icon={X} /></InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  ),
}

export const Composer: Story = {
  render: () => (
    <InputGroup>
      <InputGroupTextarea aria-label="Message" placeholder="Describe the change…" />
      <InputGroupAddon align="block-end">
        <InputGroupText>Markdown supported</InputGroupText>
        <InputGroupButton className="ml-auto" variant="default"><PlatformIcon data-icon="inline-start" icon={Send} />Send</InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  ),
}

export const Invalid: Story = {
  render: () => <InputGroup><InputGroupInput aria-invalid aria-label="Repository URL" value="invalid" readOnly /><InputGroupAddon align="inline-end">Invalid URL</InputGroupAddon></InputGroup>,
}
