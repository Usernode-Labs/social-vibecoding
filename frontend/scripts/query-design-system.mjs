import fs from "node:fs"
import path from "node:path"

const frontendRoot = process.cwd()
const query = process.argv.slice(2).join(" ").trim().toLowerCase()
if (!query) {
  console.error("Usage: npm run query:design-system -- <component name, id, variant, or job>")
  process.exit(1)
}

const catalog = JSON.parse(fs.readFileSync(path.join(frontendRoot, "design-system", "catalog.json"), "utf8"))
const matches = catalog.components.filter((component) => {
  const searchable = [
    component.id,
    component.name,
    component.module,
    ...component.variants,
    component.dataBoundary.kind,
    component.dataBoundary.contract,
    component.performance ? JSON.stringify(component.performance) : "",
  ].join(" ").toLowerCase()
  return query.split(/\s+/).every((term) => searchable.includes(term))
})

console.log(JSON.stringify({
  query,
  count: matches.length,
  components: matches.map((component) => ({
    id: component.id,
    name: component.name,
    module: component.module,
    owner: component.owner,
    maturity: component.maturity,
    distribution: component.distribution,
    variants: component.variants,
    tokens: component.tokens,
    accessibility: component.accessibility,
    dataBoundary: component.dataBoundary,
    performance: component.performance ?? null,
    responsive: component.responsive,
    deprecation: component.deprecation,
    evidence: component.evidence,
  })),
}, null, 2))
