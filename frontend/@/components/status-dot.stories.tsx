import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"

import { StatusDot } from "@/components/status-dot"
import { appPresentationStatus } from "@/features/apps/app-presentation-status"
import { connectionPresentationStatus } from "@/features/platform/connection-presentation-status"
import { nodePresentationStatus } from "@/features/platform/node-presentation-status"

const meta = {
  title: "Foundation/Status dot",
  component: StatusDot,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="rounded-lg border bg-card p-6 text-card-foreground"><Story /></div>],
} satisfies Meta<typeof StatusDot>

export default meta
type Story = StoryObj<typeof meta>

const light = { theme: "light" }
const dark = { theme: "dark" }

export const PositiveLight: Story = { args: { role: "positive", subject: "Game Corner", label: "Running" }, globals: light }
export const PositiveDark: Story = { args: { role: "positive", subject: "Game Corner", label: "Running" }, globals: dark }
export const InfoLight: Story = { args: { role: "info", subject: "Game Corner", label: "Building" }, globals: light }
export const InfoDark: Story = { args: { role: "info", subject: "Game Corner", label: "Building" }, globals: dark }
export const WarningLight: Story = { args: { role: "warning", subject: "Game Corner", label: "Configuration required" }, globals: light }
export const WarningDark: Story = { args: { role: "warning", subject: "Game Corner", label: "Configuration required" }, globals: dark }
export const NegativeLight: Story = { args: { role: "negative", subject: "Game Corner", label: "Unavailable" }, globals: light }
export const NegativeDark: Story = { args: { role: "negative", subject: "Game Corner", label: "Unavailable" }, globals: dark }
export const AttentionLight: Story = { args: { role: "attention", subject: "Game Corner", label: "Paused" }, globals: light }
export const AttentionDark: Story = { args: { role: "attention", subject: "Game Corner", label: "Paused" }, globals: dark }
export const NeutralLight: Story = { args: { role: "neutral", subject: "Game Corner", label: "Unknown" }, globals: light }
export const NeutralDark: Story = { args: { role: "neutral", subject: "Game Corner", label: "Unknown" }, globals: dark }

export const DotOnly: Story = {
  args: { role: "positive", subject: "Game Corner", label: "Running", showLabel: false },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("img", { name: "Game Corner, running" })).toBeTruthy()
  },
}

export const WithLabel: Story = {
  args: { role: "positive", subject: "Game Corner", label: "Running" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("img", { name: "Game Corner, running" })).toBeTruthy()
  },
}
export const WithDetail: Story = { args: { role: "attention", subject: "Game Corner", label: "Paused", detail: "Needs review" } }
export const AppLifecycleAdapter: Story = {
  args: { subject: "Game Corner", ...appPresentationStatus("awaiting_secrets") },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("img", { name: "Game Corner, configuration required" })).toBeTruthy()
  },
}
export const NodeLifecycleAdapter: Story = {
  args: { subject: "Node", ...nodePresentationStatus("Synced"), showLabel: false },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("img", { name: "Node, synced" })).toBeTruthy()
  },
}
export const ConnectionLifecycleAdapter: Story = {
  args: { subject: "Notifications", ...connectionPresentationStatus("reconnecting"), showLabel: false },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("img", { name: "Notifications, reconnecting" })).toBeTruthy()
  },
}
