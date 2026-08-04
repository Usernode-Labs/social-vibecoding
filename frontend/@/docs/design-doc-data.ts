import catalogSource from "../../design-system/catalog.json?raw"
import citationsSource from "../../design-system/interface-law-citations.json?raw"
import contextSource from "../../design-system/context-budget.json?raw"
import interfaceLawBaselineSource from "../../design-system/interface-law-baseline.json?raw"
import ledgerSource from "../../design-system/decision-ledger.json?raw"
import lawsSource from "../../design-system/interface-laws.md?raw"
import tokensSource from "../../design-system/tokens.json?raw"
import prCaseSource from "../../../docs/pr-case/claims.json?raw"

type TokenLeaf = { $value: unknown }
type TokenTree = Record<string, unknown>

export type Citation = {
  id: string
  page: string
  lawSection: string
  kind: "scanner-rule" | "rendered-test" | "review-only"
  rule?: string
  check?: string
  test?: { path: string; name: string }
  story?: { path: string; export: string }
  review?: { path: string; instruction: string }
  catches: string
  misses: string
}

export type CatalogComponent = {
  id: string
  name: string
  tier: "element" | "block" | "feature"
  module: string
  export: string
  exports: string[]
  maturity: string
  variants: string[]
  evidence: { story: string; states: string[] }
}

export type LedgerEntry = {
  date: string
  decision: string
  originEvent: string
  commit: string
  commitSubject: string
  receiptEvent: string
  approvalEvent: string
}

const tokens = JSON.parse(tokensSource) as TokenTree
const catalog = JSON.parse(catalogSource) as { components: CatalogComponent[] }
const citationAuthority = JSON.parse(citationsSource) as { citations: Citation[] }
const interfaceLawBaseline = JSON.parse(interfaceLawBaselineSource) as { findings: Array<{ count?: number }> }
const context = JSON.parse(contextSource) as {
  componentReview: { postRoutingRatchetBytes: number; postRoutingEntries: Array<{ path: string; acceptedBytes: number }> }
  globalRatchets: { alwaysLoadedBytes: number; skillActivationBytes: number }
  ownerLock: { postRoutingCeilingBytes: number }
}
const ledger = JSON.parse(ledgerSource) as { entries: LedgerEntry[] }
const prCase = JSON.parse(prCaseSource) as {
  generatedFrom: { comparisonBaseRevision: string; comparisonBranchRevision: string }
  facts: {
    branch: { storyFiles: number; checkScripts: number; catalogComponents: number }
    laws: { physicalLines: number; nonblankLines: number; bytes: number }
    context: { alwaysLoadedBytes: number; componentReviewBytes: number }
    gate: { stages: number; integrationAlwaysLoadedBytes: number; routedGuidanceBytes: number; failedExactHeads: number }
  }
}

export const lawFullText = lawsSource

function token(path: string) {
  const value = path.split(".").reduce<unknown>((current, key) => (
    typeof current === "object" && current !== null ? (current as TokenTree)[key] : undefined
  ), tokens)
  if (!value || typeof value !== "object" || !("$value" in value)) throw new Error(`Missing design token ${path}`)
  return (value as TokenLeaf).$value
}

function section(name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = lawsSource.match(new RegExp(`^## ${escaped}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"))
  if (!match) throw new Error(`Missing interface-law section ${name}`)
  return match[1].trim()
}

function paragraphs(source: string) {
  return source.split(/\n\s*\n/).map((value) => value.replace(/\n/g, " ").trim()).filter(Boolean)
}

function colorLabel(value: unknown) {
  if (typeof value === "string") return value
  if (typeof value !== "object" || value === null) return String(value)
  const color = value as { colorSpace?: string; components?: number[]; alpha?: number }
  if (!color.colorSpace || !color.components) return JSON.stringify(value)
  const components = color.components.join(" ")
  return `${color.colorSpace}(${components}${color.alpha === undefined ? "" : ` / ${color.alpha}`})`
}

export const sourcePins = {
  base: prCase.generatedFrom.comparisonBaseRevision,
  branch: prCase.generatedFrom.comparisonBranchRevision,
}

export const loopFacts = {
  alwaysLoaded: prCase.facts.context.alwaysLoadedBytes,
  alwaysLoadedRatchet: context.globalRatchets.alwaysLoadedBytes,
  componentReview: prCase.facts.context.componentReviewBytes,
  componentReviewRatchet: context.componentReview.postRoutingRatchetBytes,
  ownerCeiling: context.ownerLock.postRoutingCeilingBytes,
  routedGuidance: prCase.facts.gate.routedGuidanceBytes,
  integrationRegression: prCase.facts.gate.integrationAlwaysLoadedBytes,
  failedExactHeads: prCase.facts.gate.failedExactHeads,
  gateStages: prCase.facts.gate.stages,
  checkScripts: prCase.facts.branch.checkScripts,
  storyFiles: prCase.facts.branch.storyFiles,
  lawLines: prCase.facts.laws.physicalLines,
  lawBytes: prCase.facts.laws.bytes,
  acceptedWarningEntries: interfaceLawBaseline.findings.length,
  acceptedWarningOccurrences: interfaceLawBaseline.findings.reduce((total, finding) => total + (finding.count || 1), 0),
  routedEntries: context.componentReview.postRoutingEntries,
}

export const surfaceTokens = [
  ["Canvas", "semantic.light.background", "semantic.dark.background"],
  ["Paper", "semantic.light.paper", "semantic.dark.paper"],
  ["Container", "semantic.light.container", "semantic.dark.container"],
  ["Hosted-app Canvas", "semantic.light.stage", "semantic.dark.stage"],
].map(([label, lightPath, darkPath]) => ({
  label,
  light: colorLabel(token(lightPath)),
  dark: colorLabel(token(darkPath)),
  lightPath,
  darkPath,
}))

export const inkTokens = ["primary", "secondary", "tertiary"].map((role) => ({
  role,
  light: colorLabel(token(`semantic.light.fg-${role}`)),
  dark: colorLabel(token(`semantic.dark.fg-${role}`)),
  source: `semantic.{light,dark}.fg-${role}`,
}))

const typeLaw = section("3. Type and target roles")
export const typeRoles = [...typeLaw.matchAll(/(\d+) CSS pixels for ([^,.]+)|(?:and )?(\d+) for ([^,.]+)|(?:and )?(\d+) only for ([^.]+)\./g)]
  .map((match) => ({ pixels: Number(match[1] || match[3] || match[5]), role: (match[2] || match[4] || match[6]).trim() }))
  .filter((entry) => Number.isFinite(entry.pixels))

const spacingLaw = section("2. Radius and spacing")
const spacingMatch = spacingLaw.match(/Spacing uses four semantic densities: ([^.]+)\./)
export const spacingRoles = (spacingMatch?.[1] || "").split(/, and |, /).map((value) => value.trim()).filter(Boolean)

export const radius = {
  base: token("foundation.radius.base") as { value: number; unit: string },
  allowed: spacingLaw.match(/Use only governed `([^`]+)`, `([^`]+)`–`([^`]+)`, or `([^`]+)`/)?.slice(1) || [],
}

const surfaceLaw = section("1. Surface role")
const surfaceTable = surfaceLaw.split("\n").filter((line) => /^\|.+\|$/.test(line)).map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
export const surfaceRoleTable = { headers: surfaceTable[0] || [], rows: surfaceTable.slice(2) }

if (typeRoles.length !== 3) throw new Error(`Expected three type roles from interface laws, received ${typeRoles.length}`)
if (spacingRoles.length !== 4) throw new Error(`Expected four spacing roles from interface laws, received ${spacingRoles.length}`)
if (radius.allowed.length !== 4) throw new Error(`Expected four radius roles from interface laws, received ${radius.allowed.length}`)
if (surfaceRoleTable.headers.length !== 3 || surfaceRoleTable.rows.length !== 5) {
  throw new Error("Expected the five-row surface-role table from interface laws")
}

const excerpts: Record<string, string[]> = {
  surfaces: paragraphs(surfaceLaw).filter((value) => !value.includes("| Role |")).slice(0, 3),
  "ink-levels": paragraphs(section("1. Surface role")).slice(3, 5),
  "type-ramp": paragraphs(typeLaw).slice(0, 1),
  "spacing-rhythm": paragraphs(spacingLaw).slice(1, 4),
  "radius-grouping": paragraphs(spacingLaw).slice(0, 1),
}

export function lawExcerpts(page: string) {
  return excerpts[page] || []
}

export function citationsFor(page: string) {
  return citationAuthority.citations.filter((citation) => citation.page === page)
}

export const catalogByTier = (["element", "block", "feature"] as const).map((tier) => ({
  tier,
  components: catalog.components.filter((component) => component.tier === tier).sort((left, right) => left.name.localeCompare(right.name)),
}))

export const catalogCount = catalog.components.length
export const catalogExportCount = catalog.components.reduce((total, component) => total + component.exports.length, 0)
export const decisionLedger = ledger.entries
