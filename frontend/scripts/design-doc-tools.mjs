import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = path.resolve(frontendRoot, "..")
const defaultCitationsPath = path.join(frontendRoot, "design-system", "interface-law-citations.json")
const defaultLedgerAuthorityPath = path.join(frontendRoot, "design-system", "decision-ledger-authority.json")
const defaultLedgerPath = path.join(frontendRoot, "design-system", "decision-ledger.json")
const foundationPageIds = ["surfaces", "ink-levels", "type-ramp", "spacing-rhythm", "radius-grouping", "redlines"]

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(fileName, "utf8"))
}

function filesIn(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const resolved = path.join(directory, entry.name)
    return entry.isDirectory() ? filesIn(resolved) : [resolved]
  })
}

function markdownSections(source) {
  const sections = new Set()
  for (const match of source.matchAll(/^##\s+(.+)$/gm)) sections.add(match[1].trim())
  return sections
}

function scannerRuleIds(source) {
  const sourceFile = ts.createSourceFile("interface-law-tools.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const rules = new Set()
  const visit = (node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "finding"
      && ts.isStringLiteralLike(node.arguments[4])
    ) rules.add(node.arguments[4].text)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return rules
}

function stringConstants(sourceFile) {
  const values = new Map()
  for (const statement of sourceFile.statements.filter(ts.isVariableStatement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isStringLiteralLike(declaration.initializer)) {
        values.set(declaration.name.text, declaration.initializer.text)
      }
    }
  }
  return values
}

function staticString(node, constants) {
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isIdentifier(node)) return constants.get(node.text)
  return undefined
}

function testCases(source) {
  const sourceFile = ts.createSourceFile("citation-test.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const constants = stringConstants(sourceFile)
  const cases = new Map()
  const visit = (node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && ["test", "it"].includes(node.expression.text)
    ) {
      const name = staticString(node.arguments[0], constants)
      if (name) cases.set(name, node.getText(sourceFile))
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return cases
}

function testRuleCoverage(source) {
  const sourceFile = ts.createSourceFile("citation-test.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const constants = stringConstants(sourceFile)
  const coverage = new Map()
  for (const node of sourceFile.statements) {
    if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) continue
    const testCall = node.expression
    if (!ts.isIdentifier(testCall.expression) || !["test", "it"].includes(testCall.expression.text)) continue
    const testName = staticString(testCall.arguments[0], constants)
    const callback = testCall.arguments[1]
    if (!testName || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) || !ts.isBlock(callback.body)) continue
    for (const statement of callback.body.statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue
      const call = statement.expression
      if (!ts.isIdentifier(call.expression) || call.expression.text !== "assertRuleCoverage" || !ts.isArrayLiteralExpression(call.arguments[2])) continue
      const markerName = staticString(call.arguments[0], constants)
      if (markerName !== testName) continue
      coverage.set(testName, new Set(call.arguments[2].elements.filter(ts.isStringLiteralLike).map((element) => element.text)))
    }
  }
  return coverage
}

function ruleCoverageHelperIsSubstantive(source) {
  const sourceFile = ts.createSourceFile("citation-test.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const helper = sourceFile.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "assertRuleCoverage")
  if (!helper?.body) return false
  const assertionIsSubstantive = (node) => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === "assert"
      && node.expression.name.text === "ok"
      && node.arguments[0]
    ) {
      let scansFindings = false
      let comparesRule = false
      const inspectAssertion = (child) => {
        if (
          ts.isCallExpression(child)
          && ts.isPropertyAccessExpression(child.expression)
          && ts.isIdentifier(child.expression.expression)
          && child.expression.expression.text === "findings"
          && child.expression.name.text === "some"
        ) scansFindings = true
        if (
          ts.isBinaryExpression(child)
          && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(child.operatorToken.kind)
          && ts.isPropertyAccessExpression(child.left)
          && child.left.name.text === "rule"
          && ts.isIdentifier(child.right)
          && child.right.text === "rule"
        ) comparesRule = true
        ts.forEachChild(child, inspectAssertion)
      }
      inspectAssertion(node.arguments[0])
      return scansFindings && comparesRule
    }
    return false
  }
  for (const statement of helper.body.statements) {
    if (!ts.isForOfStatement(statement) && !ts.isForInStatement(statement)) continue
    if (!ts.isIdentifier(statement.expression) || statement.expression.text !== "rules") continue
    const declaration = statement.initializer
    if (!ts.isVariableDeclarationList(declaration) || declaration.declarations.length !== 1 || !ts.isIdentifier(declaration.declarations[0].name) || declaration.declarations[0].name.text !== "rule") continue
    const body = ts.isBlock(statement.statement) ? statement.statement.statements : [statement.statement]
    if (body.some((item) => ts.isExpressionStatement(item) && assertionIsSubstantive(item.expression))) return true
  }
  return false
}

function storyExports(source) {
  return new Set([...source.matchAll(/^export const ([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]))
}

function storyAssertions(source) {
  const sourceFile = ts.createSourceFile("citation-story.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const assertions = new Set()
  const helpers = new Map()
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) helpers.set(statement.name.text, statement)
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
        helpers.set(declaration.name.text, declaration.initializer)
      }
    }
  }
  const isStaticallyDead = (candidate, boundary) => {
    let child = candidate
    for (let parent = candidate.parent; parent && parent !== boundary; child = parent, parent = parent.parent) {
      if (ts.isIfStatement(parent)) {
        if (parent.expression.kind === ts.SyntaxKind.FalseKeyword && child === parent.thenStatement) return true
        if (parent.expression.kind === ts.SyntaxKind.TrueKeyword && child === parent.elseStatement) return true
      }
      if (ts.isBinaryExpression(parent) && child === parent.right) {
        if (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && parent.left.kind === ts.SyntaxKind.FalseKeyword) return true
        if (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken && parent.left.kind === ts.SyntaxKind.TrueKeyword) return true
      }
    }
    return false
  }
  const hasAssertion = (node, seen = new Set()) => {
    let asserted = false
    const helperCalls = new Set()
    const visit = (child) => {
      if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression)) {
        let receiver = child.expression.expression
        while (ts.isPropertyAccessExpression(receiver)) receiver = receiver.expression
        if (
          !isStaticallyDead(child, node)
          && ts.isCallExpression(receiver)
          && ts.isIdentifier(receiver.expression)
          && receiver.expression.text === "expect"
        ) asserted = true
      } else if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) {
        if (isStaticallyDead(child, node)) return
        if (child.expression.text !== "expect") helperCalls.add(child.expression.text)
      }
      ts.forEachChild(child, visit)
    }
    visit(node)
    if (asserted) return true
    for (const helperName of helperCalls) {
      if (seen.has(helperName) || !helpers.has(helperName)) continue
      const nextSeen = new Set(seen)
      nextSeen.add(helperName)
      if (hasAssertion(helpers.get(helperName).body, nextSeen)) return true
    }
    return false
  }
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) continue
      const play = declaration.initializer.properties.find((property) => property.name?.getText(sourceFile) === "play")
      if (!play) continue
      const callable = ts.isPropertyAssignment(play) ? play.initializer : play
      if (!ts.isArrowFunction(callable) && !ts.isFunctionExpression(callable) && !ts.isMethodDeclaration(callable)) continue
      if (hasAssertion(callable.body)) assertions.add(declaration.name.text)
    }
  }
  return assertions
}

function resolveFrontendPath(root, value) {
  if (typeof value !== "string" || !value.trim()) return null
  const resolved = value.startsWith("@/")
    ? path.resolve(root, "@", value.slice(2))
    : path.resolve(root, value)
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : null
}

export function validateDesignDocCitations(citations, options = {}) {
  const root = options.frontendRoot || frontendRoot
  const requiredPages = options.requiredPages || foundationPageIds
  const violations = []
  if (!isRecord(citations) || citations.version !== 1 || !Array.isArray(citations.citations)) {
    return ["interface-law citations must be a version 1 object with a citations array"]
  }
  const lawsSource = fs.readFileSync(path.join(root, "design-system", "interface-laws.md"), "utf8")
  const sections = markdownSections(lawsSource)
  const scannerSource = fs.readFileSync(path.join(root, "scripts", "interface-law-tools.mjs"), "utf8")
  const rules = scannerRuleIds(scannerSource)
  const packageScripts = readJson(path.join(root, "package.json")).scripts || {}
  const ids = new Set()
  const coveredPages = new Set()

  for (const [index, citation] of citations.citations.entries()) {
    const label = `citations[${index}]`
    if (!isRecord(citation)) {
      violations.push(`${label} must be an object`)
      continue
    }
    if (typeof citation.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(citation.id)) {
      violations.push(`${label}.id must be kebab-case`)
    } else if (ids.has(citation.id)) violations.push(`${label}.id duplicates ${citation.id}`)
    else ids.add(citation.id)
    if (!foundationPageIds.includes(citation.page)) violations.push(`${label}.page does not resolve: ${citation.page}`)
    else coveredPages.add(citation.page)
    if (!sections.has(citation.lawSection)) violations.push(`${label}.lawSection does not resolve: ${citation.lawSection}`)
    if (typeof citation.catches !== "string" || !citation.catches.trim()) violations.push(`${label}.catches is required`)
    if (typeof citation.misses !== "string" || !citation.misses.trim()) violations.push(`${label}.misses is required`)

    if (citation.kind === "scanner-rule") {
      if (!rules.has(citation.rule)) violations.push(`${label}.rule does not exist in the scanner: ${citation.rule}`)
      if (citation.check !== "check:interface-laws" || !Object.hasOwn(packageScripts, citation.check)) violations.push(`${label}.check must resolve to the interface-law scanner lane: ${citation.check}`)
      const testFile = resolveFrontendPath(root, citation.test?.path)
      if (!testFile || !fs.existsSync(testFile)) violations.push(`${label}.test.path does not exist: ${citation.test?.path}`)
      else {
        const testSource = fs.readFileSync(testFile, "utf8")
        const cases = testCases(testSource)
        const testBody = cases.get(citation.test?.name)
        if (!testBody) violations.push(`${label}.test.name does not resolve in ${citation.test.path}: ${citation.test?.name}`)
        else if (!ruleCoverageHelperIsSubstantive(testSource)) {
          violations.push(`${label}.test.path has no substantive assertRuleCoverage helper: ${citation.test?.path}`)
        } else if (!testRuleCoverage(testSource).get(citation.test?.name)?.has(citation.rule)) {
          violations.push(`${label}.test.name does not exercise ${citation.rule}: ${citation.test?.name}`)
        }
      }
    } else if (citation.kind === "rendered-test") {
      if (citation.check !== "test:storybook" || !Object.hasOwn(packageScripts, citation.check)) violations.push(`${label}.check must resolve to the rendered Storybook test lane: ${citation.check}`)
      const storyFile = resolveFrontendPath(root, citation.story?.path)
      if (!storyFile || !fs.existsSync(storyFile)) violations.push(`${label}.story.path does not exist: ${citation.story?.path}`)
      else {
        const storySource = fs.readFileSync(storyFile, "utf8")
        if (!storyExports(storySource).has(citation.story?.export)) {
          violations.push(`${label}.story.export does not resolve in ${citation.story.path}: ${citation.story?.export}`)
        } else if (!storyAssertions(storySource).has(citation.story?.export)) {
          violations.push(`${label}.story.export has no play assertion in ${citation.story.path}: ${citation.story?.export}`)
        }
      }
    } else if (citation.kind === "review-only") {
      const reviewFile = resolveFrontendPath(root, citation.review?.path)
      if (!reviewFile || !fs.existsSync(reviewFile)) violations.push(`${label}.review.path does not exist: ${citation.review?.path}`)
      if (typeof citation.review?.instruction !== "string" || !citation.review.instruction.trim()) {
        violations.push(`${label}.review.instruction is required`)
      }
      if (citation.rule || citation.check || citation.test || citation.story) {
        violations.push(`${label} is review-only and must not imply mechanical enforcement`)
      }
    } else violations.push(`${label}.kind must be scanner-rule, rendered-test, or review-only`)
  }
  for (const page of requiredPages) {
    if (!coveredPages.has(page)) violations.push(`interface-law citations do not cover foundation page: ${page}`)
  }
  return violations
}

function moduleSpecifiers(fileName, source) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const values = []
  const literalValues = (node) => {
    if (ts.isStringLiteralLike(node)) return [node.text]
    if (ts.isArrayLiteralExpression(node)) return node.elements.filter(ts.isStringLiteralLike).map((element) => element.text)
    return []
  }
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      values.push(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments
      if (argument && ts.isStringLiteralLike(argument)) values.push(argument.text)
    } else if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ["glob", "globEager"].includes(node.expression.name.text)
      && ts.isMetaProperty(node.expression.expression)
    ) {
      const [argument] = node.arguments
      if (argument) values.push(...literalValues(argument))
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return values
}

function resolveSourceImport(root, importer, specifier) {
  if (!specifier.startsWith("@/") && !specifier.startsWith("/@/") && !specifier.startsWith(".")) return null
  const base = specifier.startsWith("/@/")
    ? path.resolve(root, specifier.slice(1))
    : specifier.startsWith("@/")
    ? path.resolve(root, "@", specifier.slice(2))
    : path.resolve(path.dirname(importer), specifier)
  return [base, ...[".js", ".jsx", ".mjs", ".ts", ".tsx"].map((extension) => `${base}${extension}`), ...["index.js", "index.jsx", "index.mjs", "index.ts", "index.tsx"].map((entry) => path.join(base, entry))]
    .find((candidate) => fs.existsSync(candidate)) || base
}

export function productionDocImportViolations(options = {}) {
  const root = options.frontendRoot || frontendRoot
  const docsRoot = path.join(root, "@", "docs")
  const sources = [path.join(root, "src"), path.join(root, "@")]
    .flatMap(filesIn)
    .filter((fileName) => /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/.test(fileName))
    .filter((fileName) => !fileName.startsWith(`${docsRoot}${path.sep}`))
    .filter((fileName) => !/\.stories\.(?:[cm]?js|jsx|tsx?)$/.test(fileName))
  const violations = []
  for (const fileName of sources) {
    const source = fs.readFileSync(fileName, "utf8")
    for (const specifier of moduleSpecifiers(fileName, source)) {
      const resolved = resolveSourceImport(root, fileName, specifier)
      if (resolved && (resolved === docsRoot || resolved.startsWith(`${docsRoot}${path.sep}`))) {
        violations.push(`${path.relative(root, fileName)} imports Storybook-only documentation through ${specifier}`)
      }
    }
  }
  return violations
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
}

export function generateDecisionLedger(authority, options = {}) {
  const root = options.repoRoot || repoRoot
  if (!isRecord(authority) || authority.version !== 1 || !Array.isArray(authority.entries)) {
    throw new Error("decision-ledger authority must be a version 1 object with an entries array")
  }
  if (
    authority.history?.traversal !== "first-parent"
    || !/^[0-9a-f]{40}$/.test(authority.history?.startExclusive || "")
  ) throw new Error("decision-ledger authority must pin a first-parent startExclusive revision")
  try {
    git(root, ["merge-base", "--is-ancestor", authority.history.startExclusive, "HEAD"])
  } catch {
    throw new Error("decision-ledger history.startExclusive must be an ancestor of HEAD")
  }
  const publicationSpine = new Set(git(root, ["rev-list", "--first-parent", "HEAD"]).split("\n").filter(Boolean))
  if (!publicationSpine.has(authority.history.startExclusive)) {
    throw new Error("decision-ledger history.startExclusive must be on first-parent HEAD history")
  }
  const revisionRange = `${authority.history.startExclusive}..HEAD`
  const firstParent = new Set(git(root, ["log", "--first-parent", "--format=%H", revisionRange]).split("\n").filter(Boolean))
  const seenCommits = new Set()
  const seenOrigins = new Set()
  return {
    version: 1,
    generatedFrom: ["design-system/decision-ledger-authority.json", `git log --first-parent ${revisionRange}`],
    entries: authority.entries.map((entry, index) => {
      if (!/^[0-9a-f]{40}$/.test(entry.commit || "") || !firstParent.has(entry.commit)) {
        throw new Error(`decision-ledger entries[${index}].commit is not on first-parent HEAD history: ${entry.commit}`)
      }
      if (seenCommits.has(entry.commit)) throw new Error(`decision-ledger entries[${index}].commit duplicates ${entry.commit}`)
      seenCommits.add(entry.commit)
      for (const field of ["decision", "originEvent", "receiptEvent", "approvalEvent"]) {
        if (typeof entry[field] !== "string" || !entry[field].trim()) throw new Error(`decision-ledger entries[${index}].${field} is required`)
      }
      for (const field of ["originEvent", "receiptEvent", "approvalEvent"]) {
        if (!/^[0-9a-f]{64}$/.test(entry[field])) throw new Error(`decision-ledger entries[${index}].${field} must be a full Buzz event id`)
      }
      const originKey = `${entry.commit}\0${entry.originEvent}`
      if (seenOrigins.has(originKey)) throw new Error(`decision-ledger entries[${index}] duplicates its commit and origin event`)
      seenOrigins.add(originKey)
      const details = git(root, ["show", "-s", "--format=%as%x00%s%x00%(trailers:key=Origin-Buzz-Event,valueonly)", entry.commit]).split("\0")
      const [date, subject, trailerOrigin = ""] = details
      if (trailerOrigin.trim() && trailerOrigin.trim() !== entry.originEvent) {
        throw new Error(`decision-ledger entries[${index}].originEvent disagrees with commit trailer`)
      }
      return {
        date,
        decision: entry.decision,
        originEvent: entry.originEvent,
        commit: entry.commit,
        commitSubject: subject,
        receiptEvent: entry.receiptEvent,
        approvalEvent: entry.approvalEvent,
      }
    }),
  }
}

export function renderDecisionLedger(ledger) {
  return `${JSON.stringify(ledger, null, 2)}\n`
}

export function checkDesignDocs(options = {}) {
  const root = options.frontendRoot || frontendRoot
  const citationsPath = options.citationsPath || process.env.DESIGN_DOC_CITATIONS_PATH || defaultCitationsPath
  const authorityPath = options.ledgerAuthorityPath || process.env.DESIGN_DOC_LEDGER_AUTHORITY_PATH || defaultLedgerAuthorityPath
  const ledgerPath = options.ledgerPath || defaultLedgerPath
  const violations = []
  try {
    violations.push(...validateDesignDocCitations(readJson(citationsPath), { frontendRoot: root }))
  } catch (error) {
    violations.push(`interface-law citations cannot be read: ${error.message}`)
  }
  violations.push(...productionDocImportViolations({ frontendRoot: root }))
  try {
    const rendered = renderDecisionLedger(generateDecisionLedger(readJson(authorityPath), { repoRoot: options.repoRoot || repoRoot }))
    if (!fs.existsSync(ledgerPath) || fs.readFileSync(ledgerPath, "utf8") !== rendered) {
      violations.push("design-system/decision-ledger.json is stale; regenerate it from authority and first-parent history")
    }
  } catch (error) {
    violations.push(`decision ledger is invalid: ${error.message}`)
  }
  return violations
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--write-ledger")) {
    fs.writeFileSync(defaultLedgerPath, renderDecisionLedger(generateDecisionLedger(readJson(defaultLedgerAuthorityPath))))
    console.log(`Wrote ${path.relative(frontendRoot, defaultLedgerPath)}`)
  } else {
    const violations = checkDesignDocs()
    if (violations.length) {
      console.error(`Design documentation check failed:\n\n${violations.map((item) => `- ${item}`).join("\n")}`)
      process.exit(1)
    }
    console.log("Design documentation citations, ledger projection, and production-import fence passed.")
  }
}
