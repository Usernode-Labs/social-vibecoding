import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, within } from "storybook/test"

import { AgentFilesSettings } from "@/features/account/agent-files-settings"

const meta = {
  title: "Blocks/Account/Agent files settings",
  component: AgentFilesSettings,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="mx-auto max-w-3xl"><Story /></div>],
  args: { readOnly: false },
  beforeEach: () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({
      files: [
        {
          kind: "instruction",
          name: "review-rules",
          description: "",
          sizeBytes: 1_248,
          updatedAt: "2026-07-30T12:00:00.000Z",
        },
        {
          kind: "skill",
          name: "release-notes",
          description: "Prepare concise release notes from the shipped diff.",
          sizeBytes: 3_840,
          updatedAt: "2026-07-29T18:20:00.000Z",
        },
      ],
      limits: { maxFilesPerKind: 10, maxFileBytes: 49_152 },
    }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    })
    return () => { globalThis.fetch = originalFetch }
  },
} satisfies Meta<typeof AgentFilesSettings>

export default meta
type Story = StoryObj<typeof meta>

export const Ready: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(await canvas.findByText("review-rules")).toBeTruthy()
    await userEvent.click(canvas.getByRole("tab", { name: /Skills/ }))
    await expect(await canvas.findByText("release-notes")).toBeTruthy()
  },
}

export const ReadOnly: Story = {
  args: { readOnly: true },
  play: async ({ canvasElement }) => {
    const upload = await within(canvasElement).findByRole("button", { name: "Upload instruction" })
    await expect(upload).toBeDisabled()
  },
}

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
}
