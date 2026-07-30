import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, within } from "storybook/test"

import { DevComposer } from "@/features/dev/dev-composer"

const meta = {
  title: "Features/Dev/Composer",
  component: DevComposer,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="mx-auto max-w-4xl"><Story /></div>],
  args: {
    onTurnStarted: fn(),
    quickReplies: ["Fix the failing test", "Review the latest diff"],
    sessionId: "storybook-session",
    streaming: false,
    suggestions: [],
  },
  beforeEach: () => {
    const originalFetch = globalThis.fetch
    sessionStorage.clear()
    globalThis.fetch = async (input) => {
      const path = String(input)
      if (path.includes("/api/models")) {
        return new Response(JSON.stringify({
          default: "claude-opus-5",
          models: [
            {
              id: "claude-opus-5",
              label: "Claude Opus",
              changeSize: { short: "Large", long: "Best for broad, high-risk changes." },
            },
            {
              id: "claude-sonnet-5",
              label: "Claude Sonnet",
              changeSize: { short: "Medium", long: "Good for focused changes." },
            },
          ],
        }), { headers: { "Content-Type": "application/json" }, status: 200 })
      }
      if (path.includes("/api/budget")) {
        return new Response(JSON.stringify({
          spentCents: 125,
          limitCents: 500,
          globalSpentCents: 1_250,
          globalLimitCents: 5_000,
          byokSpentCents: 0,
          aiEnabled: true,
        }), { headers: { "Content-Type": "application/json" }, status: 200 })
      }
      if (path.includes("/api/auth/me")) {
        return new Response(JSON.stringify({
          user: { hasApiKey: false, keyLast4: null },
        }), { headers: { "Content-Type": "application/json" }, status: 200 })
      }
      return new Response(JSON.stringify({ error: "Unexpected Storybook request" }), {
        headers: { "Content-Type": "application/json" },
        status: 500,
      })
    }
    return () => { globalThis.fetch = originalFetch }
  },
} satisfies Meta<typeof DevComposer>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(await canvas.findByText("Claude Opus — Large")).toBeTruthy()
    await expect(canvas.getByRole("button", { name: "Send message" })).toBeDisabled()
  },
}

export const Draft: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByLabelText("Message for Builder"), "Audit the real component graph.")
    await expect(canvas.getByRole("button", { name: "Send message" })).toBeEnabled()
  },
}

export const Streaming: Story = {
  args: { streaming: true },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Save message as a draft" })).toBeDisabled()
  },
}

export const SuggestedAnswer: Story = {
  args: {
    quickReplies: [],
    suggestions: [
      { question: "Which scope?", answers: ["Only the failing route", "All related routes"] },
    ],
  },
}

export const Disabled: Story = {
  args: { disabled: true },
}

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
}
