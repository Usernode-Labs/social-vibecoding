import type { Meta, StoryObj } from "@storybook/react-vite"
import { Hammer } from "lucide-react"
import { expect, within } from "storybook/test"

import { PlatformIcon } from "@/components/platform-icon"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"

const meta = {
  title: "Elements/Primitives/Card",
  component: Card,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="w-screen max-w-lg rounded-4xl bg-card p-4 text-card-foreground shadow-sm" data-surface="paper"><Story /></div>],
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
  play: async ({ canvasElement }) => {
    const card = canvasElement.querySelector<HTMLElement>('[data-slot="card"]')
    const transparentReference = document.createElement("div")
    canvasElement.append(transparentReference)
    await expect(card).toHaveAttribute("data-surface", "print")
    await expect(getComputedStyle(card!).backgroundColor).toBe(getComputedStyle(transparentReference).backgroundColor)
    await expect(getComputedStyle(card!).boxShadow).toBe("none")
    transparentReference.remove()
  },
}

export const IconTitle: Story = {
  render: () => (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><PlatformIcon icon={Hammer} />Build timeline</CardTitle>
        <CardDescription>Recent development activity.</CardDescription>
      </CardHeader>
    </Card>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const title = canvas.getByText("Build timeline").closest('[data-slot="card-title"]')
    const icon = title?.querySelector(':scope > [data-slot="platform-icon"]')
    await expect(icon).not.toBeNull()
    await expect(getComputedStyle(icon!).width).toBe("16px")
    await expect(getComputedStyle(icon!).height).toBe("16px")
  },
}

export const Compact: Story = {
  render: () => (
    <Card size="sm">
      <CardHeader><CardTitle>Compact card</CardTitle><CardDescription>Reduced spacing for dense lists.</CardDescription></CardHeader>
      <CardContent>Short supporting content.</CardContent>
    </Card>
  ),
}
