import { useLayoutEffect, useRef, useState, type ReactNode } from "react"

import { Metric } from "@/components/metric"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  catalogByTier,
  catalogCount,
  catalogExportCount,
  citationsFor,
  decisionLedger,
  inkTokens,
  lawExcerpts,
  loopFacts,
  radius,
  sourcePins,
  spacingRoles,
  surfaceRoleTable,
  surfaceTokens,
  typeRoles,
  type Citation,
} from "@/docs/design-doc-data"

export type DesignDocPage = "case" | "loop" | "surfaces" | "ink-levels" | "type-ramp" | "spacing-rhythm" | "radius-grouping" | "ledger" | "index"

const sourceNames = {
  laws: "design-system/interface-laws.md",
  tokens: "design-system/tokens.json",
  catalog: "design-system/catalog.json",
  citations: "design-system/interface-law-citations.json",
  baseline: "design-system/interface-law-baseline.json",
  ledger: "design-system/decision-ledger.json",
}

/* ---------------------------------------------------------------- measured */
/** Read a computed style off a live node after layout; the rendered label is
 *  the measurement, so shown value === actual value by construction. */
function useComputed<T extends HTMLElement>(extract: (style: CSSStyleDeclaration, node: T) => string) {
  const ref = useRef<T>(null)
  const [value, setValue] = useState("")
  const themeRevision = useThemeRevision()
  useLayoutEffect(() => {
    if (ref.current) setValue(extract(getComputedStyle(ref.current), ref.current))
  }, [extract, themeRevision])
  return [ref, value] as const
}

function useThemeRevision() {
  const [revision, setRevision] = useState("")
  useLayoutEffect(() => {
    const root = document.documentElement
    const update = () => setRevision(`${root.dataset.theme || ""}|${root.className}|${root.style.colorScheme}`)
    update()
    const observer = new MutationObserver(update)
    observer.observe(root, { attributes: true, attributeFilter: ["class", "data-theme", "style"] })
    return () => observer.disconnect()
  }, [])
  return revision
}

function MeasuredLabel({ children }: { children: ReactNode }) {
  return <code className="text-xs text-muted-foreground tabular-nums" data-measured-label>{children}</code>
}

/* ------------------------------------------------------- page scaffolding */
function DocShell({ children, eyebrow, headline, lawLine, sources }: {
  children: ReactNode; eyebrow: string; headline: string; lawLine?: string; sources: string[]
}) {
  return (
    <main className="min-h-screen bg-background p-4 text-foreground sm:p-8" data-doc-page data-surface="canvas">
      <article className="mx-auto flex max-w-6xl flex-col gap-10 rounded-4xl bg-paper px-5 py-8 sm:px-10 sm:py-12" data-surface="paper">
        <header className="flex flex-col gap-4" data-surface="print">
          <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">{eyebrow}</p>
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">{headline}</h1>
          {lawLine ? <p className="max-w-3xl border-l-2 border-border pl-4 text-base text-muted-foreground" data-law-block>{lawLine}</p> : null}
        </header>
        {children}
        <footer className="flex flex-wrap gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
          <span className="font-medium">Generated from</span>
          {sources.map((source) => <code data-source-ref key={source}>{source}</code>)}
        </footer>
      </article>
    </main>
  )
}

function Points({ items }: { items: Array<{ tone?: "yes" | "no"; text: ReactNode }> }) {
  if (items.length > 3) throw new Error("Docs discipline: at most 3 bullets per page")
  return (
    <ul className="flex max-w-3xl flex-col gap-2.5" data-doc-points>
      {items.map((item, index) => (
        <li className="relative pl-6 text-base text-muted-foreground" key={index}>
          <span aria-hidden className={`absolute top-2 left-0.5 size-1.5 rounded-full ${item.tone === "yes" ? "bg-status-positive-foreground" : item.tone === "no" ? "bg-status-negative-foreground" : "bg-border"}`} data-doc-marker />
          {item.text}
        </li>
      ))}
    </ul>
  )
}

/* --------------------------------------------------- enforcement (compact) */
function EnforcementStrip({ page }: { page: string }) {
  const chips: Record<Citation["kind"], string> = {
    "scanner-rule": "text-status-positive-foreground",
    "rendered-test": "text-status-info-foreground",
    "review-only": "text-status-warning-foreground",
  }
  return (
    <section aria-label="Enforcement" className="flex flex-col gap-2" data-enforcement-strip>
      <h2 className="text-sm font-medium tracking-[0.14em] text-muted-foreground uppercase">Enforced by</h2>
      <ul className="flex flex-col gap-1.5">
        {citationsFor(page).map((citation) => (
          <li key={citation.id}>
            <details className="group rounded-2xl bg-container" data-citation-id={citation.id} data-citation-kind={citation.kind} data-surface="container">
              <summary className="flex min-h-12 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
                <span className={`font-mono text-xs font-semibold uppercase ${chips[citation.kind]}`}>{citation.kind.replace("-", " ")}</span>
                <code className="text-xs text-muted-foreground">{citation.kind === "scanner-rule" ? citation.rule : citation.kind === "rendered-test" ? citation.story?.export : "human review"}</code>
                <span className="ml-auto text-xs text-muted-foreground group-open:hidden">details</span>
              </summary>
              <div className="grid gap-2 px-4 pb-3 text-sm sm:grid-cols-2">
                <p className="text-xs font-medium text-muted-foreground sm:col-span-2">
                  {citation.kind === "scanner-rule" ? `Per edit: advisory · gate and continuous integration: exact-keyed ratchet; new or multiplied findings fail, ${loopFacts.acceptedWarningEntries} entries / ${loopFacts.acceptedWarningOccurrences} occurrences are currently accepted, and resolved findings must be removed` : citation.kind === "rendered-test" ? "Gate and continuous integration: rendered assertion" : "Human review: judgment-only"}
                </p>
                <p><span className="font-medium text-foreground">Catches</span> <span className="text-muted-foreground">{citation.catches}</span></p>
                <p><span className="font-medium text-foreground">Misses</span> <span className="text-muted-foreground">{citation.misses}</span></p>
                <code className="text-xs text-muted-foreground sm:col-span-2">
                  {citation.kind === "scanner-rule" ? `npm run ${citation.check} · ${citation.test?.path}` : citation.kind === "rendered-test" ? `${citation.story?.path} · npm run ${citation.check}` : `${citation.review?.path} — ${citation.review?.instruction}`}
                </code>
              </div>
            </details>
          </li>
        ))}
      </ul>
    </section>
  )
}

/* ------------------------------------------------------------- specimens */
function ShellSurfaceMeasurement({ label, target, lightPath, darkPath }: { label: "Canvas" | "Paper"; target: "canvas" | "paper"; lightPath: string; darkPath: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [measured, setMeasured] = useState("")
  const themeRevision = useThemeRevision()
  const tokenPath = document.documentElement.dataset.theme === "dark" ? darkPath : lightPath
  useLayoutEffect(() => {
    const page = ref.current?.closest<HTMLElement>("[data-doc-page]")
    const surface = target === "canvas" ? page : page?.querySelector<HTMLElement>('[data-surface="paper"]')
    if (surface) setMeasured(getComputedStyle(surface).backgroundColor)
  }, [target, themeRevision])
  return (
    <div className="flex items-center gap-3" data-measured-surface={label} data-measured-target={target} ref={ref}>
      <span aria-hidden className="size-14 shrink-0 rounded-2xl" data-token-swatch style={{ backgroundColor: measured }} />
      <div className="flex min-w-0 flex-col gap-1"><span className="text-sm font-semibold">{label}</span><MeasuredLabel>{measured || "measuring…"} · {tokenPath}</MeasuredLabel></div>
    </div>
  )
}

function ContainerSurfaceMeasurement({ lightPath, darkPath }: { lightPath: string; darkPath: string }) {
  const [ref, measured] = useComputed<HTMLDivElement>((style) => style.backgroundColor)
  const themeRevision = useThemeRevision()
  const tokenPath = document.documentElement.dataset.theme === "dark" ? darkPath : lightPath
  void themeRevision
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-container p-4" data-measured-surface="Container" data-measured-target="container" data-surface="container" ref={ref}>
      <span aria-hidden className="size-14 shrink-0 rounded-2xl bg-container" data-token-swatch />
      <div className="flex min-w-0 flex-col gap-1"><span className="text-sm font-semibold">Container</span><MeasuredLabel>{measured || "measuring…"} · {tokenPath}</MeasuredLabel></div>
    </div>
  )
}

/** This documentation route is the specimen: its real Canvas holds one real
 * Paper, which holds one real compositing Container. */
function SurfaceLadderSpecimen() {
  const canvas = surfaceTokens.find((entry) => entry.label === "Canvas")
  const paper = surfaceTokens.find((entry) => entry.label === "Paper")
  const container = surfaceTokens.find((entry) => entry.label === "Container")
  if (!canvas || !paper || !container) throw new Error("Surface ladder specimen requires Canvas, Paper, Container tokens")
  return (
    <section aria-label="Surface ladder, rendered" className="grid gap-4 sm:grid-cols-3" data-surface-ladder>
      <ShellSurfaceMeasurement darkPath={canvas.darkPath} label="Canvas" lightPath={canvas.lightPath} target="canvas" />
      <ShellSurfaceMeasurement darkPath={paper.darkPath} label="Paper" lightPath={paper.lightPath} target="paper" />
      <ContainerSurfaceMeasurement darkPath={container.darkPath} lightPath={container.lightPath} />
    </section>
  )
}

function InkSpecimen() {
  const classes: Record<string, string> = { primary: "text-foreground", secondary: "text-muted-foreground", tertiary: "text-fg-tertiary" }
  return (
    <section aria-label="Ink levels, rendered" className="flex flex-col gap-1 rounded-2xl bg-container p-5" data-ink-specimen data-surface="container">
      {inkTokens.map((entry) => <InkLine className={classes[entry.role]} key={entry.role} role={entry.role} source={entry.source} />)}
    </section>
  )
}

function InkLine({ className, role, source }: { className: string; role: string; source: string }) {
  const [ref, measured] = useComputed<HTMLParagraphElement>((style) => style.color)
  return (
    <p className={`flex flex-wrap items-baseline justify-between gap-2 text-base ${className}`} data-ink-role={role} ref={ref}>
      <span className="capitalize">{role} ink carries this sentence.</span>
      <MeasuredLabel>{measured || "measuring…"} · {source}</MeasuredLabel>
    </p>
  )
}

function TypeSpecimen() {
  return (
    <section aria-label="Type ramp, rendered" className="flex flex-col gap-3 rounded-2xl bg-container p-5" data-type-ramp-specimen data-surface="container">
      {typeRoles.map((entry) => <TypeLine key={entry.pixels} pixels={entry.pixels} role={entry.role} />)}
    </section>
  )
}

function TypeLine({ pixels, role }: { pixels: number; role: string }) {
  const [ref, measured] = useComputed<HTMLParagraphElement>((style) => style.fontSize)
  return (
    <p className="flex flex-wrap items-baseline justify-between gap-3" data-type-role={pixels} data-type-specimen={pixels} ref={ref} style={{ fontSize: `${pixels}px` }}>
      <span>{role.charAt(0).toUpperCase() + role.slice(1)} — the law says {pixels} pixels.</span>
      <MeasuredLabel>rendered at {measured || "…"}</MeasuredLabel>
    </p>
  )
}

/** Minimal D4 redline: measures the target's computed padding and gap and
 *  draws labeled bands over the REAL rendered component. Two band types only. */
function Redline({ children, label }: { children: ReactNode; label: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [bands, setBands] = useState<Array<{ key: string; style: Record<string, string | number>; text: string; kind: "padding" | "gap" }>>([])
  useLayoutEffect(() => {
    const host = ref.current?.firstElementChild as HTMLElement | null
    if (!host) return
    const style = getComputedStyle(host)
    const next: typeof bands = []
    const pt = parseFloat(style.paddingTop); const pb = parseFloat(style.paddingBottom)
    const pl = parseFloat(style.paddingLeft); const pr = parseFloat(style.paddingRight)
    if (pt > 0) next.push({ key: "pt", kind: "padding", style: { top: 0, left: 0, right: 0, height: pt }, text: `${pt}px` })
    if (pb > 0) next.push({ key: "pb", kind: "padding", style: { bottom: 0, left: 0, right: 0, height: pb }, text: `${pb}px` })
    if (pl > 0) next.push({ key: "pl", kind: "padding", style: { top: 0, bottom: 0, left: 0, width: pl }, text: `${pl}px` })
    if (pr > 0) next.push({ key: "pr", kind: "padding", style: { top: 0, bottom: 0, right: 0, width: pr }, text: `${pr}px` })
    const gap = parseFloat(style.rowGap || style.gap)
    if (Number.isFinite(gap) && gap > 0 && host.children.length > 1) {
      const first = host.children[0] as HTMLElement
      const offset = first.getBoundingClientRect().bottom - host.getBoundingClientRect().top
      next.push({ key: "gap", kind: "gap", style: { top: offset, left: pl, right: pr, height: gap }, text: `gap ${gap}px` })
    }
    setBands(next)
  }, [])
  return (
    <figure className="flex flex-col gap-2" data-redline={label}>
      <div className="relative w-fit" ref={ref}>
        {children}
        {bands.map((band) => (
          <span
            aria-hidden
            className={`pointer-events-none absolute flex items-center justify-center font-mono text-xs ${band.kind === "padding" ? "bg-status-negative-foreground/15 text-status-negative-foreground" : "bg-status-info-foreground/15 text-status-info-foreground"}`}
            data-redline-band={band.kind}
            data-redline-key={band.key}
            key={band.key}
            style={band.style}
          >{band.text}</span>
        ))}
      </div>
      <figcaption className="text-xs text-muted-foreground">
        {label} — measured from the live component: {bands.map((band) => `${band.key === "gap" ? "gap" : `${({ pt: "top", pb: "bottom", pl: "left", pr: "right" } as const)[band.key as "pt" | "pb" | "pl" | "pr"]} padding`} ${band.text.replace("gap ", "")}`).join(", ") || "measuring…"}. Rose = padding, blue = gap.
      </figcaption>
    </figure>
  )
}

function SpacingSpecimen() {
  return (
    <section aria-label="Spacing, rendered with redlines" className="flex flex-col gap-6" data-spacing-specimen>
      <Redline label="Container owns its padding and the gap between children">
        <div className="flex w-96 max-w-full flex-col gap-3 rounded-2xl bg-container p-4" data-surface="container">
          <Button className="min-h-12" size="sm">Primary action</Button>
          <Button className="min-h-12" size="sm" variant="outline">Secondary action</Button>
        </div>
      </Redline>
      <Redline label="Form group — the same rule, one level down">
        <div className="flex w-96 max-w-full flex-col gap-3 rounded-2xl bg-container p-4" data-surface="container">
          <label className="text-sm font-medium" htmlFor="docs-search">Catalog search</label>
          <Input className="min-h-12" id="docs-search" placeholder={`Search ${catalogCount} governed components`} />
        </div>
      </Redline>
    </section>
  )
}

function RadiusSpecimen() {
  const [outerRef, outerMeasured] = useComputed<HTMLDivElement>((style) => style.borderTopLeftRadius)
  const [innerRef, innerMeasured] = useComputed<HTMLDivElement>((style) => style.borderTopLeftRadius)
  return (
    <section aria-label="Radius, rendered" className="flex flex-col gap-2" data-radius-specimen>
      <div className="w-fit rounded-4xl bg-container p-3" data-radius-outer data-surface="container" ref={outerRef}>
        <div className="rounded-lg bg-container px-4 py-3 text-sm" data-radius-inner data-surface="container" ref={innerRef}>
          Nested grouping stays concentric — inner radius never exceeds outer.
        </div>
      </div>
      <p className="flex gap-4">
        <MeasuredLabel>outer {outerMeasured || "…"}</MeasuredLabel>
        <MeasuredLabel>inner {innerMeasured || "…"}</MeasuredLabel>
        <MeasuredLabel>base {radius.base.value}{radius.base.unit} · foundation.radius.base</MeasuredLabel>
      </p>
    </section>
  )
}

/* ---------------------------------------------------------------- pages */
const foundationCopy = {
  surfaces: {
    headline: "Five roles. One hierarchy. No freelancing.",
    points: [
      { tone: "yes" as const, text: "Canvas holds the page, one Paper holds the work, Containers group by compositing, one Overlay floats." },
      { tone: "no" as const, text: "Nothing else may paint a resting surface — an undeclared fill is a violation, not a choice." },
    ],
  },
  "ink-levels": {
    headline: "Three neutral inks. Status keeps its job.",
    points: [
      { tone: "yes" as const, text: "Primary carries content, secondary carries support, tertiary carries metadata." },
      { tone: "no" as const, text: "Status colors are ink for status alone — never decoration." },
    ],
  },
  "type-ramp": {
    headline: `${typeRoles.map((entry) => entry.pixels).join(" / ")}. That is the whole ramp.`,
    points: [
      { tone: "yes" as const, text: `${typeRoles.map((entry) => `${entry.role} at ${entry.pixels}`).join(", ")}.` },
      { tone: "no" as const, text: "A fourth size is a decision, not a tweak — it needs the law amended first." },
    ],
  },
  "spacing-rhythm": {
    headline: "Containers own space. Children own none.",
    points: [
      { tone: "yes" as const, text: "Padding and gap live on the container; children arrive with zero margin." },
      { tone: "no" as const, text: "A margin utility on a child is the tell that structure went missing." },
    ],
  },
  "radius-grouping": {
    headline: "One radius base. Grouping stays concentric.",
    points: [
      { tone: "yes" as const, text: "Every corner derives from one base value; the ladder is generated, never hand-picked." },
      { tone: "no" as const, text: "An inner radius larger than its outer reads as a broken seam — the scanner catches it." },
    ],
  },
}

function FoundationPage({ page }: { page: keyof typeof foundationCopy }) {
  const copy = foundationCopy[page]
  const lawLine = lawExcerpts(page)[0]?.split(". ")[0]
  return (
    <DocShell eyebrow="Foundations" headline={copy.headline} lawLine={lawLine ? `${lawLine}. — interface-laws.md` : undefined} sources={[sourceNames.tokens, sourceNames.laws, sourceNames.citations, sourceNames.baseline]}>
      {page === "surfaces" ? <SurfaceLadderSpecimen /> : null}
      {page === "ink-levels" ? <InkSpecimen /> : null}
      {page === "type-ramp" ? <TypeSpecimen /> : null}
      {page === "spacing-rhythm" ? <SpacingSpecimen /> : null}
      {page === "radius-grouping" ? <RadiusSpecimen /> : null}
      <Points items={copy.points} />
      {page === "surfaces" ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-2xl border-separate border-spacing-y-1 text-left text-sm">
            <thead><tr>{surfaceRoleTable.headers.map((header) => <th className="px-3 py-2 font-semibold" key={header}>{header}</th>)}</tr></thead>
            <tbody>{surfaceRoleTable.rows.map((row) => <tr data-surface-law-row key={row[0]}>{row.map((cell) => <td className="px-3 py-2" key={cell}>{cell.replaceAll("`", "")}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ) : null}
      {page === "spacing-rhythm" ? <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">Densities: {spacingRoles.map((role) => <span data-spacing-role key={role}>{role}</span>)}</p> : null}
      <EnforcementStrip page={page} />
    </DocShell>
  )
}

function LoopPage() {
  const before = [
    { label: "Always loaded", value: loopFacts.alwaysLoaded, limit: loopFacts.alwaysLoadedRatchet },
    { label: "Component review", value: loopFacts.componentReview, limit: loopFacts.componentReviewRatchet },
  ]
  return (
    <DocShell eyebrow="The live loop" headline="Lean guidance in. Mechanical proof out." sources={["AGENTS.md", "agent-skills/ui-development/SKILL.md", "design-system/context-budget.json", "docs/pr-case/claims.json"]}>
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4 rounded-3xl bg-container p-5" data-surface="container">
          <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">Before generation</p>
          {before.map((fact) => (
            <div className="flex flex-col gap-1.5" key={fact.label}>
              <div className="flex items-baseline justify-between gap-4"><span className="text-sm">{fact.label}</span><strong className="tabular-nums">{fact.value.toLocaleString()} / {fact.limit.toLocaleString()} B</strong></div>
              <div aria-label={`${fact.label} context budget`} aria-valuemax={fact.limit} aria-valuenow={fact.value} className="h-1.5 overflow-hidden rounded-full bg-border" role="progressbar"><div className="h-full rounded-full bg-status-positive-foreground" style={{ width: `${Math.min(100, (fact.value / fact.limit) * 100)}%` }} /></div>
            </div>
          ))}
          <p className="text-sm text-muted-foreground">Owner ceiling {loopFacts.ownerCeiling.toLocaleString()} bytes — no exception path.</p>
        </div>
        <div className="flex flex-col gap-4 rounded-3xl bg-container p-5" data-surface="container">
          <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">After generation</p>
          <dl className="grid grid-cols-2 gap-3">
            <Metric label="Package checks" numeric value={loopFacts.checkScripts} />
            <Metric label="Gate stages" numeric value={loopFacts.gateStages} />
            <Metric label="Routed guidance" numeric value={`${loopFacts.routedGuidance.toLocaleString()} B`} />
            <Metric label="Preserved failures" numeric value={loopFacts.failedExactHeads} />
          </dl>
        </div>
      </section>
      <Points items={[
        { tone: "yes", text: `The loop caught itself: integration briefly hit ${loopFacts.integrationRegression.toLocaleString()} bytes against the ${loopFacts.alwaysLoadedRatchet.toLocaleString()} ratchet — refused, then routed.` },
        { text: "These pages are generated from the same sources the gate checksums; a stale projection fails the build." },
      ]} />
    </DocShell>
  )
}

function CasePage() {
  return (
    <DocShell eyebrow="Reviewer case · depth layer" headline="A governed system, not a screenshot replacement." sources={[sourceNames.tokens, sourceNames.catalog, sourceNames.laws]}>
      <dl className="grid gap-3 sm:grid-cols-3">
        <Metric label="Governed components" numeric value={catalogCount} />
        <Metric label="Pinned story files" numeric value={loopFacts.storyFiles} />
        <Metric label="Interface-law lines" numeric value={loopFacts.lawLines} />
      </dl>
      <Points items={[
        { text: "The pull-request deck is the horizontal argument; these pages are the vertical evidence." },
        { text: `Comparison pin: main ${sourcePins.base.slice(0, 10)} · branch ${sourcePins.branch.slice(0, 10)}.` },
      ]} />
      <a className="inline-flex min-h-12 w-fit items-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground" href="?path=/story/docs-design-system--live-loop">Open the live loop</a>
    </DocShell>
  )
}

function LedgerPage() {
  return (
    <DocShell eyebrow="Provenance" headline="Decisions have receipts." sources={[sourceNames.ledger, "git log --first-parent <pinned-range>"]}>
      {decisionLedger.length ? (
        <ol className="grid gap-2">
          {decisionLedger.map((entry) => (
            <li className="flex min-h-11 flex-wrap items-baseline gap-x-4 gap-y-1 rounded-2xl bg-container px-4 py-2.5" data-surface="container" key={entry.commit}>
              <span className="font-mono text-xs text-muted-foreground tabular-nums">{entry.date}</span>
              <span className="text-sm font-medium">{entry.decision}</span>
              <code className="ml-auto text-xs text-muted-foreground">{entry.commit.slice(0, 10)}</code>
            </li>
          ))}
        </ol>
      ) : (
        <Points items={[{ text: "Awaiting owner-approved historical summaries — the generator will not invent lines to look occupied." }]} />
      )}
    </DocShell>
  )
}

function IndexPage() {
  return (
    <DocShell eyebrow="Generated reference" headline={`${catalogCount} components. ${catalogExportCount} exports. Projected.`} sources={[sourceNames.catalog]}>
      <div className="grid gap-6">
        {catalogByTier.map((group) => (
          <section className="flex flex-col gap-3" key={group.tier}>
            <h2 className="text-xl font-semibold capitalize">{group.tier}s · {group.components.length}</h2>
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {group.components.map((component) => (
                <li className="rounded-3xl bg-container p-4" data-catalog-component={component.id} data-surface="container" key={component.id}>
                  <h3 className="font-semibold">{component.name}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">{component.module}</p>
                  <div className="mt-3 flex flex-wrap gap-1.5" data-catalog-exports>
                    {component.exports.map((entry) => <code className="px-2 py-1 text-xs text-muted-foreground" data-catalog-export={entry} key={entry}>{entry}</code>)}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </DocShell>
  )
}

export function DesignDocs({ page }: { page: DesignDocPage }) {
  if (page === "case") return <CasePage />
  if (page === "loop") return <LoopPage />
  if (page === "ledger") return <LedgerPage />
  if (page === "index") return <IndexPage />
  return <FoundationPage page={page} />
}
