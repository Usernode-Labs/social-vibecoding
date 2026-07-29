import fs from "node:fs"
import path from "node:path"
import ts from "typescript"

const frontendRoot = process.cwd()
const sourceRoot = path.join(frontendRoot, "@")
const today = new Date().toISOString().slice(0, 10)

function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const resolved = path.join(directory, entry.name)
    if (entry.isDirectory()) return filesIn(resolved)
    return entry.name.endsWith(".tsx") && !entry.name.endsWith(".stories.tsx") ? [resolved] : []
  })
}

function staticValue(node) {
  if (!node) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isJsxExpression(node) && node.expression) return staticValue(node.expression)
  return null
}

function attributeValue(opening, name) {
  const attribute = opening.attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.text === name)
  return attribute ? staticValue(attribute.initializer) : null
}

function directVisibleText(node) {
  const children = ts.isJsxElement(node) || ts.isJsxFragment(node) ? node.children : []
  return children.flatMap((child) => {
    if (ts.isJsxText(child)) return [child.text]
    const value = staticValue(child)
    return value === null ? [] : [value]
  }).join(" ").replace(/\s+/g, " ").trim()
}

function tagName(node) {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) ? node.openingElement.tagName.getText() : ""
}

function hasInteractiveAncestor(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isJsxElement(current) && /^(Button|a|Link|SidebarMenuButton)$/.test(tagName(current))) return true
  }
  return false
}

function location(sourceFile, node) {
  const point = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return { line: point.line + 1, column: point.character + 1 }
}

function normalize(value) {
  return value.replace(/\s+/g, " ").trim().toLowerCase()
}

function isInProgress(value) {
  return /^(?:Loading|Saving|Creating|Checking|Opening|Submitting|Updating|Retrying|Sending|Stopping|Pausing|Resuming|Archiving|Proposing|Generating|Freeing|Linking|Recording|Refreshing|Uploading)(?:\s+[\w-]+)*[.…]{1,3}$/.test(value.trim())
}

export function checkSource(source, file = "@/fixture.tsx") {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const violations = []
  const add = (rule, node, match, remediation) => violations.push({ rule, file, match, remediation, ...location(sourceFile, node) })

  const visit = (node) => {
    if (ts.isJsxElement(node)) {
      const opening = node.openingElement
      const elementName = tagName(node)
      const visible = directVisibleText(node)
      const ariaLabel = attributeValue(opening, "aria-label")

      if (/^(Button|a|Link|SidebarMenuButton)$/.test(elementName) && ariaLabel && visible) {
        const visibleName = normalize(visible)
        const accessibleName = normalize(ariaLabel)
        if (!(accessibleName === visibleName || accessibleName.startsWith(`${visibleName} `))) {
          add("visible-label-accessible-name", opening, `${ariaLabel} <> ${visible}`, "Make the static accessible name identical to the visible label, or begin with it.")
        }
      }

      if (elementName === "Button" && visible && /(?:…|\.\.\.)/.test(visible) && !isInProgress(visible)) {
        add("button-ellipsis", node, visible, "Reserve an ellipsis for a named in-progress button state.")
      }

      const href = attributeValue(opening, "href")
      if (href?.includes("/notifications") && normalize(visible) === "notifications") {
        add("activity-destination", opening, "Notifications -> /notifications", "Name the product destination Activity; the existing /notifications URL remains a compatibility detail.")
      }
    }

    if (ts.isObjectLiteralExpression(node)) {
      const label = node.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(sourceFile).replace(/["']/g, "") === "label")
      const href = node.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(sourceFile).replace(/["']/g, "") === "href")
      if (label && href && staticValue(label.initializer)?.toLowerCase() === "notifications" && staticValue(href.initializer)?.includes("/notifications")) {
        add("activity-destination", label, "Notifications -> /notifications", "Name the product destination Activity; the existing /notifications URL remains a compatibility detail.")
      }
    }

    if (ts.isJsxText(node) || ts.isJsxAttribute(node)) {
      const value = ts.isJsxText(node) ? node.text.replace(/\s+/g, " ").trim() : staticValue(node.initializer)
      if (value) {
        if (/\b(?:dapp|Dapp|DApp|DApps)\b/.test(value)) {
          add("dapp-casing", node, value, "Use dApp or dApps in shell-facing copy.")
        }
        if (/\b(?:please|just|simply|easy|amazing|seamless)\b/i.test(value)) {
          add("banned-filler", node, value, "Remove filler; state the action or outcome directly.")
        }
        if (/\blegacy\b/i.test(value) && !file.includes("/features/dev/")) {
          add("migration-visible-copy", node, value, "Do not expose migration or legacy-shell implementation wording to users.")
        }
        if (/^(?:Open |Back to |Continue in |App )?Dev\b/.test(value) && hasInteractiveAncestor(node) && !file.includes("/features/dev/") && !file.includes("/features/admin/")) {
          add("dev-improve", node, value, "Use Improve for a customer-facing contribution action; Dev remains for Expert contexts and URLs.")
        }
      }
    }

    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return violations
}

function run() {
  const schemaPath = path.join(frontendRoot, "design-system", "content-contract.schema.json")
  const authorityPath = path.join(frontendRoot, "design-system", "authority.json")
  const ledgerPath = path.join(frontendRoot, "design-system", "content-exceptions.json")
  const errors = []
  let authority
  let ledger
  try { authority = JSON.parse(fs.readFileSync(authorityPath, "utf8")) } catch (error) { errors.push(`authority.json is invalid: ${error.message}`) }
  try { ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) } catch (error) { errors.push(`content-exceptions.json is invalid: ${error.message}`) }
  try {
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"))
    if (!Array.isArray(schema.required) || !schema.required.includes("layer")) errors.push("content contract schema is missing required contract fields")
  } catch (error) { errors.push(`content-contract.schema.json is invalid: ${error.message}`) }

  for (const [id, override] of Object.entries(authority?.overrides || {})) {
    if (!override.content) continue
    const content = override.content
    if (!["glance", "read", "expert"].includes(content.layer)) errors.push(`${id} has an invalid content layer`)
    for (const key of ["canonicalTerms", "requiredStates", "reviewedFailureModes"]) {
      if (!Array.isArray(content[key]) || content[key].some((value) => typeof value !== "string" || !value.trim())) errors.push(`${id}.${key} must be a string array`)
    }
    if (content.visibleLabelAccessibilityName !== "match-or-prefix") errors.push(`${id} must use match-or-prefix accessible names`)
  }

  const findings = filesIn(sourceRoot).flatMap((fileName) => checkSource(fs.readFileSync(fileName, "utf8"), `@/${path.relative(sourceRoot, fileName)}`))
  const used = new Map()
  for (const finding of findings) {
    const entry = ledger?.content?.find((candidate) => candidate.rule === finding.rule && candidate.file === finding.file && candidate.matches.includes(finding.match))
    if (!entry || !entry.owner || !entry.reason || !entry.expires || entry.expires < today) {
      errors.push(`${finding.file}:${finding.line}:${finding.column} ${finding.rule} (${finding.match}) — ${finding.remediation}`)
      continue
    }
    const key = `${entry.rule}:${entry.file}:${entry.matches.join("|")}`
    used.set(key, (used.get(key) || 0) + 1)
  }
  for (const entry of ledger?.content || []) {
    const key = `${entry.rule}:${entry.file}:${entry.matches.join("|")}`
    if ((used.get(key) || 0) !== entry.count) errors.push(`stale-content-exception ${entry.file} ${entry.rule}: expected ${entry.count}, found ${used.get(key) || 0}`)
  }

  if (errors.length) {
    console.error(`Content authority check failed:\n\n${errors.map((error) => `- ${error}`).join("\n")}`)
    process.exit(1)
  }
  console.log(`Content authority check passed: ${findings.length} scoped finding(s) accounted for by ${ledger?.content?.length || 0} exact, expiring inventory exception(s).`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run()

function fileURLToPath(url) {
  return new URL(url).pathname
}
