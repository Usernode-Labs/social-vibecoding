import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, within } from "storybook/test"

import { DeveloperPreferencesSettings } from "@/features/account/developer-preferences-settings"

const meta = {
  title: "Blocks/Account/Developer preferences settings",
  component: DeveloperPreferencesSettings,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="mx-auto max-w-3xl"><Story /></div>],
  beforeEach: () => {
    localStorage.removeItem("usernode:devConsoleMode")
    localStorage.removeItem("devchat_alerts_enabled")
  },
} satisfies Meta<typeof DeveloperPreferencesSettings>

export default meta
type Story = StoryObj<typeof meta>

export const Defaults: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole("switch", { name: /Always show developer console/ })).not.toBeChecked()
    await expect(canvas.getByRole("switch", { name: /Dev-chat sound and alerts/ })).toBeChecked()
    await expect(canvas.getByRole("button", { name: "Send a test alert" })).toBeEnabled()
  },
}

export const AlertsDisabled: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("switch", { name: /Dev-chat sound and alerts/ }))
    await expect(canvas.getByRole("button", { name: "Send a test alert" })).toBeDisabled()
  },
}

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
}
