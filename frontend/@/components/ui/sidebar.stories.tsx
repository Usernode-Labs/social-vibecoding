import type { Meta, StoryObj } from "@storybook/react-vite"
import { Home, Search, Settings } from "lucide-react"
import { expect, userEvent, within } from "storybook/test"

import { PlatformIcon } from "@/components/platform-icon"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarInput,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"

const meta = {
  title: "Elements/Primitives/Sidebar",
  component: Sidebar,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Sidebar>

export default meta
type Story = StoryObj<typeof meta>

function Example({ defaultOpen = true }: { defaultOpen?: boolean }) {
  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <Sidebar collapsible="icon">
        <SidebarHeader><SidebarInput aria-label="Search navigation" placeholder="Search" /></SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Platform</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem><SidebarMenuButton isActive tooltip="Home"><PlatformIcon icon={Home} /><span>Home</span></SidebarMenuButton></SidebarMenuItem>
                <SidebarMenuItem><SidebarMenuButton tooltip="Explore"><PlatformIcon icon={Search} /><span>Explore</span></SidebarMenuButton><SidebarMenuBadge>4</SidebarMenuBadge></SidebarMenuItem>
                <SidebarMenuItem><SidebarMenuButton tooltip="Settings"><PlatformIcon icon={Settings} /><span>Settings</span></SidebarMenuButton></SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <SidebarInset className="min-h-dvh p-4">
        <SidebarTrigger />
        <h1 className="mt-8 text-xl font-semibold">Sidebar content</h1>
      </SidebarInset>
    </SidebarProvider>
  )
}

export const Expanded: Story = { render: () => <Example /> }
export const Collapsed: Story = { render: () => <Example defaultOpen={false} /> }
export const ToggleInteraction: Story = {
  render: () => <Example />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Toggle Sidebar" }))
    await expect(canvasElement.querySelector("[data-slot=sidebar]")).toHaveAttribute("data-state", "collapsed")
  },
}
