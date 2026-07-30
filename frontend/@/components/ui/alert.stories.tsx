import type { Meta, StoryObj } from "@storybook/react-vite"
import { CircleAlert, CircleCheck } from "lucide-react"

import { PlatformIcon } from "@/components/platform-icon"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

const meta = {
  title: "Elements/Primitives/Alert",
  component: Alert,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="w-screen max-w-xl px-4"><Story /></div>],
} satisfies Meta<typeof Alert>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Alert>
      <PlatformIcon icon={CircleCheck} />
      <AlertTitle>Changes saved</AlertTitle>
      <AlertDescription>Your settings are now active.</AlertDescription>
    </Alert>
  ),
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
