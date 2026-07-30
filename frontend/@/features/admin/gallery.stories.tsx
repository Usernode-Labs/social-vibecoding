import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, within } from "storybook/test"

import { GalleryFiltersPanel } from "@/features/admin/gallery"
import type { GalleryFilters } from "@/lib/gallery-api"

const apps = [
  { id: 1, slug: "recipebot", name: "RecipeBot", proposal_count: 8 },
  { id: 2, slug: "pantry-planner", name: "Pantry Planner", proposal_count: 3 },
]

function FiltersFixture({ disabled = false, onSubmit = fn() }: { disabled?: boolean; onSubmit?: () => void }) {
  const [draft, setDraft] = useState<GalleryFilters>({ app: "", problem: "" })
  return <GalleryFiltersPanel apps={apps} disabled={disabled} draft={draft} onChange={setDraft} onSubmit={onSubmit} />
}

const meta = {
  title: "Features/Admin/Gallery filters",
  component: GalleryFiltersPanel,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="mx-auto max-w-5xl"><Story /></div>],
  args: {
    apps,
    disabled: false,
    draft: { app: "", problem: "" },
    onChange: fn(),
    onSubmit: fn(),
  },
} satisfies Meta<typeof GalleryFiltersPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Ready: Story = {
  render: () => <FiltersFixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole("form", { name: "Screenshot gallery filters" })).toBeTruthy()
    await expect(canvas.getByRole("button", { name: "Apply filters" })).toBeEnabled()
  },
}

export const Loading: Story = {
  render: () => <FiltersFixture disabled />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Apply filters" })).toBeDisabled()
  },
}

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  render: () => <FiltersFixture />,
}
