import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import ts from "typescript"

const sourceExtensions = new Set([".ts", ".tsx"])
const governedImportPrefix = "@/components/"
const rawInteractiveElements = new Set(["button", "input", "select", "textarea"])
const surfaceRoles = new Set(["canvas", "paper", "print", "container", "overlay"])
const ephemeralVariant = /^(?:group-|peer-)?(?:hover|focus|focus-visible|focus-within|active)(?:\/.*)?$/

function normalize(value) {
  return value.replace(/\s+/g, " ").trim()
}

function sourceLocation(frontendRoot, fileName, sourceFile, node) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return {
    file: path.relative(frontendRoot, fileName),
    line: line + 1,
    column: character + 1,
  }
}

function finding(frontendRoot, fileName, sourceFile, node, rule, match, remediation) {
  return {
    rule,
    match: normalize(match).slice(0, 180),
    ...sourceLocation(frontendRoot, fileName, sourceFile, node),
    remediation,
  }
}

function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const resolved = path.join(directory, entry.name)
    if (entry.isDirectory()) return filesIn(resolved)
    return sourceExtensions.has(path.extname(entry.name)) ? [resolved] : []
  })
}

export function governedInterfaceFiles(frontendRoot) {
  return [path.join(frontendRoot, "@", "components"), path.join(frontendRoot, "@", "features")]
    .flatMap(filesIn)
    .filter((fileName) => !fileName.endsWith(".stories.tsx"))
    .sort()
}

function staticAttribute(opening, name, sourceFile) {
  const attribute = opening.attributes.properties.find((item) => (
    ts.isJsxAttribute(item) && item.name.getText(sourceFile) === name
  ))
  if (!attribute?.initializer) return null
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text
  const expression = attribute.initializer.expression
  if (ts.isStringLiteralLike(expression)) return expression.text
  return null
}

function classTokens(attribute, sourceFile) {
  if (!attribute?.initializer) return []
  const values = []
  const visit = (node) => {
    if (ts.isStringLiteralLike(node)) values.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(attribute.initializer)
  return values.flatMap((value) => value.split(/\s+/).filter(Boolean))
}

export function splitTailwindVariant(token) {
  const parts = []
  let depth = 0
  let start = 0
  for (let index = 0; index < token.length; index += 1) {
    const character = token[index]
    if (character === "[") depth += 1
    else if (character === "]") depth = Math.max(0, depth - 1)
    else if (character === ":" && depth === 0) {
      parts.push(token.slice(start, index))
      start = index + 1
    }
  }
  parts.push(token.slice(start))
  return { variants: parts.slice(0, -1), utility: parts.at(-1) || "" }
}

function addsPersistentSurface(token) {
  const { variants, utility } = splitTailwindVariant(token)
  if (variants.some((variant) => ephemeralVariant.test(variant))) return false
  if (["bg-transparent", "bg-inherit", "border-0", "border-transparent", "ring-0", "shadow-none"].includes(utility)) return false
  return /^(?:bg-|border(?:-|$)|ring(?:-|$)|shadow(?:-|$))/.test(utility)
}

function isMargin(token) {
  return /^(?:m|mx|my|mt|mr|mb|ml|ms|me)-/.test(splitTailwindVariant(token).utility)
}

function isArbitraryRadius(token) {
  return /^rounded(?:-[trblsexy]{1,2})?-\[/.test(splitTailwindVariant(token).utility)
}

function isDisabledOpacity(token) {
  const { variants, utility } = splitTailwindVariant(token)
  return utility.startsWith("opacity-") && variants.some((variant) => variant.includes("disabled"))
}

function jsxName(opening, sourceFile) {
  return opening.tagName.getText(sourceFile)
}

function importedGovernedComponents(sourceFile) {
  const names = new Set()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (!statement.moduleSpecifier.text.startsWith(governedImportPrefix)) continue
    const clause = statement.importClause
    if (clause?.name) names.add(clause.name.text)
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) names.add(element.name.text)
    }
  }
  return names
}

function ancestorOpening(node) {
  let current = node.parent
  if (ts.isJsxElement(current) && current.openingElement === node) current = current.parent
  while (current) {
    if (ts.isJsxElement(current)) return current.openingElement
    current = current.parent
  }
  return null
}

function hasOuterLayoutZone(opening, sourceFile) {
  let current = opening
  while (current) {
    if (staticAttribute(current, "data-layout-zone", sourceFile) === "outer") return true
    current = ancestorOpening(current)
  }
  return false
}

export function scanInterfaceSource(frontendRoot, fileName, source) {
  const tokens = JSON.parse(fs.readFileSync(path.join(frontendRoot, "design-system", "tokens.json"), "utf8"))
  if (tokens.foundation?.radius?.base?.$type !== "dimension") {
    throw new Error("design-system/tokens.json must define foundation.radius.base before interface-law scanning")
  }

  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const governedComponents = importedGovernedComponents(sourceFile)
  const findings = []
  const isPrimitiveModule = fileName.includes(`${path.sep}components${path.sep}ui${path.sep}`)

  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = jsxName(node, sourceFile)
      const surface = staticAttribute(node, "data-surface", sourceFile)

      if (surface && !surfaceRoles.has(surface)) {
        findings.push(finding(frontendRoot, fileName, sourceFile, node, "invalid-surface-role", surface, "Use canvas, paper, print, container, or overlay; status colour is ink."))
      }
      if (surface === "paper") {
        let parent = ancestorOpening(node)
        while (parent) {
          if (staticAttribute(parent, "data-surface", sourceFile) === "paper") {
            findings.push(finding(frontendRoot, fileName, sourceFile, node, "no-paper-in-paper", node.getText(sourceFile), "Keep one Paper per view and print the nested content."))
            break
          }
          parent = ancestorOpening(parent)
        }
      }
      if (
        surface === "overlay"
        && staticAttribute(node, "data-surface-persistence", sourceFile) === "persistent"
        && staticAttribute(node, "data-slot", sourceFile) !== "platform-bottom-navigation"
      ) {
        findings.push(finding(frontendRoot, fileName, sourceFile, node, "single-persistent-overlay", node.getText(sourceFile), "Only platform-bottom-navigation may persist as an Overlay."))
      }
      if (staticAttribute(node, "data-spacing-tier", sourceFile) === "macro" && !hasOuterLayoutZone(node, sourceFile)) {
        findings.push(finding(frontendRoot, fileName, sourceFile, node, "macro-spacing-outer-zone", node.getText(sourceFile), "Move macro spacing to an ancestor marked data-layout-zone=\"outer\"."))
      }

      const className = node.attributes.properties.find((item) => (
        ts.isJsxAttribute(item) && item.name.getText(sourceFile) === "className"
      ))
      const classes = classTokens(className, sourceFile)
      for (const token of classes.filter(isArbitraryRadius)) {
        findings.push(finding(frontendRoot, fileName, sourceFile, className, "radius-ladder-only", token, "Use the radius ladder derived from foundation.radius.base."))
      }
      if (governedComponents.has(name)) {
        for (const token of classes.filter(isMargin)) {
          findings.push(finding(frontendRoot, fileName, sourceFile, className, "no-caller-margin", token, "Let the parent own separation through gap."))
        }
        for (const token of classes.filter(addsPersistentSurface)) {
          findings.push(finding(frontendRoot, fileName, sourceFile, className, "caller-surface-direction", token, "Remove caller-added persistent surface treatment or promote a repeated recipe to an owned variant."))
        }
      }

      if (!isPrimitiveModule && rawInteractiveElements.has(name)) {
        findings.push(finding(frontendRoot, fileName, sourceFile, node, "use-owned-primitive", `<${name}>`, `Use the owned ${name} primitive instead of a raw element.`))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (isPrimitiveModule) {
    const visitDisabledOpacity = (node) => {
      if (ts.isStringLiteralLike(node)) {
        for (const token of node.text.split(/\s+/).filter(isDisabledOpacity)) {
          findings.push(finding(frontendRoot, fileName, sourceFile, node, "no-disabled-element-opacity", token, "Use semantic disabled foreground and fill tokens; do not fade the whole element."))
        }
      }
      ts.forEachChild(node, visitDisabledOpacity)
    }
    visitDisabledOpacity(sourceFile)
  }
  return findings
}

export function scanInterfaceFiles(frontendRoot, fileNames, sourceOverrides = new Map()) {
  return fileNames.flatMap((fileName) => scanInterfaceSource(
    frontendRoot,
    fileName,
    sourceOverrides.get(fileName) ?? fs.readFileSync(fileName, "utf8"),
  )).sort((left, right) => (
    left.file.localeCompare(right.file)
    || left.line - right.line
    || left.column - right.column
    || left.rule.localeCompare(right.rule)
  ))
}

export function findingKey(item) {
  return `${item.rule}\u0000${item.file}\u0000${item.match}`
}

export function evaluateInterfaceLawRatchet(findings, accepted) {
  const summarize = (items) => {
    const summary = new Map()
    for (const item of items) {
      const key = findingKey(item)
      const previous = summary.get(key)
      summary.set(key, { ...item, count: (previous?.count || 0) + (item.count || 1) })
    }
    return summary
  }
  const current = summarize(findings)
  const baseline = summarize(accepted)
  return {
    added: [...current.entries()].filter(([key, item]) => item.count > (baseline.get(key)?.count || 0)).map(([, item]) => ({
      ...item,
      count: item.count - (baseline.get(findingKey(item))?.count || 0),
    })),
    resolved: [...baseline.entries()].filter(([key, item]) => item.count > (current.get(key)?.count || 0)).map(([, item]) => ({
      ...item,
      count: item.count - (current.get(findingKey(item))?.count || 0),
    })),
  }
}

export function stagedInterfaceSources(frontendRoot) {
  const repoRoot = path.resolve(frontendRoot, "..")
  const relativeFiles = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim().split("\n").filter((file) => /^frontend\/@\/(?:components|features)\/.+\.(?:ts|tsx)$/.test(file) && !file.endsWith(".stories.tsx"))
  const files = relativeFiles.map((file) => path.join(repoRoot, file))
  const sources = new Map(files.map((fileName, index) => [
    fileName,
    execFileSync("git", ["show", `:${relativeFiles[index]}`], { cwd: repoRoot, encoding: "utf8" }),
  ]))
  return { files, sources }
}
