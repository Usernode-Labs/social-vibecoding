import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, within } from "storybook/test"

import { AppMemberInviteForm } from "@/features/apps/app-members"
import type { UserSearchResult } from "@/lib/collaborators-api"

const suggestions = [
  { id: 7, username: "ava" },
  { id: 12, username: "morgan" },
] satisfies UserSearchResult[]

function InviteFixture({
  canInvite = true,
  error = null,
  inviting = false,
  initialQuery = "av",
  searchError = null,
}: {
  canInvite?: boolean
  error?: string | null
  inviting?: boolean
  initialQuery?: string
  searchError?: string | null
}) {
  const [query, setQuery] = useState(initialQuery)
  const [visibleSuggestions, setVisibleSuggestions] = useState(suggestions)
  return (
    <AppMemberInviteForm
      canInvite={canInvite}
      error={error}
      inviting={inviting}
      onQueryChange={setQuery}
      onSelectSuggestion={(username) => {
        setQuery(username)
        setVisibleSuggestions([])
      }}
      onSubmit={fn((event) => event.preventDefault())}
      query={query}
      searchError={searchError}
      suggestions={visibleSuggestions}
    />
  )
}

const meta = {
  title: "Features/Apps/Member invite form",
  component: AppMemberInviteForm,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="mx-auto max-w-2xl"><Story /></div>],
  args: {
    canInvite: true,
    error: null,
    inviting: false,
    onQueryChange: fn(),
    onSelectSuggestion: fn(),
    onSubmit: fn((event) => event.preventDefault()),
    query: "av",
    searchError: null,
    suggestions,
  },
} satisfies Meta<typeof AppMemberInviteForm>

export default meta
type Story = StoryObj<typeof meta>

export const Suggestions: Story = {
  render: () => <InviteFixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "@ava" }))
    await expect(canvas.getByLabelText("Username")).toHaveValue("ava")
    await expect(canvas.queryByRole("list", { name: "Invite suggestions" })).toBeNull()
  },
}

export const Empty: Story = {
  render: () => <InviteFixture initialQuery="" />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Send invite" })).toBeDisabled()
  },
}

export const Inviting: Story = {
  render: () => <InviteFixture inviting />,
}

export const Error: Story = {
  render: () => <InviteFixture error="This person is already a collaborator." />,
}

export const ReadOnly: Story = {
  render: () => <InviteFixture canInvite={false} />,
}
