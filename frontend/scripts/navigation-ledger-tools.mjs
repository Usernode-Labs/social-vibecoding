import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import ts from "typescript"

const sourceHead = "a09473723e988cf309ac12974e45efd8eb749528"
const repoRoot = path.resolve(process.cwd(), "..")
const ledgerPath = path.join(process.cwd(), "design-system", "navigation-ledger.json")
const wrapperKinds = new Map([
  ["Button", "button"],
  ["AttachmentTrigger", "attachment-trigger"],
  ["Badge", "badge"],
])

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" })
}

function tagName(node) {
  return ts.isIdentifier(node.tagName) ? node.tagName.text : node.tagName.getText()
}

function attribute(opening, name) {
  return opening.attributes.properties.find((property) =>
    ts.isJsxAttribute(property)
    && ts.isIdentifier(property.name)
    && property.name.text === name
  )
}

function attributeSource(sourceFile, opening, name) {
  const found = attribute(opening, name)
  if (!found) return null
  if (!found.initializer) return "true"
  if (ts.isStringLiteral(found.initializer)) return JSON.stringify(found.initializer.text)
  if (ts.isJsxExpression(found.initializer)) {
    return found.initializer.expression?.getText(sourceFile) || "true"
  }
  return found.initializer.getText(sourceFile)
}

function importedLinkNames(sourceFile) {
  const names = new Set()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== "react-router-dom") continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      if ((element.propertyName?.text || element.name.text) === "Link") names.add(element.name.text)
    }
  }
  return names
}

function enclosingWrapper(candidate) {
  let current = candidate.parent
  let renderAttribute = null
  let conditional = null
  while (current && !ts.isSourceFile(current)) {
    if (
      !renderAttribute
      && ts.isJsxAttribute(current)
      && ts.isIdentifier(current.name)
      && current.name.text === "render"
    ) renderAttribute = current
    if (!conditional && ts.isConditionalExpression(current)) conditional = current
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) {
      const opening = ts.isJsxElement(current) ? current.openingElement : current
      const name = tagName(opening)
      if (wrapperKinds.has(name)) {
        return { opening, name, kind: wrapperKinds.get(name), renderAttribute, conditional }
      }
    }
    current = current.parent
  }
  return { opening: null, name: null, kind: "plain", renderAttribute, conditional }
}

function classifyDisabled(sourceFile, wrapper) {
  if (!wrapper.opening) return { provenance: "not-applicable", expression: null }
  const expression = attributeSource(sourceFile, wrapper.opening, "disabled")
  if (expression === null) return { provenance: "none", expression: null }
  if (wrapper.conditional && wrapper.renderAttribute) {
    return { provenance: "link-absent-when-wrapper-disabled", expression }
  }
  return { provenance: "wrapper-disabled", expression }
}

function rowFor(sourceFile, file, candidate, semanticElement) {
  const opening = ts.isJsxElement(candidate) ? candidate.openingElement : candidate
  const wrapper = enclosingWrapper(candidate)
  const disabled = classifyDisabled(sourceFile, wrapper)
  const wrapperKind = wrapper.kind === "button" && wrapper.conditional && wrapper.renderAttribute
    ? "conditional-button"
    : wrapper.kind
  const position = sourceFile.getLineAndCharacterOfPosition(candidate.getStart(sourceFile))
  const destinationAttribute = semanticElement === "link" ? "to" : "href"
  return {
    id: `${file}:${position.line + 1}:${position.character + 1}`,
    file,
    line: position.line + 1,
    column: position.character + 1,
    semanticElement,
    destination: attributeSource(sourceFile, opening, destinationAttribute),
    accessibleName: attributeSource(sourceFile, opening, "aria-label"),
    target: attributeSource(sourceFile, opening, "target"),
    download: attribute(opening, "download") !== undefined,
    wrapper: wrapperKind,
    wrapperTag: wrapper.name,
    renderMechanism: wrapper.renderAttribute ? "render-prop" : "child",
    renderCondition: wrapper.conditional?.condition.getText(sourceFile) || null,
    disabledProvenance: disabled.provenance,
    disabledExpression: disabled.expression,
  }
}

function sourceFilesAtHead() {
  return git(["ls-tree", "-r", "--name-only", sourceHead, "--", "frontend/@"])
    .split("\n")
    .filter((file) => file.endsWith(".tsx") && !file.endsWith(".stories.tsx"))
}

export function buildNavigationLedger() {
  const rows = []
  for (const file of sourceFilesAtHead()) {
    const source = git(["show", `${sourceHead}:${file}`])
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const links = importedLinkNames(sourceFile)
    function visit(node) {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node
        const name = tagName(opening)
        if (name === "a") rows.push(rowFor(sourceFile, file, node, "anchor"))
        else if (links.has(name)) rows.push(rowFor(sourceFile, file, node, "link"))
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  rows.sort((left, right) =>
    left.file.localeCompare(right.file)
    || left.line - right.line
    || left.column - right.column
  )
  const countBy = (field) => Object.fromEntries(
    [...new Set(rows.map((row) => row[field]))]
      .sort()
      .map((value) => [value, rows.filter((row) => row[field] === value).length])
  )
  return {
    version: 1,
    scope: "Production JSX navigation expressions under frontend/@ at the pinned pre-pilot source head.",
    sourceHead,
    generatedBy: "scripts/build-navigation-ledger.mjs",
    summary: {
      total: rows.length,
      semanticElements: countBy("semanticElement"),
      wrappers: countBy("wrapper"),
      disabledProvenance: countBy("disabledProvenance"),
    },
    rows,
  }
}

export function writeNavigationLedger() {
  fs.writeFileSync(ledgerPath, `${JSON.stringify(buildNavigationLedger(), null, 2)}\n`)
}

export function checkNavigationLedger() {
  const expected = `${JSON.stringify(buildNavigationLedger(), null, 2)}\n`
  const actual = fs.readFileSync(ledgerPath, "utf8")
  if (actual !== expected) {
    throw new Error("design-system/navigation-ledger.json is stale; run npm run build:navigation-ledger")
  }
}
