import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"

import { AppIdentity } from "@/features/apps/app-identity"

const meta = {
  title: "Apps/App identity",
  component: AppIdentity,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="flex items-center gap-4 rounded-lg border bg-card p-6 text-card-foreground"><Story /></div>],
} satisfies Meta<typeof AppIdentity>

export default meta
type Story = StoryObj<typeof meta>

const fallbackApp = { id: "identity-4", slug: "recipebot", name: "RecipeBot", icon_url: null }
const deterministicArtwork = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='128' height='128' viewBox='0 0 128 128'%3E%3Crect width='128' height='128' rx='24' fill='%23262626'/%3E%3Cpath d='M38 35h52v58H38z' fill='%23fafafa'/%3E%3Ccircle cx='64' cy='64' r='12' fill='%23262626'/%3E%3C/svg%3E"

export const FallbackSlot1: Story = {
  args: { app: fallbackApp },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("[data-identity-slot='1']")).toBeTruthy()
  },
}

export const FallbackSlot8: Story = {
  args: { app: { ...fallbackApp, id: "identity-1", name: "Supply Line" } },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("[data-identity-slot='8']")).toBeTruthy()
  },
}

export const RemoteImage: Story = {
  args: { app: { ...fallbackApp, icon_url: deterministicArtwork } },
  play: async ({ canvasElement }) => {
    const image = canvasElement.querySelector("img")
    await expect(image).toHaveAttribute("src", deterministicArtwork)
    await expect(image?.complete).toBe(true)
    await expect(image?.naturalWidth).toBe(128)
  },
}

export const Small: Story = { args: { app: fallbackApp, size: "sm" } }
export const Medium: Story = { args: { app: fallbackApp, size: "md" } }
export const Large: Story = { args: { app: fallbackApp, size: "lg" } }

export const RenameStable: Story = {
  args: { app: { ...fallbackApp, name: "Pantry Planner" } },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("[data-identity-slot='1']")).toBeTruthy()
  },
}

export const UnicodeMonogram: Story = {
  args: { app: { ...fallbackApp, name: "👩‍🍳 RecipeBot" } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("👩‍🍳")).toBeTruthy()
  },
}

export const NamedArtwork: Story = {
  args: { app: fallbackApp, decorative: false },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("img", { name: "RecipeBot" })).toBeTruthy()
  },
}

export const Light: Story = { args: { app: fallbackApp }, globals: { theme: "light" } }
export const Dark: Story = { args: { app: fallbackApp }, globals: { theme: "dark" } }
