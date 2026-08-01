import type { Meta, StoryObj } from "@storybook/react-vite"
import { Award, Check } from "lucide-react"
import { expect, userEvent, within } from "storybook/test"

import { PlatformIcon } from "@/components/platform-icon"
import { StatusDot } from "@/components/status-dot"
import { StreamRow } from "@/components/stream-row"
import type { StreamRowProps } from "@/components/stream-row"
import { Button } from "@/components/ui/button"

const typeContractBase = {
  accessibleName: "Open activity",
  metadata: "Activity metadata",
  title: "Activity title",
  to: "/notifications",
} as const

const defaultWithAction = { ...typeContractBase, secondaryAction: "Open" } satisfies StreamRowProps
const unreadWithAction = { ...typeContractBase, state: "unread", secondaryAction: "Mark read" } satisfies StreamRowProps
const readWithoutAction = { ...typeContractBase, state: "read" } satisfies StreamRowProps
// @ts-expect-error Unread rows require a sibling action.
const unreadWithoutAction = { ...typeContractBase, state: "unread" } satisfies StreamRowProps
// @ts-expect-error Read rows forbid a sibling action.
const readWithAction = { ...typeContractBase, state: "read", secondaryAction: "Dead gutter" } satisfies StreamRowProps

void [defaultWithAction, unreadWithAction, readWithoutAction, unreadWithoutAction, readWithAction]

function UnreadRow() {
  return (
    <StreamRow
      accessibleName="Open activity: Could you review the pantry filter?"
      anchor={<StatusDot label="Unread" role="attention" showLabel={false} size="sm" subject="RecipeBot" />}
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
        anchor={<StatusDot label="Unread" role="attention" showLabel={false} size="sm" subject="Activity" />}
        metadata="@avery-long-user-name · a long metadata value that must remain quiet and truncate"
        secondaryAction={<Button className="pointer-coarse:min-h-12" size="sm" type="button" variant="ghost"><PlatformIcon data-icon="inline-start" icon={Check} />Mark read</Button>}
        state="unread"
        title="A deliberately long activity title that must not push its sibling action out of the row"
        to="/notifications"
      />
    </div>
  ),
}

export const ComparableRecords: Story = {
  render: () => (
    <div className="w-full max-w-2xl overflow-hidden rounded-2xl border bg-background">
      <StreamRow
        accessibleName="View Make recipes easier to find"
        anchor={<span aria-label="Rank 1" className="font-medium tabular-nums">1</span>}
        metadata="@ava · RecipeBot"
        state="default"
        title="Make recipes easier to find"
        to="/apps/recipebot/dev/proposals/42"
        trailing={<span className="flex flex-col items-end"><strong className="text-base text-foreground tabular-nums">12</strong><span>Kudos</span></span>}
      />
      <StreamRow
        accessibleName="View Improve pantry search session"
        anchor={<PlatformIcon icon={Award} />}
        metadata="RecipeBot"
        state="default"
        title="Improve pantry search"
        to="/apps/recipebot/dev/sessions/23"
        trailing="Working"
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll('[data-stream-state="default"]')).toHaveLength(2)
    await expect(canvasElement.querySelectorAll('[data-slot="stream-row-anchor"]')).toHaveLength(2)
    await expect(canvasElement.querySelectorAll('[data-slot="stream-row-trailing"]')).toHaveLength(2)

    for (const row of canvasElement.querySelectorAll('[data-slot="stream-row"]')) {
      await expect(row.querySelectorAll("a")).toHaveLength(1)
      await expect(row.querySelector("a button")).toBeNull()
    }
  },
}
