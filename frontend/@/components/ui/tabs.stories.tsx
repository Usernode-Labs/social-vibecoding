import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { renderedAlpha } from "@/lib/rendered-color"

const meta = {
  title: "Elements/Primitives/Tabs",
  component: Tabs,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="w-screen max-w-xl px-4"><Story /></div>],
} satisfies Meta<typeof Tabs>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Tabs defaultValue="overview">
      <TabsList><TabsTrigger value="overview">Overview</TabsTrigger><TabsTrigger value="activity">Activity</TabsTrigger></TabsList>
      <TabsContent className="pt-3" value="overview">Overview content</TabsContent>
      <TabsContent className="pt-3" value="activity">Recent activity</TabsContent>
    </Tabs>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const list = canvas.getByRole("tablist")
    const active = canvas.getByRole("tab", { name: "Overview" })
    await expect(list).toHaveAttribute("data-surface", "container")
    await expect(active).not.toHaveAttribute("data-surface")
    await expect(renderedAlpha(getComputedStyle(list).backgroundColor)).toBeGreaterThan(0)
    await expect(getComputedStyle(active).backgroundColor).toBe(getComputedStyle(list).backgroundColor)
  },
}

export const Line: Story = {
  render: () => (
    <Tabs defaultValue="overview">
      <TabsList variant="line"><TabsTrigger value="overview">Overview</TabsTrigger><TabsTrigger value="activity">Activity</TabsTrigger></TabsList>
      <TabsContent className="pt-3" value="overview">Overview content</TabsContent>
    </Tabs>
  ),
}

export const Vertical: Story = {
  render: () => (
    <Tabs defaultValue="profile" orientation="vertical">
      <TabsList><TabsTrigger value="profile">Profile</TabsTrigger><TabsTrigger value="security">Security</TabsTrigger></TabsList>
      <TabsContent value="profile">Profile settings</TabsContent>
      <TabsContent value="security">Security settings</TabsContent>
    </Tabs>
  ),
}
