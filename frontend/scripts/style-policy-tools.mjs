import fs from "node:fs"
import path from "node:path"
import ts from "typescript"

const arbitraryUtility = /^(?:[a-z-]+:)*(?:w|h|min-w|max-w|min-h|max-h|size|grid-cols|grid-rows|inset|inset-x|inset-y|top|right|bottom|left|translate-x|translate-y|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|rounded|text|leading|tracking|z)-\[[^\]]+\]$/
const rawPalette = /^(?:[a-z-]+:)*(?:bg|text|border|ring|fill|stroke)-(?:white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?(?:\/\d+)?$/
const manualDarkColor = /^dark:(?:[a-z-]+:)*(?:bg|text|border|ring|fill|stroke)-/
const rawColor = /(?:#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch)\s*\()/gi

function normalize(value) {
  return value.replace(/\s+/g, " ").trim()
}

function location(frontendRoot, fileName, sourceFile, node) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return {
    file: path.relative(frontendRoot, fileName),
    line: line + 1,
    column: character + 1,
  }
}

function addTokenViolations(violations, frontendRoot, fileName, sourceFile, node, value) {
  for (const token of value.split(/\s+/).filter(Boolean)) {
    const at = location(frontendRoot, fileName, sourceFile, node)
    if (/^space-[xy]-/.test(token)) {
      violations.push({ rule: "no-space-utilities", match: token, ...at, remediation: "Use flex/grid with gap-*." })
    }
    if (arbitraryUtility.test(token)) {
      violations.push({ rule: "no-arbitrary-utilities", match: token, ...at, remediation: "Use a canonical utility, named variant or semantic token." })
    }
    if (rawPalette.test(token)) {
      violations.push({ rule: "no-raw-palette", match: token, ...at, remediation: "Use a semantic shadcn token such as bg-background or text-muted-foreground." })
    }
    if (manualDarkColor.test(token)) {
      violations.push({ rule: "no-manual-dark-colors", match: token, ...at, remediation: "Put mode differences in canonical tokens instead of dark: color utilities." })
    }
  }
}

export function scanStyleFiles(frontendRoot, fileNames) {
  const violations = []
  for (const fileName of fileNames) {
    const source = fs.readFileSync(fileName, "utf8")
    const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = (node) => {
      if (ts.isStringLiteralLike(node)) {
        addTokenViolations(violations, frontendRoot, fileName, sourceFile, node, node.text)
        for (const match of node.text.matchAll(rawColor)) {
          violations.push({
            rule: "no-raw-colors",
            match: match[0],
            ...location(frontendRoot, fileName, sourceFile, node),
            remediation: "Use a semantic token from design-system/tokens.json.",
          })
        }
      }
      if (ts.isJsxAttribute(node) && node.name.getText(sourceFile) === "style") {
        violations.push({
          rule: "no-inline-style",
          match: normalize(node.getText(sourceFile)),
          ...location(frontendRoot, fileName, sourceFile, node),
          remediation: "Use a named component variant or request a reviewed, time-bounded exception.",
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return violations
}

export function governedStyleFiles(frontendRoot) {
  const roots = [
    path.join(frontendRoot, "@", "components"),
    path.join(frontendRoot, "@", "features"),
  ]
  const files = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fileName = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(fileName)
      else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) files.push(fileName)
    }
  }
  for (const root of roots) visit(root)
  return files.sort()
}

export function applyStyleExceptions(frontendRoot, violations) {
  const ledger = JSON.parse(fs.readFileSync(path.join(frontendRoot, "design-system", "exceptions.json"), "utf8"))
  const today = new Date().toISOString().slice(0, 10)
  const remaining = []
  const used = new Map()
  for (const violation of violations) {
    const exception = ledger.style.find((entry) =>
      entry.rule === violation.rule
      && entry.file === violation.file
      && entry.matches.includes(violation.match)
    )
    if (!exception) {
      remaining.push(violation)
      continue
    }
    if (!exception.owner || !exception.reason || !exception.expires) {
      remaining.push({ ...violation, remediation: "Exception is missing owner, reason or expiry." })
      continue
    }
    if (exception.expires < today) {
      remaining.push({ ...violation, remediation: `Exception expired on ${exception.expires}.` })
      continue
    }
    const key = `${exception.rule}:${exception.file}`
    used.set(key, (used.get(key) || 0) + 1)
  }
  for (const entry of ledger.style) {
    const key = `${entry.rule}:${entry.file}`
    const actual = used.get(key) || 0
    if (actual !== entry.count) {
      remaining.push({
        rule: "stale-exception",
        file: entry.file,
        line: 1,
        column: 1,
        match: entry.matches.join(", "),
        remediation: `Expected exception count ${entry.count}, found ${actual}. Remove or update the ledger entry.`,
      })
    }
  }
  return remaining
}

export function formatStyleViolation(violation) {
  return `${violation.file}:${violation.line}:${violation.column} ${violation.rule} (${violation.match}) — ${violation.remediation}`
}
