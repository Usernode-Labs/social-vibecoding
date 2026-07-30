import fs from "node:fs"
import path from "node:path"
import ts from "typescript"
import { checkCatalog } from "./design-system-catalog-tools.mjs"
import { checkDesignTokens } from "./design-token-tools.mjs"
import { relationshipViolations } from "./component-relationship-tools.mjs"

const frontendRoot = process.cwd()
const manifestPath = path.join(frontendRoot, "design-system.manifest.json")
const authorityPath = path.join(frontendRoot, "design-system", "authority.json")
const relationshipsPath = path.join(frontendRoot, "design-system", "relationships.json")
const catalogPath = path.join(frontendRoot, "design-system", "catalog.json")
const coveragePath = path.join(frontendRoot, "design-system", "coverage.json")
const violations = []
const tierPrefixes = {
  element: "Elements/",
  block: "Blocks/",
  feature: "Features/",
}

function readJson(fileName) {
  try {
    return JSON.parse(fs.readFileSync(fileName, "utf8"))
  } catch (error) {
    violations.push(`${path.relative(frontendRoot, fileName)} is not valid JSON: ${error.message}`)
    return null
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validatePerformance(value, label) {
  if (!isRecord(value)) {
    violations.push(`${label} must be an object`)
    return
  }
  const expectedFields = [
    "expectedCollectionSize",
    "updateFrequency",
    "stateScope",
    "virtualization",
    "mountPolicy",
    "sensitiveInteractions",
    "followUp",
  ]
  for (const field of Object.keys(value)) {
    if (!expectedFields.includes(field)) violations.push(`${label}.${field} is not a supported performance field`)
  }
  const size = value.expectedCollectionSize
  if (!isRecord(size)) {
    violations.push(`${label}.expectedCollectionSize must be an object`)
  } else {
    const allowedSizeFields = ["category", "rationale"]
    for (const field of Object.keys(size)) {
      if (!allowedSizeFields.includes(field)) violations.push(`${label}.expectedCollectionSize.${field} is not supported`)
    }
    if (!["single", "small", "medium", "large", "unbounded"].includes(size.category)) {
      violations.push(`${label}.expectedCollectionSize.category is invalid`)
    }
    if (typeof size.rationale !== "string" || !size.rationale.trim()) {
      violations.push(`${label}.expectedCollectionSize.rationale must explain the assumption`)
    }
  }
  if (!["static", "occasional", "interactive", "streaming"].includes(value.updateFrequency)) {
    violations.push(`${label}.updateFrequency is invalid`)
  }
  if (!["local", "shared", "global", "mixed"].includes(value.stateScope)) {
    violations.push(`${label}.stateScope is invalid`)
  }
  if (!["not-required", "review-later", "required"].includes(value.virtualization)) {
    violations.push(`${label}.virtualization is invalid`)
  }
  if (typeof value.mountPolicy !== "string" || !value.mountPolicy.trim()) {
    violations.push(`${label}.mountPolicy must describe what should remain mounted`)
  }
  if (!Array.isArray(value.sensitiveInteractions) || value.sensitiveInteractions.length === 0
    || value.sensitiveInteractions.some((item) => typeof item !== "string" || !item.trim())) {
    violations.push(`${label}.sensitiveInteractions must contain one or more non-empty descriptions`)
  }
  if (!["none", "profile-before-stable", "profile-before-cutover"].includes(value.followUp)) {
    violations.push(`${label}.followUp is invalid`)
  }
}

function validateContent(value, label) {
  if (!isRecord(value)) {
    violations.push(`${label} must be an object`)
    return
  }
  const allowed = ["layer", "canonicalTerms", "requiredStates", "visibleLabelAccessibilityName", "reviewedFailureModes"]
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) violations.push(`${label}.${field} is not a supported content field`)
  }
  if (!["glance", "read", "expert"].includes(value.layer)) violations.push(`${label}.layer is invalid`)
  for (const field of ["canonicalTerms", "requiredStates", "reviewedFailureModes"]) {
    if (!Array.isArray(value[field]) || value[field].some((item) => typeof item !== "string" || !item.trim())) {
      violations.push(`${label}.${field} must contain only non-empty strings`)
    }
  }
  if (value.visibleLabelAccessibilityName !== "match-or-prefix") {
    violations.push(`${label}.visibleLabelAccessibilityName must be match-or-prefix`)
  }
}

function sourcePath(manifestValue, label) {
  if (typeof manifestValue !== "string" || !manifestValue.startsWith("@/")) {
    violations.push(`${label} must be an @/ path`)
    return null
  }
  const resolved = path.resolve(frontendRoot, "@", manifestValue.slice(2))
  if (!resolved.startsWith(`${frontendRoot}${path.sep}`)) {
    violations.push(`${label} resolves outside frontend/`)
    return null
  }
  if (!fs.existsSync(resolved)) {
    violations.push(`${label} does not exist: ${manifestValue}`)
    return null
  }
  return resolved
}

function hasNamedExport(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`\\bexport\\s+(?:async\\s+)?(?:const|function|class|let|var)\\s+${escaped}\\b`).test(source)
}

function unwrapExpression(node) {
  while (
    ts.isAsExpression(node)
    || ts.isParenthesizedExpression(node)
    || ts.isSatisfiesExpression(node)
  ) {
    node = node.expression
  }
  return node
}

function storyMetaTitle(source, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "meta" || !declaration.initializer) continue
      const initializer = unwrapExpression(declaration.initializer)
      if (!ts.isObjectLiteralExpression(initializer)) continue
      const title = initializer.properties.find((property) =>
        ts.isPropertyAssignment(property)
        && ts.isIdentifier(property.name)
        && property.name.text === "title"
      )
      if (title && ts.isPropertyAssignment(title) && ts.isStringLiteralLike(title.initializer)) {
        return title.initializer.text
      }
    }
  }
  return null
}

function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const resolved = path.join(directory, entry.name)
    return entry.isDirectory() ? filesIn(resolved) : [resolved]
  })
}

function resolveAliasModule(moduleName, label) {
  if (typeof moduleName !== "string" || !moduleName.startsWith("@/")) {
    violations.push(`${label} must be an @/ path`)
    return null
  }
  const base = path.resolve(frontendRoot, "@", moduleName.slice(2))
  const candidates = [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    path.join(base, "index.tsx"),
    path.join(base, "index.ts"),
  ]
  const resolved = candidates.find((candidate) => fs.existsSync(candidate))
  if (!resolved || !resolved.startsWith(`${frontendRoot}${path.sep}`)) {
    violations.push(`${label} does not resolve to a frontend source file: ${moduleName}`)
    return null
  }
  return resolved
}

function sourceAlias(fileName) {
  return `@/${path.relative(path.join(frontendRoot, "@"), fileName).split(path.sep).join("/")}`
}

function sameModuleStory(fileName) {
  const storyPath = fileName.replace(/\.tsx$/, ".stories.tsx")
  return fs.existsSync(storyPath) ? storyPath : null
}

function evidencePath(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    violations.push(`${label} must be a non-empty frontend-relative or @/ path`)
    return null
  }
  const resolved = value.startsWith("@/")
    ? path.resolve(frontendRoot, "@", value.slice(2))
    : path.resolve(frontendRoot, value)
  if (!resolved.startsWith(`${frontendRoot}${path.sep}`) || !fs.existsSync(resolved)) {
    violations.push(`${label} does not exist inside frontend/: ${value}`)
    return null
  }
  return resolved
}

function validateEvidenceList(value, label, { browserOnly = false } = {}) {
  if (!Array.isArray(value) || value.length === 0) {
    violations.push(`${label} must contain one or more evidence files`)
    return
  }
  for (const [index, item] of value.entries()) {
    const resolved = evidencePath(item, `${label}[${index}]`)
    if (resolved && browserOnly && !/^tests\/.+\.spec\.ts$/.test(path.relative(frontendRoot, resolved).split(path.sep).join("/"))) {
      violations.push(`${label}[${index}] must be fixture-driven browser evidence under tests/: ${item}`)
    }
  }
}

function validateCoverage(coverage) {
  if (!isRecord(coverage)) {
    violations.push("design-system/coverage.json must be an object")
    return { runtimeCount: 0, routeCount: 0 }
  }
  if (coverage.version !== 1) violations.push("design-system coverage version must be 1")
  if (
    coverage.source?.routeRegistry !== "src/main.tsx"
    || coverage.source?.storyPolicy !== "same-module"
    || coverage.source?.formPolicy !== "same-module-story-required"
    || coverage.source?.reusablePolicy !== "story-or-owned-pattern-required"
  ) {
    violations.push("design-system coverage source policies must preserve the source-derived route, story, form, and reusable contracts")
  }
  if (
    !Array.isArray(coverage.source?.roots)
    || coverage.source.roots.length !== 2
    || !coverage.source.roots.includes("@/components")
    || !coverage.source.roots.includes("@/features")
  ) {
    violations.push("design-system coverage source.roots must be exactly @/components and @/features")
  }

  const productionModules = coverage.source?.roots?.flatMap((root) => {
    const resolved = resolveAliasModule(root, `design-system coverage source root ${root}`)
    return resolved && fs.statSync(resolved).isDirectory() ? filesIn(resolved) : []
  }) ?? []
  const productionUiModules = productionModules
    .filter((fileName) => fileName.endsWith(".tsx") && !fileName.endsWith(".stories.tsx"))
    .sort()
  const primitiveRoot = path.join(frontendRoot, "@", "components", "ui")
  const mainSource = fs.readFileSync(path.join(frontendRoot, coverage.source.routeRegistry), "utf8")
  const routeModules = new Set()
  for (const match of mainSource.matchAll(/import\((["'])(@\/[^"']+)\1\)\.then\(\(\{\s*[A-Za-z_$][\w$]*\s*:/g)) {
    const resolved = resolveAliasModule(match[2], `route registry import ${match[2]}`)
    if (resolved) routeModules.add(resolved)
  }

  const runtimeRequired = productionUiModules.filter((fileName) =>
    !fileName.startsWith(`${primitiveRoot}${path.sep}`)
    && !routeModules.has(fileName)
    && !sameModuleStory(fileName)
  )
  const routeEvidenceRequired = [...routeModules].filter((fileName) => !sameModuleStory(fileName)).sort()
  const formModules = productionUiModules.filter((fileName) => /<form(?:\s|>)/.test(fs.readFileSync(fileName, "utf8")))
  for (const fileName of formModules) {
    if (!sameModuleStory(fileName)) {
      violations.push(`${sourceAlias(fileName)} renders a production form without dedicated same-module Storybook evidence`)
    }
  }

  const runtimeEntries = Array.isArray(coverage.runtimeModules) ? coverage.runtimeModules : []
  if (!Array.isArray(coverage.runtimeModules)) violations.push("design-system coverage runtimeModules must be an array")
  const runtimeAssignments = new Map()
  for (const [index, entry] of runtimeEntries.entries()) {
    const label = `design-system coverage runtimeModules[${index}]`
    if (!isRecord(entry)) {
      violations.push(`${label} must be an object`)
      continue
    }
    const resolved = resolveAliasModule(entry.module, `${label}.module`)
    if (resolved) {
      if (runtimeAssignments.has(resolved)) violations.push(`${label}.module duplicates ${entry.module}`)
      runtimeAssignments.set(resolved, entry)
    }
    if (typeof entry.reason !== "string" || !entry.reason.trim()) {
      violations.push(`${label}.reason must explain why Storybook is not the primary evidence boundary`)
    }
    validateEvidenceList(entry.evidence, `${label}.evidence`)
  }

  const routeEntries = Array.isArray(coverage.routeEvidence) ? coverage.routeEvidence : []
  if (!Array.isArray(coverage.routeEvidence)) violations.push("design-system coverage routeEvidence must be an array")
  const routeAssignments = new Map()
  for (const [index, entry] of routeEntries.entries()) {
    const label = `design-system coverage routeEvidence[${index}]`
    if (!isRecord(entry)) {
      violations.push(`${label} must be an object`)
      continue
    }
    const resolved = resolveAliasModule(entry.module, `${label}.module`)
    if (resolved) {
      if (routeAssignments.has(resolved)) violations.push(`${label}.module duplicates ${entry.module}`)
      routeAssignments.set(resolved, entry)
    }
    validateEvidenceList(entry.evidence, `${label}.evidence`, { browserOnly: true })
  }

  for (const fileName of runtimeRequired) {
    if (!runtimeAssignments.has(fileName)) {
      violations.push(`${sourceAlias(fileName)} has no same-module story and no exact runtime evidence assignment`)
    }
  }
  for (const fileName of runtimeAssignments.keys()) {
    if (!runtimeRequired.includes(fileName)) {
      violations.push(`${sourceAlias(fileName)} has a stale runtime evidence assignment; source discovery no longer requires it`)
    }
  }
  for (const fileName of routeEvidenceRequired) {
    if (!routeAssignments.has(fileName)) {
      violations.push(`${sourceAlias(fileName)} is a route adapter without same-module presentation stories or exact browser evidence`)
    }
  }
  for (const fileName of routeAssignments.keys()) {
    if (!routeEvidenceRequired.includes(fileName)) {
      violations.push(`${sourceAlias(fileName)} has a stale route evidence assignment; source discovery no longer requires it`)
    }
  }

  return {
    runtimeCount: runtimeRequired.length,
    routeCount: routeEvidenceRequired.length,
  }
}

const manifest = readJson(manifestPath)
const authority = readJson(authorityPath)
const relationships = readJson(relationshipsPath)
const resolvedCatalog = readJson(catalogPath)
const coverage = readJson(coveragePath)
const coverageCounts = validateCoverage(coverage)

if (authority) {
  if (authority.version !== 1) violations.push("design-system authority version must be 1")
  if (authority.scope?.exclude?.some((value) => /child-app/i.test(value)) !== true) {
    violations.push("design-system authority must explicitly exclude child-app source")
  }
  const requiredDefaults = ["owner", "maturity", "distribution", "tokens", "accessibility", "dataBoundary", "responsive", "deprecation"]
  for (const field of requiredDefaults) {
    if (!(field in (authority.defaults || {}))) violations.push(`design-system authority defaults.${field} is required`)
  }
  for (const [id, override] of Object.entries(authority.overrides || {})) {
    if (override.performance !== undefined) validatePerformance(override.performance, `design-system authority overrides.${id}.performance`)
    if (override.content !== undefined) validateContent(override.content, `design-system authority overrides.${id}.content`)
  }
}

if (manifest) {
  if (manifest.version !== 4) violations.push("design-system manifest version must be 4")
  const primitiveCoverage = manifest.coverage
  if (
    !isRecord(primitiveCoverage)
    || primitiveCoverage.authority !== "design-system/coverage.json"
    || primitiveCoverage.primitiveRoot !== "@/components/ui"
    || primitiveCoverage.primitiveStoryPolicy !== "same-module-required"
    || primitiveCoverage.primitiveTier !== "element"
    || primitiveCoverage.storyTitlePrefix !== "Elements/"
  ) {
    violations.push("design-system manifest coverage must require same-module Element stories for @/components/ui")
  }
  if (!Array.isArray(manifest.patterns) || manifest.patterns.length === 0) {
    violations.push("design-system manifest must contain at least one pattern")
  } else {
    const ids = new Set()
    for (const [index, pattern] of manifest.patterns.entries()) {
      const label = `patterns[${index}]`
      if (!isRecord(pattern)) {
        violations.push(`${label} must be an object`)
        continue
      }
      if (typeof pattern.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pattern.id)) {
        violations.push(`${label}.id must be a kebab-case string`)
      } else if (ids.has(pattern.id)) {
        violations.push(`${label}.id duplicates ${pattern.id}`)
      } else ids.add(pattern.id)

      if (!Object.hasOwn(tierPrefixes, pattern.tier)) {
        violations.push(`${label}.tier must be element, block, or feature`)
      }
      const componentPath = sourcePath(pattern.module, `${label}.module`)
      if (typeof pattern.name !== "string" || !pattern.name) violations.push(`${label}.name must be a non-empty string`)
      if (typeof pattern.export !== "string" || !pattern.export) {
        violations.push(`${label}.export must be a non-empty string`)
      } else if (componentPath && !hasNamedExport(fs.readFileSync(componentPath, "utf8"), pattern.export)) {
        violations.push(`${label}.export is not exported by ${pattern.module}: ${pattern.export}`)
      }

      if (!isRecord(pattern.story)) {
        violations.push(`${label}.story must name the deterministic Storybook evidence for this reusable pattern`)
        continue
      }
      const storyPath = sourcePath(pattern.story.module, `${label}.story.module`)
      if (!Array.isArray(pattern.story.states) || pattern.story.states.length === 0) {
        violations.push(`${label}.story.states must contain one or more named story exports`)
        continue
      }
      const storySource = storyPath ? fs.readFileSync(storyPath, "utf8") : null
      if (storySource && !/\bexport\s+default\b/.test(storySource)) {
        violations.push(`${label}.story.module has no default Storybook meta export: ${pattern.story.module}`)
      }
      const storyTitle = storySource && storyPath ? storyMetaTitle(storySource, storyPath) : null
      const expectedPrefix = tierPrefixes[pattern.tier]
      if (storySource && !storyTitle) {
        violations.push(`${label}.story.module must define a static meta title: ${pattern.story.module}`)
      } else if (storyTitle && expectedPrefix && !storyTitle.startsWith(expectedPrefix)) {
        violations.push(
          `${label}.story.module title must start with ${expectedPrefix} for tier ${pattern.tier}: ${storyTitle}`
        )
      }
      for (const state of pattern.story.states) {
        if (typeof state !== "string" || !state) {
          violations.push(`${label}.story.states must contain non-empty strings`)
        } else if (storySource && !hasNamedExport(storySource, state)) {
          violations.push(`${label}.story state is not exported by ${pattern.story.module}: ${state}`)
        }
      }
    }
  }

  const allowedStoryPrefixes = [...Object.values(tierPrefixes), "Compositions/"]
  for (const storyPath of filesIn(path.join(frontendRoot, "@")).filter((fileName) => fileName.endsWith(".stories.tsx"))) {
    const title = storyMetaTitle(fs.readFileSync(storyPath, "utf8"), storyPath)
    const label = path.relative(frontendRoot, storyPath)
    if (!title) {
      violations.push(`${label} must define a static meta title`)
    } else if (!allowedStoryPrefixes.some((prefix) => title.startsWith(prefix))) {
      violations.push(`${label} title must start with ${allowedStoryPrefixes.join(", ")}: ${title}`)
    }
  }

  const primitiveRoot = path.join(frontendRoot, "@", "components", "ui")
  const primitiveModules = fs.readdirSync(primitiveRoot)
    .filter((fileName) => fileName.endsWith(".tsx") && !fileName.endsWith(".stories.tsx"))
    .sort()
  for (const fileName of primitiveModules) {
    const base = fileName.replace(/\.tsx$/, "")
    const storyPath = path.join(primitiveRoot, `${base}.stories.tsx`)
    const label = `@/components/ui/${fileName}`
    if (!fs.existsSync(storyPath)) {
      violations.push(`${label} is a production primitive without dedicated same-module Storybook evidence`)
      continue
    }
    const storySource = fs.readFileSync(storyPath, "utf8")
    const title = storyMetaTitle(storySource, storyPath)
    if (!title?.startsWith("Elements/")) {
      violations.push(`${label} story title must start with Elements/: ${title || "missing"}`)
    }
    if (![...storySource.matchAll(/^export const ([A-Za-z_$][\w$]*)/gm)].length) {
      violations.push(`${label} story must export at least one named deterministic state`)
    }
  }
}

if (relationships && resolvedCatalog) {
  violations.push(...relationshipViolations(resolvedCatalog, relationships))
}

try {
  checkDesignTokens()
} catch (error) {
  violations.push(error.message)
}

try {
  checkCatalog()
} catch (error) {
  violations.push(error.message)
}

if (violations.length) {
  console.error("Design-system manifest check failed:\n\n" + violations.map((item) => `- ${item}`).join("\n"))
  process.exit(1)
}

const performanceContracts = Object.values(authority.overrides || {}).filter((override) => override.performance).length
const primitiveCount = fs.readdirSync(path.join(frontendRoot, "@", "components", "ui"))
  .filter((fileName) => fileName.endsWith(".tsx") && !fileName.endsWith(".stories.tsx")).length
console.log(`Design-system authority check passed: ${primitiveCount} source-derived local primitives, ${manifest.patterns.length} owned shell patterns, ${coverageCounts.runtimeCount} runtime compositions, and ${coverageCounts.routeCount} route adapters resolve exact Storybook or browser evidence; ${performanceContracts} patterns have scoped performance contracts.`)
