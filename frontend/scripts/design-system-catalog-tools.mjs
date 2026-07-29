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
  const components = manifest.patterns.map((pattern) => {
    const contract = mergeContract(authority.defaults, authority.overrides[pattern.id])
    return {
      id: pattern.id,
      name: pattern.name,
      module: pattern.module,
      export: pattern.export,
      owner: contract.owner,
      maturity: contract.maturity,
      distribution: contract.distribution,
      variants: pattern.story.states,
      tokens: contract.tokens,
      accessibility: contract.accessibility,
      dataBoundary: contract.dataBoundary,
      responsive: contract.responsive,
      deprecation: contract.deprecation,
      ...(contract.performance ? { performance: contract.performance } : {}),
      evidence: {
        story: pattern.story.module,
        states: pattern.story.states,
      },
    }
  })
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
