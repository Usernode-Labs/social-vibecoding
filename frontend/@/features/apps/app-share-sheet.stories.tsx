import type { Meta, StoryObj } from "@storybook/react-vite"

import { AppShareSheet } from "@/features/apps/app-share-sheet"

const meta = {
  title: "Apps/App share sheet",
  component: AppShareSheet,
  args: {
    appName: "RecipeBot",
    url: "https://recipebot.example.test/",
  },
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof AppShareSheet>

export default meta
type Story = StoryObj<typeof meta>

export const Trigger: Story = {}

export const Open: Story = {
  args: {
    defaultOpen: true,
  },
}
