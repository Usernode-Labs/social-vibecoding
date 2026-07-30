import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"

import { AiPermissionsSettings } from "@/features/account/ai-permissions-settings"

const meta = {
  title: "Blocks/Account/AI permissions settings",
  component: AiPermissionsSettings,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="mx-auto max-w-3xl"><Story /></div>],
  args: { hasApiKey: true, readOnly: false },
  beforeEach: () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({
      grants: [
        {
          appId: 42,
          appName: "RecipeBot",
          appSlug: "recipebot",
          status: "active",
          dailyCapCents: 500,
          allowByok: true,
          spentTodayCents: 125,
          byokSpentTodayCents: 32,
        },
        {
          appId: 77,
          appName: "Pantry Planner",
          appSlug: "pantry-planner",
          status: "revoked",
          dailyCapCents: 300,
          allowByok: false,
          spentTodayCents: 0,
          byokSpentTodayCents: 0,
        },
      ],
    }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    })
    return () => { globalThis.fetch = originalFetch }
  },
} satisfies Meta<typeof AiPermissionsSettings>

export default meta
type Story = StoryObj<typeof meta>

export const Ready: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(await canvas.findByText("RecipeBot")).toBeTruthy()
    await expect(await canvas.findByText("Pantry Planner")).toBeTruthy()
    await expect(canvas.getByRole("button", { name: "Revoke access" })).toBeTruthy()
  },
}

export const ReadOnly: Story = {
  args: { readOnly: true },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", { name: "Revoke access" })
    ).toBeDisabled()
  },
}

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
}
