import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"

import { DesignDocs, type DesignDocPage } from "@/docs/design-docs"
import { catalogCount, catalogExportCount } from "@/docs/design-doc-data"

const meta = {
  title: "Docs/Design system",
  component: DesignDocs,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof DesignDocs>

export default meta
type Story = StoryObj<typeof meta>

function page(value: DesignDocPage): Story {
  return {
    args: { page: value },
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement)
      await expect(canvas.getByRole("heading", { level: 1 })).toBeVisible()
      await expect(canvasElement.querySelector("[data-doc-page]")).toBeTruthy()
      await expect(canvasElement.querySelectorAll("[data-source-ref]").length).toBeGreaterThan(0)
      await expect(canvasElement.querySelectorAll('[data-surface="paper"]').length).toBe(1)
      for (const points of canvasElement.querySelectorAll("[data-doc-points]")) await expect(points.children.length).toBeLessThanOrEqual(3)
      if (["surfaces", "ink-levels", "type-ramp", "spacing-rhythm", "radius-grouping"].includes(value)) {
        await expect(canvasElement.querySelector("[data-law-block]")).toBeTruthy()
        await expect(canvasElement.querySelectorAll("[data-citation-id]").length).toBeGreaterThan(0)
        const docPage = canvasElement.querySelector<HTMLElement>("[data-doc-page]")!
        const undeclaredPainters = [...docPage.querySelectorAll<HTMLElement>("[class]")].filter((element) => {
          const paintsStructure = element.className.split(/\s+/).some((entry) => entry.startsWith("bg-") || entry.startsWith("ring-") || entry.startsWith("shadow-"))
          const ownsPrimitivePaint = element.matches("a, button, input, select, textarea") || Boolean(element.closest("[data-slot]"))
          const ownsSemanticInk = Boolean(element.closest('[role="status"], [role="progressbar"], [data-doc-marker], [data-token-swatch], [data-redline-band]'))
          return paintsStructure && !element.dataset.surface && !ownsPrimitivePaint && !ownsSemanticInk
        })
        await expect(undeclaredPainters.map((element) => element.tagName)).toEqual([])
        for (const summary of docPage.querySelectorAll<HTMLElement>("summary")) await expect(summary.getBoundingClientRect().height).toBeGreaterThanOrEqual(48)
      }
      if (value === "surfaces") {
        await expect(canvasElement.querySelectorAll("[data-surface-law-row]").length).toBe(5)
        const docPage = canvasElement.querySelector<HTMLElement>("[data-doc-page]")!
        const measurements = docPage.querySelectorAll<HTMLElement>("[data-measured-surface]")
        await expect(measurements.length).toBe(3)
        for (const measurement of measurements) {
          const target = measurement.dataset.measuredTarget === "canvas" ? docPage : measurement.dataset.measuredTarget === "paper" ? docPage.querySelector<HTMLElement>('[data-surface="paper"]')! : measurement
          const label = measurement.querySelector<HTMLElement>("[data-measured-label]")!
          await expect(label.textContent).toContain(getComputedStyle(target).backgroundColor)
          await expect(label.textContent).toContain(document.documentElement.dataset.theme === "dark" ? "semantic.dark." : "semantic.light.")
        }
      }
      if (value === "ink-levels") {
        const inkLines = canvasElement.querySelectorAll<HTMLElement>("[data-ink-role]")
        await expect(inkLines.length).toBe(3)
        for (const line of inkLines) {
          await expect(line.querySelector("[data-measured-label]")?.textContent).toContain(getComputedStyle(line).color)
        }
      }
      if (value === "type-ramp") {
        await expect(canvasElement.querySelectorAll("[data-type-role]").length).toBe(3)
        const specimens = canvasElement.querySelectorAll<HTMLElement>("[data-type-specimen]")
        await expect(specimens.length).toBe(3)
        for (const specimen of specimens) {
          await expect(getComputedStyle(specimen).fontSize).toBe(`${specimen.dataset.typeSpecimen}px`)
          await expect(specimen.querySelector("[data-measured-label]")?.textContent).toContain(getComputedStyle(specimen).fontSize)
        }
      }
      if (value === "spacing-rhythm") {
        await document.fonts.ready
        await expect(document.fonts.status).toBe("loaded")
        await expect(canvasElement.querySelectorAll("[data-spacing-role]").length).toBe(4)
        const redlines = canvasElement.querySelectorAll<HTMLElement>("[data-redline]")
        await expect(redlines.length).toBe(2)
        for (const redline of redlines) {
          const wrapper = redline.firstElementChild as HTMLElement
          const host = wrapper.firstElementChild as HTMLElement
          const style = getComputedStyle(host)
          const expected = {
            pt: Number.parseFloat(style.paddingTop),
            pb: Number.parseFloat(style.paddingBottom),
            pl: Number.parseFloat(style.paddingLeft),
            pr: Number.parseFloat(style.paddingRight),
            gap: Number.parseFloat(style.rowGap || style.gap),
          }
          const first = host.firstElementChild as HTMLElement
          const gapTop = first.getBoundingClientRect().bottom - host.getBoundingClientRect().top
          const bands = redline.querySelectorAll<HTMLElement>("[data-redline-band]")
          await expect(bands.length).toBe(5)
          for (const [key, value] of Object.entries(expected)) {
            const band = redline.querySelector<HTMLElement>(`[data-redline-key="${key}"]`)!
            await expect(band).toBeTruthy()
            await expect(band.textContent).toContain(`${value}px`)
            const dimension = key === "pl" || key === "pr" ? band.style.width : band.style.height
            await expect(Number.parseFloat(dimension)).toBe(value)
          }
          await expect(redline.querySelector<HTMLElement>('[data-redline-key="pt"]')?.style.top).toBe("0px")
          await expect(redline.querySelector<HTMLElement>('[data-redline-key="pb"]')?.style.bottom).toBe("0px")
          await expect(redline.querySelector<HTMLElement>('[data-redline-key="pl"]')?.style.left).toBe("0px")
          await expect(redline.querySelector<HTMLElement>('[data-redline-key="pr"]')?.style.right).toBe("0px")
          const gapBand = redline.querySelector<HTMLElement>('[data-redline-key="gap"]')!
          await expect(Number.parseFloat(gapBand.style.top)).toBe(gapTop)
          await expect(Number.parseFloat(gapBand.style.left)).toBe(expected.pl)
          await expect(Number.parseFloat(gapBand.style.right)).toBe(expected.pr)
          await expect(redline.querySelector("figcaption")?.textContent).toContain(`${expected.gap}px`)
        }
      }
      if (value === "radius-grouping") {
        const outer = canvasElement.querySelector<HTMLElement>("[data-radius-outer]")
        const inner = canvasElement.querySelector<HTMLElement>("[data-radius-inner]")
        await expect(outer).toBeTruthy()
        await expect(inner).toBeTruthy()
        const outerStyle = getComputedStyle(outer!)
        const innerStyle = getComputedStyle(inner!)
        const outerRadius = Number.parseFloat(outerStyle.borderTopLeftRadius)
        const innerRadius = Number.parseFloat(innerStyle.borderTopLeftRadius)
        const inset = Number.parseFloat(outerStyle.paddingLeft)
        await expect(outerRadius).toBeGreaterThanOrEqual(innerRadius + inset)
      }
      if (value === "index") {
        await expect(canvasElement.querySelectorAll("[data-catalog-component]").length).toBe(catalogCount)
        await expect(canvasElement.querySelectorAll("[data-catalog-export]").length).toBe(catalogExportCount)
        await expect(canvasElement.querySelector('[data-catalog-export="AlertTitle"]')).toBeTruthy()
      }
    },
  }
}

export const ReviewerCase = page("case")
export const LiveLoop = page("loop")
export const Surfaces = page("surfaces")
export const SurfacesDark = { ...page("surfaces"), globals: { theme: "dark" } }
export const InkLevels = page("ink-levels")
export const InkLevelsDark = { ...page("ink-levels"), globals: { theme: "dark" } }
export const TypeRamp = page("type-ramp")
export const SpacingRhythm = page("spacing-rhythm")
export const RadiusGrouping = page("radius-grouping")
export const DecisionLedger = page("ledger")
export const ComponentIndex = page("index")
