import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, within } from "storybook/test"

import { FeedbackFormView } from "@/features/feedback/feedback"
import type { AppDetail } from "@/lib/apps-api"
import type { FeedbackTarget } from "@/lib/feedback-api"

const app = {
  id: "recipebot",
  slug: "recipebot",
  name: "RecipeBot",
  status: "running",
  active_users: 24,
  is_favorited: true,
  is_collaborator: true,
  your_apps_hidden: false,
  favorite_order: 0,
  open_prs: 2,
  active_sessions: 1,
  open_issues: 4,
  repo_url: "https://github.com/example/recipebot",
} satisfies AppDetail

function FormFixture({
  appTarget = null,
  disabled = false,
  error = null,
  initialDescription = "",
  submitting = false,
}: {
  appTarget?: AppDetail | null
  disabled?: boolean
  error?: string | null
  initialDescription?: string
  submitting?: boolean
}) {
  const [description, setDescription] = useState(initialDescription)
  const [target, setTarget] = useState<FeedbackTarget>(appTarget ? "app" : "platform")
  const [title, setTitle] = useState("")
  return (
    <FeedbackFormView
      appTarget={appTarget}
      description={description}
      disabled={disabled}
      error={error}
      onDescriptionChange={setDescription}
      onSubmit={fn((event) => event.preventDefault())}
      onTargetChange={setTarget}
      onTitleChange={setTitle}
      submitting={submitting}
      target={target}
      title={title}
    />
  )
}

const meta = {
  title: "Features/Feedback/Form",
  component: FeedbackFormView,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="mx-auto max-w-3xl"><Story /></div>],
  args: {
    appTarget: null,
    description: "",
    disabled: false,
    error: null,
    onDescriptionChange: fn(),
    onSubmit: fn((event) => event.preventDefault()),
    onTargetChange: fn(),
    onTitleChange: fn(),
    submitting: false,
    target: "platform",
    title: "",
  },
} satisfies Meta<typeof FeedbackFormView>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  render: () => <FormFixture />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Submit feedback" })).toBeDisabled()
  },
}

export const Ready: Story = {
  render: () => <FormFixture initialDescription="Add a compact filter for archived work." />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole("button", { name: "Submit feedback" })).toBeEnabled()
    await userEvent.type(canvas.getByLabelText(/Title/), "Archived work filter")
    await expect(canvas.getByLabelText(/Title/)).toHaveValue("Archived work filter")
  },
}

export const AppTarget: Story = {
  render: () => <FormFixture appTarget={app} initialDescription="The recipe cards need clearer dietary labels." />,
}

export const Error: Story = {
  render: () => <FormFixture error="The feedback service is unavailable." initialDescription="Keep the draft visible." />,
}

export const Submitting: Story = {
  render: () => <FormFixture initialDescription="Submitting this feedback." submitting />,
}

export const ReadOnly: Story = {
  render: () => <FormFixture disabled initialDescription="This remains visible but cannot be sent." />,
}

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  render: () => <FormFixture appTarget={app} initialDescription="Make the controls easier to reach." />,
}
