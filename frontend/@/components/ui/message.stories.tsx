import type { Meta, StoryObj } from "@storybook/react-vite"
import { Bot } from "lucide-react"
import { expect, within } from "storybook/test"

import { PlatformIcon } from "@/components/platform-icon"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageGroup, MessageHeader } from "@/components/ui/message"

const meta = {
  title: "Elements/Conversation/Message",
  component: Message,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="w-screen max-w-2xl px-4"><Story /></div>],
} satisfies Meta<typeof Message>

export default meta
type Story = StoryObj<typeof meta>

export const Incoming: Story = {
  render: () => (
    <Message>
      <MessageAvatar><Avatar><AvatarFallback>MI</AvatarFallback></Avatar></MessageAvatar>
      <MessageContent>
        <MessageHeader>Mira</MessageHeader>
        <Bubble variant="secondary"><BubbleContent>The navigation change is ready to review.</BubbleContent></Bubble>
        <MessageFooter>09:42</MessageFooter>
      </MessageContent>
    </Message>
  ),
}

export const IconAvatar: Story = {
  render: () => (
    <Message>
      <MessageAvatar><PlatformIcon icon={Bot} /></MessageAvatar>
      <MessageContent>
        <MessageHeader>Builder</MessageHeader>
        <Bubble variant="secondary"><BubbleContent>I’ll inspect the current route first.</BubbleContent></Bubble>
      </MessageContent>
    </Message>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const message = canvas.getByText("Builder").closest('[data-slot="message"]')
    const avatar = message?.querySelector('[data-slot="message-avatar"]')
    const icon = avatar?.querySelector(':scope > [data-slot="platform-icon"]')
    await expect(avatar).not.toBeNull()
    await expect(getComputedStyle(avatar!).width).toBe("32px")
    await expect(getComputedStyle(avatar!).height).toBe("32px")
    await expect(icon).not.toBeNull()
    await expect(getComputedStyle(icon!).width).toBe("16px")
    await expect(getComputedStyle(icon!).height).toBe("16px")
  },
}

export const Outgoing: Story = {
  render: () => (
    <Message align="end">
      <MessageContent>
        <MessageHeader>You</MessageHeader>
        <Bubble align="end"><BubbleContent>I’ll verify it at the narrow breakpoint.</BubbleContent></Bubble>
        <MessageFooter>09:43 · Sent</MessageFooter>
      </MessageContent>
    </Message>
  ),
}

export const Grouped: Story = {
  render: () => (
    <MessageGroup>
      <Message><MessageContent><Bubble variant="secondary"><BubbleContent>First message.</BubbleContent></Bubble></MessageContent></Message>
      <Message><MessageContent><Bubble variant="secondary"><BubbleContent>Follow-up without repeating the avatar.</BubbleContent></Bubble></MessageContent></Message>
    </MessageGroup>
  ),
}
