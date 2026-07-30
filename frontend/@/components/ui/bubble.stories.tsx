import type { Meta, StoryObj } from "@storybook/react-vite"

import { Bubble, BubbleContent, BubbleGroup, BubbleReactions } from "@/components/ui/bubble"

const meta = {
  title: "Elements/Conversation/Bubble",
  component: Bubble,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="flex w-screen max-w-xl flex-col gap-5 px-4"><Story /></div>],
} satisfies Meta<typeof Bubble>

export default meta
type Story = StoryObj<typeof meta>

export const Incoming: Story = {
  render: () => <Bubble variant="secondary"><BubbleContent>The first pass is ready for review.</BubbleContent></Bubble>,
}

export const Outgoing: Story = {
  render: () => <Bubble align="end"><BubbleContent>I’ll check the responsive states next.</BubbleContent></Bubble>,
}

export const Reactions: Story = {
  render: () => (
    <Bubble variant="muted">
      <BubbleContent>The empty state reads much more clearly now.</BubbleContent>
      <BubbleReactions aria-label="Two positive reactions">👍 2</BubbleReactions>
    </Bubble>
  ),
}

export const Variants: Story = {
  render: () => (
    <BubbleGroup>
      <Bubble variant="tinted"><BubbleContent>Tinted</BubbleContent></Bubble>
      <Bubble variant="outline"><BubbleContent>Outline</BubbleContent></Bubble>
      <Bubble variant="ghost"><BubbleContent>Ghost</BubbleContent></Bubble>
      <Bubble variant="destructive"><BubbleContent>Build failed</BubbleContent></Bubble>
    </BubbleGroup>
  ),
}
