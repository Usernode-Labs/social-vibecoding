import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = path.resolve(frontendRoot, "..")
const policyPath = path.join(frontendRoot, "design-system/context-budget.json")

export const progressiveContextFixture = Object.freeze({
  task: "Polish Home app shortcut component copy and add Storybook state",
  query: "Home app shortcut",
  componentId: "home-app-shortcut",
  exportName: "HomeAppShortcut",
})

export const progressiveContextFixtures = Object.freeze([
  progressiveContextFixture,
  Object.freeze({ query: "ToggleGroupItem", componentId: "primitive-toggle-group", exportName: "ToggleGroupItem" }),
  Object.freeze({ query: "ActionAnchor", componentId: "action-link", exportName: "ActionAnchor" }),
  Object.freeze({ query: "StatusDot", componentId: "status-dot", exportName: "StatusDot" }),
  Object.freeze({ query: "primitive-card", componentId: "primitive-card", exportName: "Card" }),
])

function footprint(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath)
  if (!fs.existsSync(absolutePath)) return 0
  if (fs.statSync(absolutePath).isFile()) return fs.statSync(absolutePath).size
  return fs.readdirSync(absolutePath, { withFileTypes: true }).reduce((total, entry) => (
    total + footprint(path.join(relativePath, entry.name))
  ), 0)
}

function repositoryPath(aliasPath) {
  if (typeof aliasPath !== "string") return null
  if (aliasPath.startsWith("@/")) return path.join("frontend", "@", aliasPath.slice(2))
  return aliasPath
}

function targetFile(relativePath) {
  if (!relativePath) return null
  const absolutePath = path.join(repoRoot, relativePath)
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) return null
  return { path: relativePath, bytes: fs.statSync(absolutePath).size }
}

export function collectProgressiveContext(options = {}) {
  const fixture = options.fixture || progressiveContextFixture
  const fixtures = options.fixtures || [fixture, ...progressiveContextFixtures.filter((item) => item !== progressiveContextFixture)]
  const route = options.route || JSON.parse(execFileSync(process.execPath, [
    path.join(repoRoot, "tool/ui-workflow.mjs"),
    "--task", fixture.task,
    "--files", "",
    "--json",
  ], { cwd: repoRoot, encoding: "utf8" }))
  const queryResults = options.queryResults || fixtures.map((item, index) => (
    index === 0 && options.query
      ? options.query
      : JSON.parse(execFileSync(process.execPath, [
        path.join(frontendRoot, "scripts/query-design-system.mjs"),
        item.query,
      ], { cwd: frontendRoot, encoding: "utf8" }))
  ))
  const policy = options.policy || JSON.parse(fs.readFileSync(policyPath, "utf8"))
  const discoveryCases = fixtures.map((item, index) => {
    const query = queryResults[index]
    const target = query.components?.find((component) => component.id === item.componentId) || null
    const sourcePath = repositoryPath(target?.module)
    const storyPath = repositoryPath(target?.evidence?.story)
    return {
      fixture: item,
      query: {
        mode: query.mode,
        count: query.count,
        componentIds: (query.components || []).map((component) => component.id),
      },
      target: target ? {
        id: target.id,
        exports: target.exports || [target.export].filter(Boolean),
        source: targetFile(sourcePath),
        story: targetFile(storyPath),
      } : null,
    }
  })
  const primary = discoveryCases[0]

  return {
    schemaVersion: 2,
    fixture,
    ownerCeilingBytes: policy.ownerLock?.postRoutingCeilingBytes ?? null,
    route: {
      classifications: route.classifications || [],
      context: route.context || [],
      discovery: route.discovery || [],
      totalBytes: (route.context || []).reduce((total, relativePath) => total + footprint(relativePath), 0),
    },
    query: primary.query,
    target: primary.target,
    discoveryCases,
  }
}

export function evaluateProgressiveContext(report) {
  const violations = []
  for (const workflow of ["content", "component", "review"]) {
    if (!report.route.classifications.includes(workflow)) {
      violations.push(`component-review discovery fixture did not select ${workflow}`)
    }
  }
  for (const requiredPath of [
    "agent-skills/ui-development/references/authority.md",
    "frontend/design-system/interface-laws.md",
  ]) {
    if (!report.route.context.includes(requiredPath)) {
      violations.push(`component-review context does not load ${requiredPath}`)
    }
  }
  for (const bulkPath of [
    "agent-skills/ui-development/references/usernode-api.md",
    "frontend/design-system/catalog.json",
    "frontend/design-system.manifest.json",
    "frontend/@/components/ui",
    "frontend/registry.json",
    "docs/react-migration.md",
  ]) {
    if (report.route.context.includes(bulkPath)) {
      violations.push(`component-review context must query instead of loading ${bulkPath}`)
    }
  }
  if (!report.route.discovery.some((command) => command.startsWith("npm run query:design-system"))) {
    violations.push("component-review workflow does not expose the catalog query")
  }
  if (!Number.isInteger(report.ownerCeilingBytes) || report.ownerCeilingBytes < 0) {
    violations.push("progressive context fixture has no owner ceiling")
  } else if (report.route.totalBytes > report.ownerCeilingBytes) {
    violations.push(`component-review route is ${report.route.totalBytes} bytes; ceiling is ${report.ownerCeilingBytes}`)
  }
  const discoveryCases = report.discoveryCases || [{ fixture: report.fixture, query: report.query, target: report.target }]
  for (const discovery of discoveryCases) {
    if (discovery.query?.count !== 1 || discovery.query.componentIds?.[0] !== discovery.fixture.componentId) {
      violations.push(`catalog query must resolve exactly ${discovery.fixture.componentId}`)
    }
    if (!discovery.target) {
      violations.push(`catalog query did not discover ${discovery.fixture.componentId}`)
      continue
    }
    if (discovery.fixture.exportName && !discovery.target.exports?.includes(discovery.fixture.exportName)) {
      violations.push(`catalog entry ${discovery.fixture.componentId} does not expose ${discovery.fixture.exportName}`)
    }
    for (const targetKind of ["source", "story"]) {
      const targetFile = discovery.target[targetKind]
      if (!targetFile?.path || !Number.isInteger(targetFile.bytes) || targetFile.bytes <= 0) {
        violations.push(`catalog entry ${discovery.fixture.componentId} did not resolve a readable target ${targetKind}`)
      } else if (report.route.context.some((entry) => targetFile.path === entry || targetFile.path.startsWith(`${entry}/`))) {
        violations.push(`target ${targetKind} was bulk-loaded instead of discovered on demand: ${targetFile.path}`)
      }
    }
  }
  return violations
}

function printSummary(report) {
  console.log("Progressive component-review context check (blocking):")
  console.log(`- Routed context: ${report.route.totalBytes}/${report.ownerCeilingBytes} bytes`)
  console.log(`- Loaded law: ${report.route.context.includes("frontend/design-system/interface-laws.md")}`)
  for (const discovery of report.discoveryCases || [{ fixture: report.fixture, target: report.target }]) {
    console.log(`- ${discovery.fixture.query}: ${discovery.target?.id || "missing"} · ${discovery.target?.source?.path || "missing source"} · ${discovery.target?.story?.path || "missing story"}`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = collectProgressiveContext()
  const violations = evaluateProgressiveContext(report)
  if (process.argv.includes("--json")) console.log(JSON.stringify({ ...report, violations }, null, 2))
  else printSummary(report)
  if (violations.length) {
    console.error(`Progressive context check failed:\n\n${violations.map((item) => `- ${item}`).join("\n")}`)
    process.exit(1)
  }
}
