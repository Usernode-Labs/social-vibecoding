import type { Meta, StoryObj } from "@storybook/react-vite"

import { Avatar, AvatarBadge, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage } from "@/components/ui/avatar"

const meta = {
  title: "Elements/Primitives/Avatar",
  component: Avatar,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Avatar>

export default meta
type Story = StoryObj<typeof meta>

export const Fallback: Story = {
  render: () => <Avatar><AvatarFallback>CM</AvatarFallback></Avatar>,
}

export const Image: Story = {
  render: () => (
    <Avatar size="lg">
      <AvatarImage alt="Casey Morgan" src="https://i.pravatar.cc/160?img=12" />
      <AvatarFallback>CM</AvatarFallback>
    </Avatar>
  ),
}

export const Presence: Story = {
  render: () => <Avatar size="lg"><AvatarFallback>CM</AvatarFallback><AvatarBadge><span className="sr-only">Online</span></AvatarBadge></Avatar>,
}

export const Group: Story = {
  render: () => (
    <AvatarGroup aria-label="Four collaborators">
      <Avatar><AvatarFallback>CM</AvatarFallback></Avatar>
      <Avatar><AvatarFallback>AK</AvatarFallback></Avatar>
      <Avatar><AvatarFallback>JS</AvatarFallback></Avatar>
      <AvatarGroupCount>+1</AvatarGroupCount>
    </AvatarGroup>
  ),
}
