import type { Meta, StoryObj } from "@storybook/react-vite"
import { Check } from "lucide-react"
import { expect, userEvent, within } from "storybook/test"

import { PlatformIcon } from "@/components/platform-icon"
import { StatusDot } from "@/components/status-dot"
import { StreamRow } from "@/components/stream-row"
import { Button } from "@/components/ui/button"

function UnreadRow() {
  return (
    <StreamRow
      accessibleName="Open activity: Could you review the pantry filter?"
      indicator={<StatusDot label="Unread" role="attention" showLabel={false} size="sm" subject="RecipeBot" />}
      metadata="@ava · mention"
      secondaryAction={
        <Button className="pointer-coarse:min-h-12" size="sm" type="button" variant="ghost">
          <PlatformIcon data-icon="inline-start" icon={Check} />
          Mark read
        </Button>
      }
      state="unread"
      title="Could you review the pantry filter?"
      to="/apps/recipebot/dev/chat"
    />
  )
}

function Pair() {
  return (
    <div className="w-full max-w-2xl overflow-hidden rounded-2xl border bg-background">
      <UnreadRow />
      <StreamRow
        accessibleName="Open activity: The proposal has a reply"
        metadata="@mira · reply"
        state="read"
        title="The proposal has a reply"
        to="/apps/recipebot/dev/proposals/12"
      />
    </div>
  )
}

const meta = {
  title: "Blocks/Streams/Stream row",
  component: StreamRow,
  parameters: { layout: "centered" },
  args: {
    accessibleName: "Open activity",
    metadata: "Activity metadata",
    state: "read",
    title: "Activity title",
    to: "/notifications",
  },
  render: () => <Pair />,
} satisfies Meta<typeof StreamRow>

export default meta
type Story = StoryObj<typeof meta>

export const ReadAndUnread: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const unread = canvasElement.querySelector('[data-read-state="unread"]')
    const read = canvasElement.querySelector('[data-read-state="read"]')
    await expect(unread?.querySelectorAll("a")).toHaveLength(1)
    await expect(unread?.querySelector("a button")).toBeNull()
    await expect(within(unread as HTMLElement).getByRole("button", { name: "Mark read" })).toBeTruthy()
    await expect(read?.querySelector('[data-slot="stream-row-action"]')).toBeNull()

    await userEvent.tab()
    await expect(canvas.getByRole("link", { name: "Open activity: Could you review the pantry filter?" })).toHaveFocus()
    await userEvent.tab()
    await expect(canvas.getByRole("button", { name: "Mark read" })).toHaveFocus()
  },
}

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
}

export const Dark: Story = {
  globals: { theme: "dark" },
}

export const LongContent: Story = {
  render: () => (
    <div className="w-full max-w-sm overflow-hidden rounded-2xl border bg-background">
      <StreamRow
        accessibleName="Open long activity"
        indicator={<StatusDot label="Unread" role="attention" showLabel={false} size="sm" subject="Activity" />}
        metadata="@avery-long-user-name · a long metadata value that must remain quiet and truncate"
        secondaryAction={<Button className="pointer-coarse:min-h-12" size="sm" type="button" variant="ghost"><PlatformIcon data-icon="inline-start" icon={Check} />Mark read</Button>}
        state="unread"
        title="A deliberately long activity title that must not push its sibling action out of the row"
        to="/notifications"
      />
    </div>
  ),
}
