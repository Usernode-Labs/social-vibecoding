import type { Meta, StoryObj } from "@storybook/react-vite"
import { BriefcaseBusiness, House, Search, SlidersHorizontal } from "lucide-react"
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react"
import { expect, waitFor } from "storybook/test"

import {
  PlatformBottomNavigation,
  type PlatformBottomNavigationItem,
} from "@/components/platform-bottom-navigation"
import { PlatformIcon } from "@/components/platform-icon"
import { PlatformNavigation, type PlatformNavItem } from "@/components/platform-navigation"
import { ShellAttentionProvider } from "@/components/platform-menu-trigger"
import { TopBar } from "@/components/top-bar"
import { Button } from "@/components/ui/button"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"

const bottomItems = [
  { id: "home", label: "Home", href: "/", icon: House, match: (path: string) => path === "/" },
  { id: "work", label: "Work", href: "/work", icon: BriefcaseBusiness, match: (path: string) => path.startsWith("/work") },
  { id: "search", label: "Search", href: "/explore", icon: Search, match: (path: string) => path.startsWith("/explore") },
] as const satisfies readonly [
  PlatformBottomNavigationItem,
  PlatformBottomNavigationItem,
  PlatformBottomNavigationItem,
]

const sidebarItems = bottomItems satisfies readonly PlatformNavItem[]

const safeArea = {
  "--safe-area-top": "20px",
  "--safe-area-right": "24px",
  "--safe-area-bottom": "20px",
  "--safe-area-bottom-active": "var(--safe-area-bottom)",
  "--safe-area-left": "24px",
} as CSSProperties

type Band = {
  key: string
  kind: "padding" | "gap"
  label: string
  style: CSSProperties
}

type Keyline = {
  coordinate: number
  key: string
  label: string
  style: CSSProperties
}

type TargetMeasurement = {
  height: number
  key: string
  label: string
  style: CSSProperties
  width: number
}

function relativeRect(node: Element, root: DOMRect) {
  const rect = node.getBoundingClientRect()
  return {
    height: rect.height,
    left: rect.left - root.left,
    top: rect.top - root.top,
    width: rect.width,
  }
}

function ShellGeometryOverlay({ mobile }: { mobile: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [bands, setBands] = useState<Band[]>([])
  const [keylines, setKeylines] = useState<Keyline[]>([])
  const [targets, setTargets] = useState<TargetMeasurement[]>([])

  useLayoutEffect(() => {
    const root = ref.current?.parentElement
    if (!root) return
    const measure = () => {
      const rootRect = root.getBoundingClientRect()
      const rootStyle = getComputedStyle(root)
      const top = Number.parseFloat(rootStyle.getPropertyValue("--safe-area-top"))
      const right = Number.parseFloat(rootStyle.getPropertyValue("--safe-area-right"))
      const bottom = Number.parseFloat(rootStyle.getPropertyValue("--safe-area-bottom-active"))
      const left = Number.parseFloat(rootStyle.getPropertyValue("--safe-area-left"))
      setBands([
        { key: "safe-top", kind: "padding", label: `safe top ${top}px`, style: { height: top, left: 0, right: 0, top: 0 } },
        { key: "safe-right", kind: "padding", label: `safe right ${right}px`, style: { bottom: 0, right: 0, top: 0, width: right } },
        { key: "safe-bottom", kind: "padding", label: `safe bottom ${bottom}px`, style: { bottom: 0, height: bottom, left: 0, right: 0 } },
        { key: "safe-left", kind: "padding", label: `safe left ${left}px`, style: { bottom: 0, left: 0, top: 0, width: left } },
      ])

      const topBar = root.querySelector<HTMLElement>('[data-slot="top-bar"]')
      const route = root.querySelector<HTMLElement>('[data-slot="route-viewport"]')
      const content = root.querySelector<HTMLElement>("[data-shell-route-content]")
      const paper = root.querySelector<HTMLElement>('[data-slot="sidebar-inset"]')
      const sidebar = root.querySelector<HTMLElement>('[data-slot="sidebar-inner"]')
      const bottomNavigation = root.querySelector<HTMLElement>('[data-slot="platform-bottom-navigation"]')
      if (!topBar || !route || !content || !paper) return
      const topBarRect = relativeRect(topBar, rootRect)
      const routeRect = relativeRect(route, rootRect)
      const contentRect = relativeRect(content, rootRect)
      const nextKeylines: Keyline[] = [
        { coordinate: topBarRect.top + topBarRect.height, key: "topbar-bottom", label: `top bar bottom ${Math.round(topBarRect.top + topBarRect.height)}px`, style: { height: 1, left: routeRect.left, top: topBarRect.top + topBarRect.height, width: routeRect.width } },
        { coordinate: contentRect.top, key: "content-start", label: `content start ${Math.round(contentRect.top)}px`, style: { height: 1, left: routeRect.left, top: contentRect.top, width: routeRect.width } },
        { coordinate: routeRect.left, key: "route-left", label: `route left ${Math.round(routeRect.left)}px`, style: { height: routeRect.height, left: routeRect.left, top: routeRect.top, width: 1 } },
        { coordinate: routeRect.left + routeRect.width, key: "route-right", label: `route right ${Math.round(routeRect.left + routeRect.width)}px`, style: { height: routeRect.height, left: routeRect.left + routeRect.width, top: routeRect.top, width: 1 } },
      ]
      if (sidebar && sidebar.getBoundingClientRect().width > 0) {
        const sidebarRect = relativeRect(sidebar, rootRect)
        const paperRect = relativeRect(paper, rootRect)
        nextKeylines.push(
          { coordinate: sidebarRect.left + sidebarRect.width, key: "sidebar-trailing", label: `sidebar trailing ${Math.round(sidebarRect.left + sidebarRect.width)}px`, style: { height: sidebarRect.height, left: sidebarRect.left + sidebarRect.width, top: sidebarRect.top, width: 1 } },
          { coordinate: paperRect.left, key: "paper-leading", label: `Paper leading ${Math.round(paperRect.left)}px`, style: { height: paperRect.height, left: paperRect.left, top: paperRect.top, width: 1 } },
        )
      }
      if (bottomNavigation && getComputedStyle(bottomNavigation).display !== "none") {
        const navigationRect = relativeRect(bottomNavigation, rootRect)
        nextKeylines.push({ coordinate: navigationRect.top, key: "bottom-navigation-top", label: `bottom navigation top ${Math.round(navigationRect.top)}px`, style: { height: 1, left: navigationRect.left, top: navigationRect.top, width: navigationRect.width } })
      }
      setKeylines(nextKeylines)

      const candidates = [
        ["route-action", root.querySelector<HTMLElement>("[data-shell-action]")],
        ...[...root.querySelectorAll<HTMLElement>('[data-slot="platform-bottom-navigation"] a')].map((node) => [`bottom-${node.textContent?.trim().toLowerCase()}`, node] as const),
      ] as const
      setTargets(candidates.flatMap(([key, node]) => {
        if (!node || getComputedStyle(node).display === "none") return []
        const rect = relativeRect(node, rootRect)
        if (!rect.width || !rect.height) return []
        return [{
          height: rect.height,
          key,
          label: `${Math.round(rect.width)} × ${Math.round(rect.height)}px`,
          style: { height: rect.height, left: rect.left, top: rect.top, width: rect.width },
          width: rect.width,
        }]
      }))
    }

    measure()
    void document.fonts.ready.then(measure)
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    for (const selector of ['[data-slot="top-bar"]', '[data-slot="route-viewport"]', "[data-shell-route-content]", '[data-slot="sidebar-inset"]', '[data-slot="sidebar-inner"]', '[data-slot="platform-bottom-navigation"]']) {
      const node = root.querySelector(selector)
      if (node) observer.observe(node)
    }
    for (const node of root.querySelectorAll('[data-shell-action], [data-slot="platform-bottom-navigation"] a')) observer.observe(node)
    return () => observer.disconnect()
  }, [mobile])

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-50 overflow-hidden" data-shell-geometry-overlay ref={ref}>
      {bands.map((band) => (
        <span className="absolute flex items-center justify-center bg-status-negative-foreground/10 font-mono text-xs text-status-negative-foreground" data-redline-band={band.kind} data-redline-key={band.key} key={band.key} style={band.style}>{band.label}</span>
      ))}
      {keylines.map((keyline) => (
        <span className="absolute bg-status-info-foreground text-status-info-foreground" data-keyline-coordinate={keyline.coordinate} data-shell-keyline={keyline.key} key={keyline.key} style={keyline.style}>
          <span className="absolute top-0 left-0 whitespace-nowrap bg-paper px-1 font-mono text-xs">{keyline.label}</span>
        </span>
      ))}
      {targets.map((target) => (
        <span className="absolute border border-dashed border-status-positive-foreground text-center font-mono text-xs text-status-positive-foreground" data-target-height={target.height} data-target-measurement-for={target.key} data-target-width={target.width} key={target.key} style={target.style}>{target.label}</span>
      ))}
    </div>
  )
}

function ShellRedlineFixture({ mobile }: { mobile: boolean }) {
  return (
    <TooltipProvider>
      <SidebarProvider className="relative h-svh min-h-0 overflow-hidden" data-shell-redline-fixture={mobile ? "mobile" : "desktop"} defaultOpen={!mobile} style={safeArea}>
        <ShellAttentionProvider count={0}>
          <PlatformNavigation brand={{ label: "dApps", href: "/react/" }} items={sidebarItems} pathname="/" />
          <SidebarInset className="min-h-0 overflow-hidden" data-bottom-navigation="true">
            <div className="relative flex min-h-0 flex-1 flex-col" data-slot="route-viewport" data-surface="print">
              <TopBar
                action={<Button aria-label="Open route settings" className="size-12" data-shell-action size="icon-sm" type="button" variant="outline"><PlatformIcon icon={SlidersHorizontal} /></Button>}
                title="Shell geometry"
              />
              <div className="min-h-0 flex-1 overflow-auto p-4" data-shell-route-content data-surface="print">
                <p className="text-base">The production shell primitives own this geometry. The overlay only reads it.</p>
              </div>
            </div>
          </SidebarInset>
          <PlatformBottomNavigation items={bottomItems} pathname="/" />
          <ShellGeometryOverlay mobile={mobile} />
        </ShellAttentionProvider>
      </SidebarProvider>
    </TooltipProvider>
  )
}

function approximate(actual: number, expected: number) {
  return Math.abs(actual - expected) <= 0.5
}

async function assertShellGeometry(canvasElement: HTMLElement, mobile: boolean) {
  await document.fonts.ready
  const root = canvasElement.querySelector<HTMLElement>("[data-shell-redline-fixture]")!
  await waitFor(() => expect(root.querySelectorAll("[data-shell-keyline]").length).toBe(mobile ? 5 : 6))
  const paper = root.querySelector<HTMLElement>('[data-slot="sidebar-inset"]')!
  const route = root.querySelector<HTMLElement>('[data-slot="route-viewport"]')!
  const topBar = root.querySelector<HTMLElement>('[data-slot="top-bar"]')!
  const content = root.querySelector<HTMLElement>("[data-shell-route-content]")!
  const bottomNavigation = root.querySelector<HTMLElement>('[data-slot="platform-bottom-navigation"]')!
  await expect(root.querySelectorAll('[data-surface="paper"]')).toHaveLength(1)
  await expect(topBar.getBoundingClientRect().height).toBeGreaterThan(0)
  await expect(route.getBoundingClientRect().height).toBeGreaterThan(0)
  await expect(getComputedStyle(topBar).paddingTop).toBe("20px")
  await expect(getComputedStyle(topBar).minHeight).toBe("76px")
  await expect(getComputedStyle(route).paddingBottom).toBe("20px")
  await expect(getComputedStyle(route).paddingLeft).toBe(mobile ? "8px" : "0px")
  await expect(getComputedStyle(route).paddingRight).toBe(mobile ? "8px" : "0px")

  const kinds = [...root.querySelectorAll<HTMLElement>("[data-redline-band]")].map((band) => band.dataset.redlineBand)
  await expect([...new Set(kinds)].every((kind) => kind === "padding" || kind === "gap")).toBe(true)
  await expect(root.querySelectorAll('[data-redline-band="margin"]')).toHaveLength(0)
  for (const band of root.querySelectorAll<HTMLElement>("[data-redline-band]")) {
    const dimension = band.dataset.redlineKey === "safe-left" || band.dataset.redlineKey === "safe-right" ? band.getBoundingClientRect().width : band.getBoundingClientRect().height
    await expect(band.textContent).toContain(`${Math.round(dimension)}px`)
  }

  const keyline = (key: string) => root.querySelector<HTMLElement>(`[data-shell-keyline="${key}"]`)!
  const rootRect = root.getBoundingClientRect()
  await expect(approximate(Number(keyline("topbar-bottom").dataset.keylineCoordinate), topBar.getBoundingClientRect().bottom - rootRect.top)).toBe(true)
  await expect(approximate(Number(keyline("content-start").dataset.keylineCoordinate), content.getBoundingClientRect().top - rootRect.top)).toBe(true)
  await expect(approximate(Number(keyline("route-left").dataset.keylineCoordinate), route.getBoundingClientRect().left - rootRect.left)).toBe(true)
  await expect(approximate(Number(keyline("route-right").dataset.keylineCoordinate), route.getBoundingClientRect().right - rootRect.left)).toBe(true)
  await expect(approximate(topBar.getBoundingClientRect().bottom, content.getBoundingClientRect().top)).toBe(true)

  if (mobile) {
    await expect(getComputedStyle(bottomNavigation).display).not.toBe("none")
    await expect(paper.contains(bottomNavigation)).toBe(false)
    await expect(paper.getBoundingClientRect().bottom).toBeLessThanOrEqual(bottomNavigation.getBoundingClientRect().top)
    await expect(getComputedStyle(route).overflowY).toBe("auto")
    await expect(getComputedStyle(route).overscrollBehavior).toBe("contain")
    await expect(approximate(Number(keyline("bottom-navigation-top").dataset.keylineCoordinate), bottomNavigation.getBoundingClientRect().top - rootRect.top)).toBe(true)
    const targets = [...root.querySelectorAll<HTMLElement>("[data-target-measurement-for]")]
    const sourceTargets = [
      root.querySelector<HTMLElement>("[data-shell-action]")!,
      ...root.querySelectorAll<HTMLElement>('[data-slot="platform-bottom-navigation"] a'),
    ]
    await expect(targets).toHaveLength(4)
    await expect(sourceTargets).toHaveLength(4)
    for (const [index, target] of targets.entries()) {
      const width = Number(target.dataset.targetWidth)
      const height = Number(target.dataset.targetHeight)
      const sourceRect = sourceTargets[index].getBoundingClientRect()
      await expect(target.textContent).toBe(`${Math.round(width)} × ${Math.round(height)}px`)
      await expect(approximate(target.getBoundingClientRect().left, sourceRect.left)).toBe(true)
      await expect(approximate(target.getBoundingClientRect().top, sourceRect.top)).toBe(true)
      await expect(approximate(target.getBoundingClientRect().right, sourceRect.right)).toBe(true)
      await expect(approximate(target.getBoundingClientRect().bottom, sourceRect.bottom)).toBe(true)
      await expect(width).toBeGreaterThanOrEqual(44)
      await expect(height).toBeGreaterThanOrEqual(44)
      await expect(height).toBeLessThanOrEqual(48)
    }
    for (const [index, target] of sourceTargets.entries()) {
      const left = target.getBoundingClientRect()
      for (const sibling of sourceTargets.slice(index + 1)) {
        const right = sibling.getBoundingClientRect()
        await expect(left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top).toBe(false)
      }
    }
  } else {
    await expect(getComputedStyle(bottomNavigation).display).toBe("none")
    const sidebar = root.querySelector<HTMLElement>('[data-slot="sidebar-inner"]')!
    await expect(sidebar.getBoundingClientRect().width).toBeGreaterThan(0)
    await expect(getComputedStyle(sidebar).paddingTop).toBe("20px")
    await expect(getComputedStyle(sidebar).paddingBottom).toBe("20px")
    await expect(approximate(Number(keyline("sidebar-trailing").dataset.keylineCoordinate), sidebar.getBoundingClientRect().right - rootRect.left)).toBe(true)
    await expect(approximate(Number(keyline("paper-leading").dataset.keylineCoordinate), paper.getBoundingClientRect().left - rootRect.left)).toBe(true)
  }
}

const meta = {
  title: "Docs/Design system/Redlines/Shell anatomy",
  component: ShellRedlineFixture,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ShellRedlineFixture>

export default meta
type Story = StoryObj<typeof meta>

export const DesktopShell: Story = {
  args: { mobile: false },
  parameters: { viewport: { defaultViewport: "desktop" } },
  play: async ({ canvasElement }) => assertShellGeometry(canvasElement, false),
}

export const MobileShell: Story = {
  args: { mobile: true },
  parameters: { viewport: { defaultViewport: "mobile1" } },
  play: async ({ canvasElement }) => assertShellGeometry(canvasElement, true),
}
