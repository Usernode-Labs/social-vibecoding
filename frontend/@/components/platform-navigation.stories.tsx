import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  Bell,
  BriefcaseBusiness,
  Compass,
  House,
  MessageCircle,
  Server,
  Settings,
  Shield,
  Trophy,
  UserRound,
} from "lucide-react"
import { expect, userEvent, within } from "storybook/test"

import {
  PlatformNavigation,
  type PlatformNavigationProps,
  type PlatformNavItem,
} from "@/components/platform-navigation"
import { PlatformMenuTrigger } from "@/components/platform-menu-trigger"
import { StatusDot } from "@/components/status-dot"
import { SidebarMenuBadge } from "@/components/ui/sidebar"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

const route = (href: string) => (pathname: string) =>
  pathname === href || pathname.startsWith(`${href}/`)

const items = [
  { id: "home", label: "Home", href: "/react/", icon: House, match: (pathname) => pathname === "/" },
  { id: "explore", label: "Explore", href: "/react/explore", icon: Compass, match: route("/explore") },
  { id: "work", label: "Work", href: "/react/work", icon: BriefcaseBusiness, match: route("/work") },
  { id: "community", label: "Challenges", href: "/react/community/challenges", icon: Trophy, match: route("/community") },
  {
    id: "activity",
    label: "Activity",
    href: "/react/notifications",
    icon: Bell,
    match: route("/notifications"),
    trailing: <SidebarMenuBadge aria-label="3 items need attention">3</SidebarMenuBadge>,
  },
  {
    id: "node",
    label: "Node",
    href: "/react/node-status",
    icon: Server,
    match: route("/node-status"),
    group: "node",
    trailing: <StatusDot label="Synced" role="positive" showLabel={false} size="sm" subject="Node" />,
  },
  { id: "feedback", label: "Send feedback", href: "/react/feedback", icon: MessageCircle, match: route("/feedback"), group: "utility" },
  { id: "admin", label: "Admin", href: "/react/admin", icon: Shield, match: route("/admin"), group: "utility", visible: false },
  { id: "account", label: "Account", href: "/react/account/profile", icon: UserRound, match: route("/account"), group: "utility" },
  { id: "settings", label: "Settings", href: "/react/settings", icon: Settings, match: (pathname) => pathname === "/settings", group: "utility" },
] satisfies readonly PlatformNavItem[]

const baseArgs = {
  brand: { label: "dApps", href: "/react/" },
  items,
  pathname: "/",
} satisfies PlatformNavigationProps

function NavigationFixture({
  defaultOpen = true,
  ...props
}: PlatformNavigationProps & { defaultOpen?: boolean }) {
  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <PlatformNavigation {...props} />
      <SidebarInset className="min-h-screen">
        <header className="flex h-14 items-center border-b px-3">
          <PlatformMenuTrigger />
        </header>
        <div className="p-6 text-sm text-muted-foreground">Route content</div>
      </SidebarInset>
    </SidebarProvider>
  )
}

const meta = {
  title: "Blocks/Shell/Platform navigation",
  component: PlatformNavigation,
  parameters: { layout: "fullscreen" },
  args: baseArgs,
  render: (args) => <NavigationFixture {...args} />,
} satisfies Meta<typeof PlatformNavigation>

export default meta
type Story = StoryObj<typeof meta>

export const DesktopExpanded: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole("navigation", { name: "Platform navigation" })).toBeTruthy()
    await expect(canvas.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page")
    await expect(canvas.getAllByRole("link").filter((link) => link.hasAttribute("aria-current"))).toHaveLength(1)
  },
}

export const NarrowClosed: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  render: (args) => <NavigationFixture {...args} defaultOpen={false} />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("navigation", { name: "Platform navigation" })).toBeNull()
  },
}

export const NarrowOpen: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  render: (args) => <NavigationFixture {...args} defaultOpen={false} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Toggle navigation" }))
    await expect(within(canvasElement.ownerDocument.body).getByRole("navigation", { name: "Platform navigation" })).toBeTruthy()
  },
}

export const DesktopExpandedDark: Story = {
  globals: { theme: "dark" },
  play: DesktopExpanded.play,
}

export const ActiveChallenges: Story = {
  args: { pathname: "/community/challenges/summer-build" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("link", { name: "Challenges" })).toHaveAttribute("aria-current", "page")
  },
}

export const AccountFooter: Story = {
  args: { pathname: "/account/profile" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("link", { name: "Account" })).toHaveAttribute("aria-current", "page")
  },
}

export const AdminAbsent: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("link", { name: "Admin" })).toBeNull()
  },
}

export const AttentionCount: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByLabelText("3 items need attention")).toHaveTextContent("3")
  },
}

export const NodeStatus: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("img", { name: "Node, synced" })).toBeTruthy()
  },
}
