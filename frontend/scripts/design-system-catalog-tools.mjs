import fs from "node:fs"
import path from "node:path"

const frontendRoot = process.cwd()
const manifestPath = path.join(frontendRoot, "design-system.manifest.json")
const authorityPath = path.join(frontendRoot, "design-system", "authority.json")
const catalogPath = path.join(frontendRoot, "design-system", "catalog.json")

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function mergeContract(defaults, override = {}) {
  return {
    ...defaults,
    ...override,
    accessibility: {
      ...defaults.accessibility,
      ...(override.accessibility || {}),
    },
    dataBoundary: {
      ...defaults.dataBoundary,
      ...(override.dataBoundary || {}),
    },
  }
}

export function renderCatalog() {
  const manifest = readJson(manifestPath)
  const authority = readJson(authorityPath)
  const knownIds = new Set(manifest.patterns.map((pattern) => pattern.id))
  for (const id of Object.keys(authority.overrides)) {
    if (!knownIds.has(id)) throw new Error(`authority override references unknown pattern: ${id}`)
  }
  const components = manifest.patterns.map((pattern) => ({
    id: pattern.id,
    name: pattern.name,
    module: pattern.module,
    export: pattern.export,
    owner: mergeContract(authority.defaults, authority.overrides[pattern.id]).owner,
    maturity: mergeContract(authority.defaults, authority.overrides[pattern.id]).maturity,
    distribution: mergeContract(authority.defaults, authority.overrides[pattern.id]).distribution,
    variants: pattern.story.states,
    tokens: mergeContract(authority.defaults, authority.overrides[pattern.id]).tokens,
    accessibility: mergeContract(authority.defaults, authority.overrides[pattern.id]).accessibility,
    dataBoundary: mergeContract(authority.defaults, authority.overrides[pattern.id]).dataBoundary,
    responsive: mergeContract(authority.defaults, authority.overrides[pattern.id]).responsive,
    deprecation: mergeContract(authority.defaults, authority.overrides[pattern.id]).deprecation,
    evidence: {
      story: pattern.story.module,
      states: pattern.story.states,
    },
  }))
  return JSON.stringify({
    $schema: "./catalog.schema.json",
    generatedFrom: [
      "design-system.manifest.json",
      "design-system/authority.json",
    ],
    scope: authority.scope,
    authority: authority.authority,
    components,
  }, null, 2) + "\n"
}

export function writeCatalog() {
  fs.writeFileSync(catalogPath, renderCatalog())
}

export function checkCatalog() {
  const expected = renderCatalog()
  const actual = fs.existsSync(catalogPath) ? fs.readFileSync(catalogPath, "utf8") : ""
  if (actual !== expected) {
    throw new Error("design-system/catalog.json is stale. Run npm run build:catalog.")
  }
}
