import fs from "node:fs"
import path from "node:path"
import ts from "typescript"

const frontendRoot = process.cwd()
const presentationRoots = [path.join(frontendRoot, "@", "components"), path.join(frontendRoot, "@", "features")]
const sourceExtensions = new Set([".ts", ".tsx"])
const reportJson = process.argv.includes("--report-json")
const violations = []

function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const resolved = path.join(directory, entry.name)
    if (entry.isDirectory()) return filesIn(resolved)
    return sourceExtensions.has(path.extname(entry.name)) ? [resolved] : []
  })
}

function sourceLocation(fileName, sourceFile, node) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return {
    file: path.relative(frontendRoot, fileName),
    line: line + 1,
    column: character + 1,
  }
}

function add(rule, remediation, fileName, sourceFile, node) {
  violations.push({
    rule,
    match: node.getText(sourceFile).replace(/\s+/g, " ").slice(0, 180),
    ...sourceLocation(fileName, sourceFile, node),
    remediation,
  })
}

for (const root of presentationRoots) {
  for (const fileName of filesIn(root)) {
    if (fileName.includes(`${path.sep}components${path.sep}ui${path.sep}`) || fileName.endsWith(".stories.tsx")) continue
    const source = fs.readFileSync(fileName, "utf8")
    const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)

    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
        add("no-direct-fetch", "Move endpoint access to an owned @/lib adapter.", fileName, sourceFile, node)
      }

      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.includes("public/js")) {
        add("no-legacy-imports", "Adapt the legacy contract in @/lib instead of importing implementation.", fileName, sourceFile, node)
      }

      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && ["WebSocket", "EventSource"].includes(node.expression.text)) {
        add("no-direct-stream-client", "Own streaming and reconnection in @/lib.", fileName, sourceFile, node)
      }

      if (ts.isPropertyAccessExpression(node)) {
        const text = node.getText(sourceFile)
        if (/^(?:window\.)?(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem|clear)$/.test(text)) {
          add("no-direct-browser-storage", "Use an owned preference or persistence adapter in @/lib.", fileName, sourceFile, node)
        }
        if (/^(?:window\.)?(?:Usernode|usernode|__usernodeResolve)\b/.test(text)) {
          add("no-direct-native-global", "Use @/lib/native-bridge and capability discovery.", fileName, sourceFile, node)
        }
        if (/^navigator\.serviceWorker\b/.test(text)) {
          add("no-direct-service-worker", "Use the shell service-worker adapter and preserve its versioned contract.", fileName, sourceFile, node)
        }
      }

      if (ts.isStringLiteralLike(node) && /^\/api\//.test(node.text)) {
        add("no-raw-api-path", "Build endpoint and asset URLs in an owned @/lib adapter.", fileName, sourceFile, node)
      }
      if (ts.isTemplateExpression(node) && /^\/api\//.test(node.head.text)) {
        add("no-raw-api-path", "Build endpoint and asset URLs in an owned @/lib adapter.", fileName, sourceFile, node)
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  }
}

if (reportJson) {
  console.log(JSON.stringify(violations, null, 2))
  process.exit(0)
}

const ledger = JSON.parse(fs.readFileSync(path.join(frontendRoot, "design-system", "exceptions.json"), "utf8"))
const today = new Date().toISOString().slice(0, 10)
const remaining = []
const used = new Map()
for (const violation of violations) {
  const exception = ledger.architecture.find((entry) =>
    entry.rule === violation.rule
    && entry.file === violation.file
    && entry.matches.includes(violation.match)
  )
  if (!exception) {
    remaining.push(violation)
    continue
  }
  if (!exception.owner || !exception.reason || !exception.expires || exception.expires < today) {
    remaining.push({ ...violation, remediation: "Architecture exception is missing ownership/reason/expiry or has expired." })
    continue
  }
  const key = `${exception.rule}:${exception.file}`
  used.set(key, (used.get(key) || 0) + 1)
}
for (const entry of ledger.architecture) {
  const key = `${entry.rule}:${entry.file}`
  const actual = used.get(key) || 0
  if (actual !== entry.count) {
    remaining.push({
      rule: "stale-architecture-exception",
      file: entry.file,
      line: 1,
      column: 1,
      match: entry.matches.join(", "),
      remediation: `Expected exception count ${entry.count}, found ${actual}. Remove or update the ledger entry.`,
    })
  }
}

if (remaining.length) {
  console.error("React harness policy failed:\n\n" + remaining.map((item) =>
    `- ${item.file}:${item.line}:${item.column} ${item.rule} (${item.match}) — ${item.remediation}`
  ).join("\n"))
  process.exit(1)
}

console.log("React harness policy passed: presentation code cannot directly own endpoints, streams, browser persistence, native globals, service workers or legacy implementation imports beyond exact, expiring exceptions.")
