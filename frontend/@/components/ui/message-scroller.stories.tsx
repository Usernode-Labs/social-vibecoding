import type { Meta, StoryObj } from "@storybook/react-vite"

import { Bubble, BubbleContent } from "@/components/ui/bubble"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"

const meta = {
  title: "Elements/Conversation/Message scroller",
  component: MessageScroller,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="h-80 w-screen max-w-xl px-4"><Story /></div>],
} satisfies Meta<typeof MessageScroller>

export default meta
type Story = StoryObj<typeof meta>

const messages = Array.from({ length: 12 }, (_, index) => `Message ${index + 1}: deterministic conversation content.`)

export const Conversation: Story = {
  render: () => (
    <MessageScrollerProvider>
      <MessageScroller aria-label="Conversation" className="rounded-2xl" surface="container">
        <MessageScrollerViewport>
          <MessageScrollerContent className="gap-3 p-4">
            {messages.map((message, index) => (
              <MessageScrollerItem key={message} scrollAnchor={index === messages.length - 1}>
                <Bubble align={index % 2 ? "end" : "start"} variant={index % 2 ? "default" : "secondary"}>
                  <BubbleContent>{message}</BubbleContent>
                </Bubble>
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  ),
}

export const Empty: Story = {
  render: () => (
    <MessageScrollerProvider>
      <MessageScroller aria-label="Empty conversation" className="rounded-2xl" surface="container">
        <MessageScrollerViewport><MessageScrollerContent className="items-center justify-center p-4 text-sm text-muted-foreground">No messages yet.</MessageScrollerContent></MessageScrollerViewport>
      </MessageScroller>
    </MessageScrollerProvider>
  ),
}
