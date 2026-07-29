import type { Meta, StoryObj } from "@storybook/react-vite"
import { AppVisibilitySettings } from "@/features/apps/app-visibility-settings"

const meta = {
  title: "Apps/App visibility settings",
  component: AppVisibilitySettings,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-3xl">
        <Story />
      </div>
    ),
  ],
  args: {
    appName: "RecipeBot",
    canManage: true,
    onPropose: () => undefined,
    selfHosted: false,
  },
} satisfies Meta<typeof AppVisibilitySettings>

export default meta
type Story = StoryObj<typeof meta>

export const PrivateCollaboration: Story = {
  args: {
    current: { collabVisibility: "private", viewVisibility: "public" },
    proposal: { kind: "idle" },
  },
}

export const PublicCollaboration: Story = {
  args: {
    current: { collabVisibility: "public", viewVisibility: "public" },
    proposal: { kind: "idle" },
  },
}

export const ProposalReady: Story = {
  args: {
    current: { collabVisibility: "private", viewVisibility: "private" },
    proposal: {
      kind: "ready",
      existing: false,
      proposalHref: "/apps/recipebot/dev/sessions/71",
      prNumber: 15,
    },
  },
}

export const ExistingProposal: Story = {
  args: {
    current: { collabVisibility: "private", viewVisibility: "private" },
    proposal: {
      kind: "ready",
      existing: true,
      proposalHref: "/apps/recipebot/dev/sessions/64",
      prNumber: 12,
    },
  },
}

export const ReadOnly: Story = {
  args: {
    current: { collabVisibility: "private", viewVisibility: "private" },
    disabled: true,
    proposal: { kind: "idle" },
  },
}
