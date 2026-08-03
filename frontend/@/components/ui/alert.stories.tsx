import type { Meta, StoryObj } from "@storybook/react-vite"
import { CircleAlert, CircleCheck, Info, TriangleAlert, XCircle } from "lucide-react"
import { expect, within } from "storybook/test"

import { PlatformIcon } from "@/components/platform-icon"
import { Alert, AlertAction, AlertDescription, AlertTitle, AlertValue, type AlertTone } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { renderedAlpha } from "@/lib/rendered-color"

const meta = {
  title: "Elements/Primitives/Alert",
  component: Alert,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="w-screen max-w-xl px-4"><Story /></div>],
} satisfies Meta<typeof Alert>

export default meta
type Story = StoryObj

export const Default: Story = {
  render: () => (
    <Alert>
      <PlatformIcon icon={CircleCheck} />
      <AlertTitle>Changes saved</AlertTitle>
      <AlertDescription>Your settings are now active.</AlertDescription>
    </Alert>
  ),
  play: async ({ canvasElement }) => {
    const alert = within(canvasElement).getByRole("alert")
    await expect(alert).toHaveAttribute("data-surface", "container")
    await expect(renderedAlpha(getComputedStyle(alert).backgroundColor)).toBeGreaterThan(0)
    await expect(getComputedStyle(alert).boxShadow).toBe("none")
  },
}

export const Destructive: Story = {
  render: () => (
    <Alert variant="destructive">
      <PlatformIcon icon={CircleAlert} />
      <AlertTitle>Could not save changes</AlertTitle>
      <AlertDescription>Check the connection and try again.</AlertDescription>
    </Alert>
  ),
}

export const WithAction: Story = {
  render: () => (
    <Alert>
      <PlatformIcon icon={CircleAlert} />
      <AlertTitle>Connection paused</AlertTitle>
      <AlertDescription>Reconnect to receive live updates.</AlertDescription>
      <AlertAction><Button size="sm" variant="outline">Reconnect</Button></AlertAction>
    </Alert>
  ),
}

const examples: Array<{
  icon: typeof CircleCheck
  title: string
  tone: AlertTone
}> = [
  { icon: CircleCheck, title: "Changes published", tone: "positive" },
  { icon: Info, title: "Review window opens tomorrow", tone: "info" },
  { icon: TriangleAlert, title: "Connection needs attention", tone: "warning" },
  { icon: XCircle, title: "Publish failed", tone: "negative" },
]

function ToneMatrix() {
  return (
    <div className="grid gap-5">
      {examples.map(({ icon, title, tone }) => (
        <div className="grid gap-3" key={tone}>
          <Alert role="status" tone={tone}>
            <PlatformIcon icon={icon} />
            <AlertTitle>{title}</AlertTitle>
            <AlertDescription>The current state remains visible without requiring an action.</AlertDescription>
          </Alert>
          <Alert tone={tone}>
            <PlatformIcon icon={icon} />
            <AlertTitle>{title}</AlertTitle>
            <AlertDescription>One quiet recovery action is available.</AlertDescription>
            <AlertAction><Button size="sm" variant="outline">Retry</Button></AlertAction>
          </Alert>
        </div>
      ))}
      <Alert form="footer" tone="positive">
        <PlatformIcon icon={CircleCheck} />
        <AlertTitle>Auto-pay enabled</AlertTitle>
        <AlertValue>Monthly</AlertValue>
      </Alert>
    </div>
  )
}

export const StatusTonesLight: Story = {
  globals: { theme: "light" },
  render: () => <ToneMatrix />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getAllByRole("alert")).toHaveLength(4)
    await expect(canvas.getAllByRole("status")).toHaveLength(4)
    const footer = canvas.getByText("Auto-pay enabled").closest('[data-slot="alert"]')
    await expect(footer).not.toHaveAttribute("role")
    await expect(canvasElement.querySelectorAll("[data-status-tone]")).toHaveLength(9)
  },
}

export const StatusTonesDark: Story = {
  globals: { theme: "dark" },
  render: () => <ToneMatrix />,
}
