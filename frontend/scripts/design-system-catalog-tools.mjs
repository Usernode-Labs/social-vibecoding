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

function primitiveName(fileName) {
  return fileName
    .replace(/\.tsx$/, "")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")
}

function storyStates(source) {
  return [...source.matchAll(/^export const ([A-Za-z_$][\w$]*)/gm)]
    .map((match) => match[1])
}

export function namedExports(source) {
  const exports = new Set()
  for (const match of source.matchAll(/\bexport\s+(?:async\s+)?(?:const|function|class|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    exports.add(match[1])
  }
  for (const match of source.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    for (const item of match[1].split(",")) {
      const name = item.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) exports.add(name)
    }
  }
  return [...exports].sort()
}

function renderPrimitiveCatalog(manifest, authority) {
  const relativeRoot = manifest.coverage.primitiveRoot.replace(/^@\//, "")
  const primitiveRoot = path.join(frontendRoot, "@", relativeRoot)
  return fs.readdirSync(primitiveRoot)
    .filter((fileName) => fileName.endsWith(".tsx") && !fileName.endsWith(".stories.tsx"))
    .sort()
    .map((fileName) => {
      const base = fileName.replace(/\.tsx$/, "")
      const name = primitiveName(fileName)
      const storyFile = `${base}.stories.tsx`
      const storySource = fs.readFileSync(path.join(primitiveRoot, storyFile), "utf8")
      const source = fs.readFileSync(path.join(primitiveRoot, fileName), "utf8")
      const exports = namedExports(source)
      const contract = mergeContract(authority.defaults, {
        maturity: "stable",
        dataBoundary: {
          kind: "props-only",
          contract: "The official local primitive receives presentation and interaction props only; routes and adapters retain application data, persistence, transport, and authorization ownership.",
        },
        accessibility: {
          evidence: `Dedicated ${name} Storybook states plus the styled Storybook accessibility gate.`,
        },
      })
      return {
        id: `primitive-${base}`,
        name,
        tier: manifest.coverage.primitiveTier,
        module: `@/components/ui/${fileName}`,
        export: name,
        exports,
        owner: contract.owner,
        maturity: contract.maturity,
        distribution: contract.distribution,
        variants: storyStates(storySource),
        tokens: contract.tokens,
        accessibility: contract.accessibility,
        dataBoundary: contract.dataBoundary,
        responsive: contract.responsive,
        deprecation: contract.deprecation,
        evidence: {
          story: `@/components/ui/${storyFile}`,
          states: storyStates(storySource),
        },
      }
    })
}

export function renderCatalog() {
  const manifest = readJson(manifestPath)
  const authority = readJson(authorityPath)
  const knownIds = new Set(manifest.patterns.map((pattern) => pattern.id))
  for (const id of Object.keys(authority.overrides)) {
    if (!knownIds.has(id)) throw new Error(`authority override references unknown pattern: ${id}`)
  }
  const patterns = manifest.patterns.map((pattern) => {
    const contract = mergeContract(authority.defaults, authority.overrides[pattern.id])
    const source = fs.readFileSync(path.join(frontendRoot, pattern.module), "utf8")
    const exports = namedExports(source)
    return {
      id: pattern.id,
      name: pattern.name,
      tier: pattern.tier,
      module: pattern.module,
      export: pattern.export,
      exports,
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
      ...(contract.content ? { content: contract.content } : {}),
      evidence: {
        story: pattern.story.module,
        states: pattern.story.states,
      },
    }
  })
  const components = [...renderPrimitiveCatalog(manifest, authority), ...patterns]
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
