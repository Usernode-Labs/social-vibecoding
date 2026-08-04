import type { Meta, StoryObj } from "@storybook/react-vite"
import { Bell, BriefcaseBusiness, Check, Home, Search } from "lucide-react"
import { Link } from "react-router-dom"
import { expect, within } from "storybook/test"

import { PlatformIcon } from "@/components/platform-icon"
import {
  PlatformBottomNavigation,
  type PlatformBottomNavigationItem,
} from "@/components/platform-bottom-navigation"
import { StatusDot } from "@/components/status-dot"
import { StreamRow } from "@/components/stream-row"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"

const paperViewports = {
  paperMobile: {
    name: "Paper mobile · 390 × 844",
    styles: { width: "390px", height: "844px" },
  },
  paperDesktop: {
    name: "Paper desktop · 1440 × 900",
    styles: { width: "1440px", height: "900px" },
  },
}

const metrics = [
  { label: "Available", value: "$12,480" },
  { label: "In progress", value: "$3,240" },
  { label: "This month", value: "+8.4%" },
]

const navigation = [
  { id: "home", icon: Home, label: "Home", href: "/", match: (pathname) => pathname === "/" },
  { id: "work", icon: BriefcaseBusiness, label: "Work", href: "/work", match: (pathname) => pathname === "/work" },
  { id: "search", icon: Search, label: "Search", href: "/explore", match: (pathname) => pathname === "/explore" },
] as const satisfies readonly [
  PlatformBottomNavigationItem,
  PlatformBottomNavigationItem,
  PlatformBottomNavigationItem,
]

function PaperGrammar() {
  return (
    <main
      aria-label="Paper grammar specimen"
      className="relative min-h-screen overflow-hidden bg-background px-3 py-6 pb-24 text-foreground sm:px-8 sm:py-10"
      data-slot="paper-grammar-canvas"
      data-surface="canvas"
    >
      <section
        className="mx-auto flex w-full max-w-5xl flex-col overflow-hidden rounded-4xl bg-paper text-foreground shadow-md ring-1 ring-foreground/5 dark:ring-foreground/10"
        data-slot="paper-grammar-paper"
        data-surface="paper"
      >
        <header className="flex flex-col gap-5 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8 sm:py-6" data-surface="print">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase" data-type-role="tertiary">Personal treasury</p>
            <h1 className="text-2xl font-semibold tracking-tight">Quiet UI</h1>
            <p className="max-w-xl text-base text-muted-foreground" data-type-role="prose">One Paper carries the decisions. Containers group printed content by compositing with their immediate context.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <nav aria-label="Paper sections" className="flex items-center gap-1 text-sm">
              <Link aria-current="page" className="rounded-full bg-container px-3 py-2 font-medium text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/30" to="/">Overview</Link>
              <Link className="rounded-full px-3 py-2 text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30" to="/work">Activity</Link>
            </nav>
            <Button className="pointer-coarse:min-h-12" type="button">Add funds</Button>
          </div>
        </header>

        <Separator />

        <div className="grid gap-8 px-5 py-6 sm:px-8 sm:py-8 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]" data-surface="print">
          <div className="flex min-w-0 flex-col gap-8">
            <section aria-labelledby="paper-metrics-title" className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase" data-type-role="tertiary">Snapshot</p>
                <h2 className="text-lg font-semibold" id="paper-metrics-title">Money at a glance</h2>
              </div>
              <dl className="grid grid-cols-3 divide-x divide-border border-y" data-slot="paper-metric-group">
                {metrics.map((metric) => (
                  <div className="flex min-w-0 flex-col gap-1 px-3 py-4 first:pl-0 last:pr-0 sm:px-5" key={metric.label}>
                    <dt className="truncate text-xs text-muted-foreground" data-type-role="tertiary">{metric.label}</dt>
                    <dd className="truncate text-base font-semibold tabular-nums sm:text-xl">{metric.value}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section aria-labelledby="paper-activity-title" className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold" id="paper-activity-title">Recent activity</h2>
                <span className="text-sm text-muted-foreground">Two updates</span>
              </div>
              <div className="overflow-hidden border-y" data-slot="paper-stream-group">
                <StreamRow
                  accessibleName="Open transfer to Studio fund"
                  anchor={<StatusDot label="Complete" role="positive" showLabel={false} size="sm" subject="Transfer" />}
                  metadata="Today · Treasury"
                  state="read"
                  title="Transfer to Studio fund"
                  to="/work"
                  trailing="$680"
                />
                <StreamRow
                  accessibleName="Open budget review"
                  anchor={<PlatformIcon icon={Bell} />}
                  metadata="Yesterday · Monthly review"
                  secondaryAction={<Button aria-label="Mark budget review complete" className="pointer-coarse:min-h-12" size="icon-sm" type="button" variant="ghost"><PlatformIcon icon={Check} /></Button>}
                  state="default"
                  title="Budget review is ready"
                  to="/work"
                />
              </div>
            </section>
          </div>

          <aside aria-label="Paper grammar supporting roles" className="flex min-w-0 flex-col gap-6">
            <div className="status-surface flex items-start gap-3 rounded-2xl border p-4" data-slot="paper-status-ink" data-status-tone="positive">
              <StatusDot label="Healthy" role="positive" showLabel={false} subject="Cash flow" />
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-sm font-medium">Cash flow is healthy</p>
                <p className="text-sm opacity-80">Status colour is ink on the Paper, never another surface.</p>
              </div>
            </div>

            <div data-slot="paper-input-role">
              <Field>
                <FieldLabel htmlFor="paper-note">Monthly note</FieldLabel>
                <Input id="paper-note" placeholder="Add context for this month" />
                <FieldDescription>The input uses the same Container material as every other printed grouping.</FieldDescription>
              </Field>
            </div>

            <div className="flex flex-col gap-3 rounded-3xl bg-container p-4" data-container-depth="1" data-surface="container">
              <p className="text-sm font-medium text-fg-primary" data-foreground-role="primary">Container</p>
              <div className="flex flex-col gap-3 rounded-2xl bg-container p-3" data-container-depth="2" data-surface="container">
                <p className="text-sm text-fg-secondary" data-foreground-role="secondary">Nested Container</p>
                <div className="rounded-xl bg-container p-3" data-container-depth="3" data-surface="container">
                  <p className="text-xs text-fg-tertiary" data-foreground-role="tertiary" data-type-role="tertiary">Third layer, same material</p>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-2 border-t pt-4" data-surface="print">
              <p className="text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase" data-type-role="tertiary">Grammar</p>
              <p className="text-base">Canvas → Paper → Print or Container → Overlay</p>
            </div>
          </aside>
        </div>
      </section>

      <PlatformBottomNavigation items={navigation} pathname="/" />
    </main>
  )
}

type RenderedColor = { red: number; green: number; blue: number; alpha: number }

function renderedColor(color: string): RenderedColor {
  const context = document.createElement("canvas").getContext("2d")
  if (!context) throw new Error("Paper grammar needs a 2D canvas context for rendered colour checks")
  context.canvas.width = 1
  context.canvas.height = 1
  context.clearRect(0, 0, 1, 1)
  context.fillStyle = color
  context.fillRect(0, 0, 1, 1)
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data
  return { red, green, blue, alpha: alpha / 255 }
}

function composite(source: RenderedColor, backdrop: RenderedColor): RenderedColor {
  return {
    red: source.red * source.alpha + backdrop.red * (1 - source.alpha),
    green: source.green * source.alpha + backdrop.green * (1 - source.alpha),
    blue: source.blue * source.alpha + backdrop.blue * (1 - source.alpha),
    alpha: 1,
  }
}

function renderedLuminance(color: RenderedColor) {
  const linear = [color.red, color.green, color.blue].map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

function renderedContrast(foreground: RenderedColor, background: RenderedColor) {
  const [high, low] = [renderedLuminance(composite(foreground, background)), renderedLuminance(background)].sort((left, right) => right - left)
  return (high + 0.05) / (low + 0.05)
}

async function assertPaperGrammar(canvasElement: HTMLElement, mobile: boolean) {
  const canvas = within(canvasElement)
  const canvasSurface = canvas.getByRole("main", { name: "Paper grammar specimen" })
  const paper = canvasElement.querySelector<HTMLElement>('[data-surface="paper"]')
  const input = canvasElement.querySelector<HTMLElement>('[data-slot="input"]')
  const containerStack = Array.from(canvasElement.querySelectorAll<HTMLElement>("[data-container-depth]"))
  const overlay = canvasElement.querySelector<HTMLElement>('[data-slot="platform-bottom-navigation"]')
  const statusInk = canvasElement.querySelector<HTMLElement>('[data-slot="paper-status-ink"]')
  const rowTitle = canvasElement.querySelector<HTMLElement>('[data-slot="stream-row-title"]')
  const tertiary = canvasElement.querySelector<HTMLElement>('[data-type-role="tertiary"]')

  await expect(canvasElement.querySelectorAll('[data-surface="paper"]')).toHaveLength(1)
  await expect(paper).toBeTruthy()
  await expect(paper?.querySelector('[data-surface="paper"]')).toBeNull()
  await expect(paper?.parentElement).toBe(canvasSurface)
  await expect(input).toHaveAttribute("data-surface", "container")
  await expect(containerStack).toHaveLength(3)
  await expect(overlay).toHaveAttribute("data-slot", "platform-bottom-navigation")
  await expect(overlay).toHaveAttribute("data-surface-persistence", "persistent")
  await expect(paper?.contains(overlay)).toBe(false)
  await expect(statusInk).not.toHaveAttribute("data-surface")
  await expect(canvasElement.querySelector('[data-slot="paper-metric-group"]')).toBeTruthy()
  await expect(canvas.getAllByRole("link")).toHaveLength(mobile ? 7 : 4)

  const canvasStyle = getComputedStyle(canvasSurface)
  const paperStyle = getComputedStyle(paper!)
  const inputStyle = getComputedStyle(input!)
  const canvasColor = renderedColor(canvasStyle.backgroundColor)
  const paperColor = renderedColor(paperStyle.backgroundColor)
  await expect(canvasStyle.backgroundColor).not.toBe(paperStyle.backgroundColor)
  await expect(renderedLuminance(paperColor)).toBeGreaterThan(renderedLuminance(canvasColor))
  await expect(inputStyle.backgroundColor).toBe(getComputedStyle(containerStack[0]).backgroundColor)
  await expect(inputStyle.borderTopStyle).toBe("solid")
  await expect(inputStyle.borderTopWidth).not.toBe("0px")
  await expect(inputStyle.borderTopColor).not.toBe("transparent")
  await expect(Number.parseFloat(paperStyle.borderTopLeftRadius)).toBeGreaterThan(Number.parseFloat(inputStyle.borderTopLeftRadius))

  const rawContainerColors = containerStack.map((element) => renderedColor(getComputedStyle(element).backgroundColor))
  await expect(rawContainerColors.map((color) => color.alpha)).toEqual([rawContainerColors[0].alpha, rawContainerColors[0].alpha, rawContainerColors[0].alpha])
  await expect(rawContainerColors[0].alpha).toBeGreaterThan(0)
  await expect(rawContainerColors[0].alpha).toBeLessThan(1)
  const compositedStack = rawContainerColors.reduce<RenderedColor[]>((layers, color) => [...layers, composite(color, layers.at(-1)!)], [paperColor])
  const stackLuminances = compositedStack.map(renderedLuminance)
  const dark = document.documentElement.classList.contains("dark")
  for (let depth = 1; depth < stackLuminances.length; depth += 1) {
    if (dark) await expect(stackLuminances[depth]).toBeGreaterThan(stackLuminances[depth - 1])
    else await expect(stackLuminances[depth]).toBeLessThan(stackLuminances[depth - 1])
  }
  for (const [depth, role] of ["primary", "secondary", "tertiary"].entries()) {
    const foreground = canvasElement.querySelector<HTMLElement>(`[data-foreground-role="${role}"]`)
    await expect(renderedContrast(renderedColor(getComputedStyle(foreground!).color), compositedStack[depth + 1])).toBeGreaterThanOrEqual(4.5)
  }
  await expect(getComputedStyle(rowTitle!).fontSize).toBe("16px")
  await expect(getComputedStyle(tertiary!).fontSize).toBe("12px")
  if (mobile) {
    await expect(overlay).toBeVisible()
    await expect(Number.parseFloat(canvasStyle.paddingBottom)).toBeGreaterThanOrEqual(overlay!.getBoundingClientRect().height + 12)
  } else {
    await expect(overlay).not.toBeVisible()
  }
}

const meta = {
  title: "Compositions/Paper grammar",
  component: PaperGrammar,
  parameters: {
    layout: "fullscreen",
    viewport: { options: paperViewports },
  },
} satisfies Meta<typeof PaperGrammar>

export default meta
type Story = StoryObj<typeof meta>

export const MobileLight: Story = {
  parameters: { viewport: { defaultViewport: "paperMobile", options: paperViewports } },
  play: ({ canvasElement }) => assertPaperGrammar(canvasElement, true),
}

export const MobileDark: Story = {
  globals: { theme: "dark" },
  parameters: { viewport: { defaultViewport: "paperMobile", options: paperViewports } },
  play: ({ canvasElement }) => assertPaperGrammar(canvasElement, true),
}

export const DesktopLight: Story = {
  parameters: { viewport: { defaultViewport: "paperDesktop", options: paperViewports } },
  play: ({ canvasElement }) => assertPaperGrammar(canvasElement, false),
}

export const DesktopDark: Story = {
  globals: { theme: "dark" },
  parameters: { viewport: { defaultViewport: "paperDesktop", options: paperViewports } },
  play: ({ canvasElement }) => assertPaperGrammar(canvasElement, false),
}
