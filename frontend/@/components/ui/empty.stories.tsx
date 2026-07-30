import type { Meta, StoryObj } from "@storybook/react-vite"
import { Inbox } from "lucide-react"

import { PlatformIcon } from "@/components/platform-icon"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

const meta = {
  title: "Elements/Primitives/Empty",
  component: Empty,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="mx-4 w-screen max-w-2xl rounded-3xl border"><Story /></div>],
} satisfies Meta<typeof Empty>

export default meta
type Story = StoryObj<typeof meta>

export const Message: Story = {
  render: () => (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon"><PlatformIcon icon={Inbox} /></EmptyMedia>
        <EmptyTitle>No activity yet</EmptyTitle>
        <EmptyDescription>Messages and invitations will appear here.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  ),
}

export const WithAction: Story = {
  render: () => (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon"><PlatformIcon icon={Inbox} /></EmptyMedia>
        <EmptyTitle>No saved apps</EmptyTitle>
        <EmptyDescription>Explore the community catalog to add one.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent><Button>Explore apps</Button></EmptyContent>
    </Empty>
  ),
}
