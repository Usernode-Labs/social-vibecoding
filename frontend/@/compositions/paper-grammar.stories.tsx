import type { Meta, StoryObj } from "@storybook/react-vite"
import { Bell, BriefcaseBusiness, Check, Home, Search } from "lucide-react"
import { Link } from "react-router-dom"
import { expect, within } from "storybook/test"

import { PlatformIcon } from "@/components/platform-icon"
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
  { current: true, icon: Home, label: "Home", to: "/" },
  { current: false, icon: BriefcaseBusiness, label: "Work", to: "/work" },
  { current: false, icon: Search, label: "Search", to: "/explore" },
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
        className="mx-auto flex w-full max-w-5xl flex-col overflow-hidden rounded-4xl bg-card text-card-foreground shadow-md ring-1 ring-foreground/5 dark:ring-foreground/10"
        data-slot="paper-grammar-paper"
        data-surface="paper"
      >
        <header className="flex flex-col gap-5 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8 sm:py-6" data-surface="print">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase" data-type-role="tertiary">Personal treasury</p>
            <h1 className="text-2xl font-semibold tracking-tight">Quiet money</h1>
            <p className="max-w-xl text-base text-muted-foreground" data-type-role="prose">One Paper carries the decisions. Everything inside it is printed, recessed, or semantic ink.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <nav aria-label="Paper sections" className="flex items-center gap-1 text-sm">
              <Link aria-current="page" className="rounded-full bg-muted px-3 py-2 font-medium text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/30" to="/">Overview</Link>
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

            <div className="rounded-2xl bg-muted/70 p-4 ring-1 ring-inset ring-border/70" data-recess-role="input" data-slot="paper-recess" data-surface="recess">
              <Field>
                <FieldLabel htmlFor="paper-note">Monthly note</FieldLabel>
                <Input id="paper-note" placeholder="Add context for this month" />
                <FieldDescription>This named input well is the one justified Recess.</FieldDescription>
              </Field>
            </div>

            <div className="flex flex-col gap-2 border-t pt-4" data-surface="print">
              <p className="text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase" data-type-role="tertiary">Grammar</p>
              <p className="text-base">Canvas → Paper → Print → Recess → Overlay</p>
            </div>
          </aside>
        </div>
      </section>

      <nav
        aria-label="Mobile primary navigation"
        className="fixed inset-x-3 bottom-3 z-20 flex min-h-14 items-center justify-around rounded-full border bg-card px-2 text-card-foreground shadow-md sm:hidden"
        data-slot="platform-bottom-navigation"
        data-surface="overlay"
        data-surface-persistence="persistent"
      >
        {navigation.map((item) => (
          <Link
            aria-current={item.current ? "page" : undefined}
            className="flex min-h-11 min-w-20 items-center justify-center gap-2 rounded-full px-3 text-sm text-muted-foreground outline-none aria-[current=page]:bg-muted aria-[current=page]:font-medium aria-[current=page]:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
            key={item.label}
            to={item.to}
          >
            <PlatformIcon icon={item.icon} />
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>
    </main>
  )
}

async function assertPaperGrammar(canvasElement: HTMLElement, mobile: boolean) {
  const canvas = within(canvasElement)
  const canvasSurface = canvas.getByRole("main", { name: "Paper grammar specimen" })
  const paper = canvasElement.querySelector<HTMLElement>('[data-surface="paper"]')
  const recess = canvasElement.querySelector<HTMLElement>('[data-surface="recess"]')
  const overlay = canvasElement.querySelector<HTMLElement>('[data-slot="platform-bottom-navigation"]')
  const statusInk = canvasElement.querySelector<HTMLElement>('[data-slot="paper-status-ink"]')
  const rowTitle = canvasElement.querySelector<HTMLElement>('[data-slot="stream-row-title"]')
  const tertiary = canvasElement.querySelector<HTMLElement>('[data-type-role="tertiary"]')

  await expect(canvasElement.querySelectorAll('[data-surface="paper"]')).toHaveLength(1)
  await expect(paper).toBeTruthy()
  await expect(paper?.querySelector('[data-surface="paper"]')).toBeNull()
  await expect(paper?.parentElement).toBe(canvasSurface)
  await expect(recess).toHaveAttribute("data-recess-role", "input")
  await expect(overlay).toHaveAttribute("data-slot", "platform-bottom-navigation")
  await expect(overlay).toHaveAttribute("data-surface-persistence", "persistent")
  await expect(paper?.contains(overlay)).toBe(false)
  await expect(statusInk).not.toHaveAttribute("data-surface")
  await expect(canvasElement.querySelector('[data-slot="paper-metric-group"]')).toBeTruthy()
  await expect(canvas.getAllByRole("link")).toHaveLength(mobile ? 7 : 4)

  const canvasStyle = getComputedStyle(canvasSurface)
  const paperStyle = getComputedStyle(paper!)
  const recessStyle = getComputedStyle(recess!)
  await expect(canvasStyle.backgroundColor).not.toBe(paperStyle.backgroundColor)
  await expect(Number.parseFloat(paperStyle.borderTopLeftRadius)).toBeGreaterThan(Number.parseFloat(recessStyle.borderTopLeftRadius))
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
