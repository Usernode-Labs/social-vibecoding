import type { Meta, StoryObj } from "@storybook/react-vite"

import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"

const meta = {
  title: "Elements/Primitives/Card",
  component: Card,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="w-screen max-w-lg px-4"><Story /></div>],
} satisfies Meta<typeof Card>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Card>
      <CardHeader>
        <CardTitle>RecipeBot</CardTitle>
        <CardDescription>A shared app for planning weekly meals.</CardDescription>
        <CardAction><Button size="sm" variant="outline">Open</Button></CardAction>
      </CardHeader>
      <CardContent>Three collaborators · updated today</CardContent>
      <CardFooter><Button>Use app</Button></CardFooter>
    </Card>
  ),
}

export const Compact: Story = {
  render: () => (
    <Card size="sm">
      <CardHeader><CardTitle>Compact card</CardTitle><CardDescription>Reduced spacing for dense lists.</CardDescription></CardHeader>
      <CardContent>Short supporting content.</CardContent>
    </Card>
  ),
}
