import type { Meta, StoryObj } from "@storybook/react-vite"
import { BriefcaseBusiness, House, Search } from "lucide-react"
import { expect, within } from "storybook/test"

import {
  PlatformBottomNavigation,
  type PlatformBottomNavigationItem,
  type PlatformBottomNavigationProps,
} from "@/components/platform-bottom-navigation"

const route = (href: string) => (pathname: string) =>
  pathname === href || pathname.startsWith(`${href}/`)

const items = [
  { id: "home", label: "Home", href: "/react/", icon: House, match: (pathname) => pathname === "/" },
  { id: "work", label: "Work", href: "/react/work", icon: BriefcaseBusiness, match: route("/work") },
  { id: "search", label: "Search", href: "/react/explore", icon: Search, match: route("/explore") },
] as const satisfies readonly [
  PlatformBottomNavigationItem,
  PlatformBottomNavigationItem,
  PlatformBottomNavigationItem,
]

const baseArgs = {
  items,
  pathname: "/",
} satisfies PlatformBottomNavigationProps

function BottomNavigationFixture(props: PlatformBottomNavigationProps) {
  return (
    <main className="flex h-dvh flex-col bg-background p-3 pb-20" data-surface="canvas">
      <section className="min-h-0 flex-1 rounded-3xl bg-paper p-6" data-surface="paper">
        <h1 className="text-lg font-semibold">Mobile navigation specimen</h1>
      </section>
      <PlatformBottomNavigation {...props} />
    </main>
  )
}

async function assertBottomNavigation(canvasElement: HTMLElement, current: "Home" | "Work" | "Search") {
  const canvas = within(canvasElement.ownerDocument.body)
  const navigation = canvas.getByRole("navigation", { name: "Mobile primary navigation" })
  await expect(navigation).toHaveAttribute("data-surface", "overlay")
  await expect(navigation).toHaveAttribute("data-surface-persistence", "persistent")
  await expect(navigation.querySelectorAll("a")).toHaveLength(3)
  await expect(canvas.getByRole("link", { name: current })).toHaveAttribute("aria-current", "page")
  await expect(navigation.querySelectorAll('[aria-current="page"]')).toHaveLength(1)
  await expect(canvasElement.querySelector('[data-surface="paper"]')?.contains(navigation)).toBe(false)
}

const meta = {
  title: "Blocks/Shell/Platform bottom navigation",
  component: PlatformBottomNavigation,
  parameters: {
    layout: "fullscreen",
    viewport: { defaultViewport: "mobile1" },
  },
  args: baseArgs,
  render: (args) => <BottomNavigationFixture {...args} />,
} satisfies Meta<typeof PlatformBottomNavigation>

export default meta
type Story = StoryObj<typeof meta>

export const HomeSelected: Story = {
  play: async ({ canvasElement }) => assertBottomNavigation(canvasElement, "Home"),
}

export const WorkSelected: Story = {
  args: { pathname: "/work/current" },
  play: async ({ canvasElement }) => assertBottomNavigation(canvasElement, "Work"),
}

export const SearchSelected: Story = {
  args: { pathname: "/explore" },
  play: async ({ canvasElement }) => assertBottomNavigation(canvasElement, "Search"),
}

export const Dark: Story = {
  args: { pathname: "/explore" },
  globals: { theme: "dark" },
  play: async ({ canvasElement }) => assertBottomNavigation(canvasElement, "Search"),
}
