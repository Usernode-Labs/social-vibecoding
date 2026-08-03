import fs from "node:fs"
import path from "node:path"

const frontendRoot = process.cwd()
const related = process.argv.includes("--related")
const query = process.argv.slice(2).filter((value) => value !== "--related").join(" ").trim().toLowerCase()
if (!query) {
  console.error("Usage: npm run query:design-system -- [--related] <component name, id, variant, or job>")
  process.exit(1)
}

const catalog = JSON.parse(fs.readFileSync(path.join(frontendRoot, "design-system", "catalog.json"), "utf8"))
const relationships = JSON.parse(fs.readFileSync(path.join(frontendRoot, "design-system", "relationships.json"), "utf8"))
const terms = query.split(/\s+/)
const matches = catalog.components.filter((component) => {
  const searchable = [
    component.id,
    component.name,
    component.tier,
    component.module,
    ...(component.exports || [component.export]),
    ...component.variants,
    component.dataBoundary.kind,
    component.dataBoundary.contract,
    component.performance ? JSON.stringify(component.performance) : "",
  ].join(" ").toLowerCase()
  return terms.every((term) => searchable.includes(term))
})

const summarize = (component) => ({
    id: component.id,
    name: component.name,
    tier: component.tier,
    module: component.module,
    exports: component.exports || [component.export],
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
  })

if (related) {
  const relatedDecisions = relationships.decisions.filter((decision) => {
    const searchable = JSON.stringify(decision).toLowerCase()
    return terms.every((term) => searchable.includes(term))
  })
  const componentIds = new Set(relatedDecisions.flatMap((decision) => decision.components))
  console.log(JSON.stringify({
    query,
    mode: "relationships",
    count: relatedDecisions.length,
    decisions: relatedDecisions,
    components: catalog.components.filter((component) => componentIds.has(component.id)).map(summarize),
  }, null, 2))
} else {
  console.log(JSON.stringify({
    query,
    mode: "components",
    count: matches.length,
    components: matches.map(summarize),
  }, null, 2))
}
