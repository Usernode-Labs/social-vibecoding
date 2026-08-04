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

async function assertRedlineGeometry(redline: HTMLElement) {
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
  const borders = {
    top: Number.parseFloat(style.borderTopWidth),
    right: Number.parseFloat(style.borderRightWidth),
    bottom: Number.parseFloat(style.borderBottomWidth),
    left: Number.parseFloat(style.borderLeftWidth),
  }
  const first = host.firstElementChild as HTMLElement
  const gapTop = first.getBoundingClientRect().bottom - host.getBoundingClientRect().top
  const bands = redline.querySelectorAll<HTMLElement>("[data-redline-band]")
  await expect([...bands].map((band) => band.dataset.redlineBand).sort()).toEqual(["gap", "padding", "padding", "padding", "padding"])
  for (const [key, value] of Object.entries(expected)) {
    const band = redline.querySelector<HTMLElement>(`[data-redline-key="${key}"]`)!
    await expect(band).toBeTruthy()
    await expect(band.textContent).toContain(`${value}px`)
    const dimension = key === "pl" || key === "pr" ? band.style.width : band.style.height
    await expect(Number.parseFloat(dimension)).toBe(value)
  }
  await expect(Number.parseFloat(redline.querySelector<HTMLElement>('[data-redline-key="pt"]')!.style.top)).toBe(borders.top)
  await expect(Number.parseFloat(redline.querySelector<HTMLElement>('[data-redline-key="pb"]')!.style.bottom)).toBe(borders.bottom)
  await expect(Number.parseFloat(redline.querySelector<HTMLElement>('[data-redline-key="pl"]')!.style.left)).toBe(borders.left)
  await expect(Number.parseFloat(redline.querySelector<HTMLElement>('[data-redline-key="pr"]')!.style.right)).toBe(borders.right)
  const gapBand = redline.querySelector<HTMLElement>('[data-redline-key="gap"]')!
  await expect(Number.parseFloat(gapBand.style.top)).toBe(gapTop)
  await expect(Number.parseFloat(gapBand.style.left)).toBe(borders.left + expected.pl)
  await expect(Number.parseFloat(gapBand.style.right)).toBe(borders.right + expected.pr)
  await expect(redline.querySelector("figcaption")?.textContent).toContain(`${expected.gap}px`)
  return { host, wrapper }
}

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
      if (["surfaces", "ink-levels", "type-ramp", "spacing-rhythm", "radius-grouping", "redlines"].includes(value)) {
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
          const { host } = await assertRedlineGeometry(redline)
          await expect(redline.querySelectorAll('[data-redline-violation="margin"]')).toHaveLength(0)
          for (const child of [...host.children] as HTMLElement[]) {
            const childStyle = getComputedStyle(child)
            await expect([childStyle.marginTop, childStyle.marginRight, childStyle.marginBottom, childStyle.marginLeft]).toEqual(["0px", "0px", "0px", "0px"])
          }
          await expect(redline.querySelector("figcaption")?.textContent).toContain("Direct-child margins: 0px")
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
      if (value === "redlines") {
        const shell = canvasElement.querySelector<HTMLElement>("[data-redline-contract]")!
        await expect(shell).toBeTruthy()
        await expect([...shell.children].map((element) => element.getAttribute("data-redline-region"))).toEqual(["header", "body", "targets"])

        const keyline = getComputedStyle(shell)
        for (const width of [keyline.borderTopWidth, keyline.borderRightWidth, keyline.borderBottomWidth, keyline.borderLeftWidth]) await expect(width).toBe("1px")
        for (const style of [keyline.borderTopStyle, keyline.borderRightStyle, keyline.borderBottomStyle, keyline.borderLeftStyle]) await expect(style).toBe("solid")
        for (const color of [keyline.borderTopColor, keyline.borderRightColor, keyline.borderBottomColor, keyline.borderLeftColor]) await expect(color).not.toMatch(/^(?:transparent|rgba\([^)]*,\s*0\))$/)

        const targets = [...canvasElement.querySelectorAll<HTMLElement>("[data-live-target]")]
        await expect(targets.length).toBe(4)
        for (const target of targets) {
          const bounds = target.getBoundingClientRect()
          await expect(bounds.height).toBeGreaterThanOrEqual(44)
          await expect(bounds.height).toBeLessThanOrEqual(48)
        }
        for (const [index, target] of targets.entries()) {
          const left = target.getBoundingClientRect()
          for (const sibling of targets.slice(index + 1)) {
            const right = sibling.getBoundingClientRect()
            const overlaps = left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top
            await expect(overlaps).toBe(false)
          }
        }

        const shellRedline = shell.closest<HTMLElement>("[data-redline]")!
        const { host: measuredShell } = await assertRedlineGeometry(shellRedline)
        await expect(shellRedline.querySelectorAll('[data-redline-violation="margin"]')).toHaveLength(0)
        await expect(canvasElement.querySelectorAll('[data-redline-band="margin"]')).toHaveLength(0)
        for (const child of [...measuredShell.children] as HTMLElement[]) {
          const style = getComputedStyle(child)
          await expect([style.marginTop, style.marginRight, style.marginBottom, style.marginLeft]).toEqual(["0px", "0px", "0px", "0px"])
        }
        const marginHost = canvasElement.querySelector<HTMLElement>("[data-margin-probe]")!
        const marginRedline = marginHost.closest<HTMLElement>("[data-redline]")!
        const violations = marginRedline.querySelectorAll<HTMLElement>('[data-redline-violation="margin"]')
        await expect(violations).toHaveLength(1)
        await expect(violations[0]).toHaveAttribute("data-redline-child-index", "1")
        await expect(violations[0].textContent).toContain("top 8px")
        await expect(violations[0]).not.toHaveAttribute("data-redline-band")
        const violatingChild = marginHost.children[1] as HTMLElement
        const wrapperRect = (marginRedline.firstElementChild as HTMLElement).getBoundingClientRect()
        const childRect = violatingChild.getBoundingClientRect()
        await expect(Number.parseFloat(violations[0].style.top)).toBe(childRect.top - wrapperRect.top)
        await expect(Number.parseFloat(violations[0].style.left)).toBe(childRect.left - wrapperRect.left)
        const guidance = canvas.getByText(/native measure tool/i)
        await expect(guidance).toBeVisible()
        await expect(guidance.textContent).toMatch(/Press M to toggle/i)
        await expect(guidance.querySelector("kbd")?.textContent).toBe("M")
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
export const RedlineGeometry = page("redlines")
export const DecisionLedger = page("ledger")
export const ComponentIndex = page("index")
