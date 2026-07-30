import type { Meta, StoryObj } from "@storybook/react-vite"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

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
