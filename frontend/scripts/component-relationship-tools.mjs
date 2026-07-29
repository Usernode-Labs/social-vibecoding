const decisions = new Set(["keep-distinct", "extend", "supersede", "remove"])

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function relationshipViolations(catalog, relationships) {
  const violations = []
  const componentIds = new Set((catalog.components || []).map((component) => component.id))
  if (relationships.version !== 1) violations.push("relationships version must be 1")
  if (!Array.isArray(relationships.decisions)) {
    return [...violations, "relationships decisions must be an array"]
  }

  const ids = new Set()
  const groups = new Set()
  for (const [index, relationship] of relationships.decisions.entries()) {
    const label = `decisions[${index}]`
    if (!record(relationship)) {
      violations.push(`${label} must be an object`)
      continue
    }
    if (typeof relationship.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(relationship.id)) {
      violations.push(`${label}.id must be kebab-case`)
    } else if (ids.has(relationship.id)) {
      violations.push(`${label}.id duplicates ${relationship.id}`)
    } else ids.add(relationship.id)

    if (!decisions.has(relationship.decision)) {
      violations.push(`${label}.decision must be keep-distinct, extend, supersede, or remove`)
    }
    if (!Array.isArray(relationship.components) || relationship.components.length < 2) {
      violations.push(`${label}.components must contain at least two component ids`)
      continue
    }
    if (new Set(relationship.components).size !== relationship.components.length) {
      violations.push(`${label}.components must not repeat a component`)
    }
    for (const id of relationship.components) {
      if (!componentIds.has(id)) violations.push(`${label}.components references unknown component ${id}`)
    }
    const group = [...relationship.components].sort().join(":")
    if (groups.has(group)) violations.push(`${label} duplicates the reviewed component group ${group}`)
    groups.add(group)

    if (!Array.isArray(relationship.jobs)) {
      violations.push(`${label}.jobs must name each component's user job`)
    } else {
      const jobComponents = new Set()
      for (const job of relationship.jobs) {
        if (!record(job) || !relationship.components.includes(job.component)
          || typeof job.job !== "string" || !job.job.trim()) {
          violations.push(`${label}.jobs must contain a non-empty job for a reviewed component`)
          continue
        }
        jobComponents.add(job.component)
      }
      for (const id of relationship.components) {
        if (!jobComponents.has(id)) violations.push(`${label}.jobs is missing ${id}`)
      }
    }
    for (const field of ["rationale", "substitutionBoundary"]) {
      if (typeof relationship[field] !== "string" || !relationship[field].trim()) {
        violations.push(`${label}.${field} must be a non-empty string`)
      }
    }
    if (["supersede", "remove"].includes(relationship.decision)) {
      if (typeof relationship.migration !== "string" || !relationship.migration.trim()) {
        violations.push(`${label}.migration is required for ${relationship.decision}`)
      }
      if (relationship.decision === "supersede"
        && !relationship.components.includes(relationship.replacement)) {
        violations.push(`${label}.replacement must name one reviewed component`)
      }
    }
  }
  return violations
}
