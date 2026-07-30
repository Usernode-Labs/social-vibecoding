import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, within } from "storybook/test"

import {
  CreateAppForm,
  type CreateAppMode,
} from "@/features/apps/create-app"
import type { AppVisibility, VerifyRepoAccess } from "@/lib/apps-api"

const verifiedRepository = {
  ok: true,
  owner: "example",
  repo: "recipebot",
  name: "RecipeBot",
  description: "Plan meals from what you already have.",
  fullName: "example/recipebot",
} satisfies VerifyRepoAccess

function FormFixture({
  checking = false,
  disabled = false,
  initialAccess = null,
  initialMode = "new",
  initialName = "",
  submitting = false,
}: {
  checking?: boolean
  disabled?: boolean
  initialAccess?: VerifyRepoAccess | null
  initialMode?: CreateAppMode
  initialName?: string
  submitting?: boolean
}) {
  const [access, setAccess] = useState(initialAccess)
  const [collabVisibility, setCollabVisibility] = useState<AppVisibility>("public")
  const [mode, setMode] = useState(initialMode)
  const [name, setName] = useState(initialName)
  const [repoUrl, setRepoUrl] = useState(initialAccess ? "https://github.com/example/recipebot" : "")
  const [viewVisibility, setViewVisibility] = useState<AppVisibility>("public")
  return (
    <CreateAppForm
      access={access}
      checking={checking}
      collabVisibility={collabVisibility}
      disabled={disabled}
      mode={mode}
      name={name}
      onCheckAccess={() => setAccess(verifiedRepository)}
      onCollabVisibilityChange={(value) => {
        setCollabVisibility(value)
        if (value === "public") setViewVisibility("public")
      }}
      onModeChange={(value) => {
        setMode(value)
        setAccess(null)
      }}
      onNameChange={setName}
      onRepoUrlChange={(value) => {
        setRepoUrl(value)
        setAccess(null)
      }}
      onSubmit={fn((event) => event.preventDefault())}
      onViewVisibilityChange={setViewVisibility}
      repoUrl={repoUrl}
      submitting={submitting}
      viewVisibility={viewVisibility}
    />
  )
}

const meta = {
  title: "Features/Apps/Create app form",
  component: CreateAppForm,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="mx-auto max-w-2xl"><Story /></div>],
  args: {
    access: null,
    checking: false,
    collabVisibility: "public",
    disabled: false,
    mode: "new",
    name: "",
    onCheckAccess: fn(),
    onCollabVisibilityChange: fn(),
    onModeChange: fn(),
    onNameChange: fn(),
    onRepoUrlChange: fn(),
    onSubmit: fn((event) => event.preventDefault()),
    onViewVisibilityChange: fn(),
    repoUrl: "",
    submitting: false,
    viewVisibility: "public",
  },
} satisfies Meta<typeof CreateAppForm>

export default meta
type Story = StoryObj<typeof meta>

export const NewApp: Story = {
  render: () => <FormFixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole("button", { name: "Create app" })).toBeDisabled()
    await userEvent.type(canvas.getByLabelText("App name"), "RecipeBot")
    await expect(canvas.getByRole("button", { name: "Create app" })).toBeEnabled()
  },
}

export const ImportNeedsVerification: Story = {
  render: () => <FormFixture initialMode="import" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByLabelText("GitHub repository URL"), "https://github.com/example/recipebot")
    await userEvent.click(canvas.getByRole("button", { name: "Check access" }))
    await expect(canvas.getByRole("status")).toHaveTextContent("usernode-bot has Write access")
  },
}

export const ImportVerified: Story = {
  render: () => <FormFixture initialAccess={verifiedRepository} initialMode="import" initialName="RecipeBot" />,
}

export const Private: Story = {
  render: () => <FormFixture initialName="Private workspace" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("radio", { name: /Invite-only/ }))
    await expect(canvas.getByRole("radio", { name: /Members/ })).toBeEnabled()
  },
}

export const Checking: Story = {
  render: () => <FormFixture checking initialMode="import" />,
}

export const Submitting: Story = {
  render: () => <FormFixture initialName="RecipeBot" submitting />,
}

export const ReadOnly: Story = {
  render: () => <FormFixture disabled initialName="RecipeBot" />,
}

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  render: () => <FormFixture initialName="RecipeBot" />,
}
