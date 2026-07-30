import { useChat } from "@ai-sdk/react"
import { createChat } from "@shadcn/helpers/ai-sdk"
import type { Meta, StoryObj } from "@storybook/react-vite"

import { Button } from "@/components/ui/button"
import { DevConversation, type ConversationMessage } from "@/features/dev/dev-conversation"

const transcript: ConversationMessage[] = [
  { id: 1, role: "system", content: "Session started · RecipeBot", metadata: {}, model: null, created_at: "2026-07-28T09:00:00.000Z" },
  { id: 2, role: "user", content: "Add an easy pantry filter to recipe search.", metadata: {}, model: null, created_at: "2026-07-28T09:00:05.000Z" },
  { id: 3, role: "assistant", content: "I’ll inspect the current search flow first, then propose the smallest safe change.", metadata: {}, model: "Opus 5", created_at: "2026-07-28T09:00:08.000Z" },
]

const scriptedChat = createChat()
  .user("Can you also show a clear empty state?")
  .assistant(({ writer }) => {
    writer.reasoning("The user needs a clear path when no pantry ingredients match.")
    writer.text("Yes. I’ll add a clear empty state with a reset action, without changing the recipe data.")
  })

function toConversation(messages: Array<{ id: string; role: string; parts: Array<Record<string, unknown>> }>): ConversationMessage[] {
  return messages.map((message, index) => ({
    id: index + 10,
    role: message.role,
    content: message.parts.map((part) => typeof part.text === "string" ? part.text : typeof part.reasoning === "string" ? part.reasoning : "").filter(Boolean).join("\n"),
    metadata: {},
    model: message.role === "assistant" ? "Opus 5" : null,
    created_at: `2026-07-28T09:0${index + 1}:00.000Z`,
  }))
}

function StreamingConversation() {
  const { messages, sendMessage, status } = useChat({ messages: scriptedChat.get(0), transport: scriptedChat.transport({ delayMs: 15 }) })
  const nextMessage = scriptedChat.next(messages)
  const isBusy = status === "submitted" || status === "streaming"

  return <div className="flex w-[min(42rem,calc(100vw-2rem))] flex-col gap-3">
    <DevConversation messages={[...transcript, ...toConversation(messages)]} streamState={isBusy ? "streaming" : "idle"} />
    <Button disabled={!nextMessage || isBusy} onClick={() => { if (nextMessage) void sendMessage(nextMessage) }}>Replay deterministic stream</Button>
  </div>
}

const meta = {
  title: "Blocks/Dev/Conversation",
  component: DevConversation,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="w-[min(42rem,calc(100vw-2rem))] bg-background p-4"><Story /></div>],
} satisfies Meta<typeof DevConversation>

export default meta
type Story = StoryObj<typeof meta>

export const History: Story = { args: { messages: transcript } }
export const Streaming: Story = { args: { messages: transcript }, render: () => <StreamingConversation /> }
export const Disconnected: Story = { args: { messages: transcript, streamState: "error" } }
