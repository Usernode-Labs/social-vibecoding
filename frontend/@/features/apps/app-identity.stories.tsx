import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"

import { AppIdentity } from "@/features/apps/app-identity"

const meta = {
  title: "Elements/App identity",
  component: AppIdentity,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="flex items-center gap-4 rounded-lg border bg-card p-6 text-card-foreground"><Story /></div>],
} satisfies Meta<typeof AppIdentity>

export default meta
type Story = StoryObj<typeof meta>

const fallbackApp = { id: "identity-4", slug: "recipebot", name: "RecipeBot", icon_url: null }
const deterministicArtwork = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl2gAAAAASUVORK5CYII="

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
    await expect(image?.naturalWidth).toBe(1)
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
