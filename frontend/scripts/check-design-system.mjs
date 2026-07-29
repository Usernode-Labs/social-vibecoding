import fs from "node:fs"
import path from "node:path"
import { checkCatalog } from "./design-system-catalog-tools.mjs"
import { checkDesignTokens } from "./design-token-tools.mjs"

const frontendRoot = process.cwd()
const manifestPath = path.join(frontendRoot, "design-system.manifest.json")
const authorityPath = path.join(frontendRoot, "design-system", "authority.json")
const violations = []

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

const manifest = readJson(manifestPath)
const authority = readJson(authorityPath)

if (authority) {
  if (authority.version !== 1) violations.push("design-system authority version must be 1")
  if (authority.scope?.exclude?.some((value) => /child-app/i.test(value)) !== true) {
    violations.push("design-system authority must explicitly exclude child-app source")
  }
  const requiredDefaults = ["owner", "maturity", "distribution", "tokens", "accessibility", "dataBoundary", "responsive", "deprecation"]
  for (const field of requiredDefaults) {
    if (!(field in (authority.defaults || {}))) violations.push(`design-system authority defaults.${field} is required`)
  }
}

if (manifest) {
  if (manifest.version !== 1) violations.push("design-system manifest version must be 1")
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
      for (const state of pattern.story.states) {
        if (typeof state !== "string" || !state) {
          violations.push(`${label}.story.states must contain non-empty strings`)
        } else if (storySource && !hasNamedExport(storySource, state)) {
          violations.push(`${label}.story state is not exported by ${pattern.story.module}: ${state}`)
        }
      }
    }
  }
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

console.log(`Design-system authority check passed: ${manifest.patterns.length} shell patterns resolve ownership, maturity, variants, tokens, accessibility, data boundaries, deprecation and Storybook evidence.`)
