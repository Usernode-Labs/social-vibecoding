import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { collectContextBudgetMeasurement } from "./check-context-budget.mjs"
import { collectProgressiveContext } from "./check-progressive-context.mjs"

export const PR_CASE_BASE_REVISION = "472de79151060300df68fc6e98e242351d76eef0"
export const PR_CASE_BRANCH_REVISION = "2f8605304ba9812474b2a8d8a8a0ff3fc3a83bf9"

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = path.resolve(frontendRoot, "..")

function git(args, options = {}) {
  const result = execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  })
  return typeof result === "string" ? result.trim() : result
}

function lines(value) {
  return value ? value.split("\n").filter(Boolean) : []
}

function filesAt(revision, directory, pattern) {
  return lines(git(["ls-tree", "-r", "--name-only", revision, directory]))
    .filter((fileName) => pattern.test(fileName))
}

function readJsonAt(revision, fileName) {
  return JSON.parse(git(["show", `${revision}:${fileName}`]))
}

function fileAt(revision, fileName) {
  return git(["show", `${revision}:${fileName}`], { encoding: "buffer" })
}

function physicalLinesAt(revision, fileNames) {
  if (!fileNames.length) return 0
  const input = `${fileNames.map((fileName) => `${revision}:${fileName}`).join("\n")}\n`
  const batch = execFileSync("git", ["cat-file", "--batch"], {
    cwd: repoRoot,
    input,
    maxBuffer: 64 * 1024 * 1024,
  })
  let offset = 0
  let total = 0
  for (const fileName of fileNames) {
    const headerEnd = batch.indexOf(10, offset)
    if (headerEnd < 0) throw new Error(`missing batch header for ${revision}:${fileName}`)
    const [, type, rawSize] = batch.subarray(offset, headerEnd).toString("utf8").split(" ")
    const size = Number(rawSize)
    if (type !== "blob" || !Number.isSafeInteger(size)) {
      throw new Error(`invalid batch object for ${revision}:${fileName}`)
    }
    const contentStart = headerEnd + 1
    const contentEnd = contentStart + size
    if (batch[contentEnd] !== 10) throw new Error(`missing batch separator for ${revision}:${fileName}`)
    for (let index = contentStart; index < contentEnd; index += 1) {
      if (batch[index] === 10) total += 1
    }
    offset = contentEnd + 1
  }
  return total
}

function measuredFiles(revision, fileNames) {
  return { files: fileNames.length, lines: physicalLinesAt(revision, fileNames) }
}

function fileContains(revision, fileName, pattern) {
  try {
    git(["grep", "-l", "-e", pattern, revision, "--", fileName], { stdio: ["ignore", "pipe", "ignore"] })
    return true
  } catch {
    return false
  }
}

function objectExists(revision, fileName) {
  try {
    git(["cat-file", "-e", `${revision}:${fileName}`], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function repositoryProjectionSha256(relativePaths) {
  const digest = crypto.createHash("sha256")
  for (const relativePath of [...new Set(relativePaths)].sort()) {
    const absolutePath = path.join(repoRoot, relativePath)
    digest.update(relativePath)
    digest.update("\0")
    digest.update(fs.readFileSync(absolutePath))
    digest.update("\0")
  }
  return digest.digest("hex")
}

function metric(id, value, unit, revision, scope) {
  return { id, value, unit, revision, scope }
}

function manifestClaim({ id, slideId, statement, metrics, sources }) {
  return {
    id,
    slideId,
    statement,
    metrics,
    command: `node frontend/scripts/pr-case-tools.mjs --probe ${id} --base ${PR_CASE_BASE_REVISION} --branch ${PR_CASE_BRANCH_REVISION}`,
    sources,
  }
}

export function buildTokenDemo() {
  const canonicalPath = path.join(frontendRoot, "design-system", "tokens.json")
  const source = JSON.parse(fs.readFileSync(canonicalPath, "utf8"))
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "usernode-token-demo-"))
  const temporaryTokenPath = path.join(temporaryRoot, "design-system", "tokens.json")
  const generatedCssPath = path.join(temporaryRoot, "src", "generated", "design-tokens.css")
  fs.mkdirSync(path.dirname(temporaryTokenPath), { recursive: true })
  fs.mkdirSync(path.dirname(generatedCssPath), { recursive: true })
  try {
    const valid = structuredClone(source)
    valid.semantic.light.primary.$value.components = [0.32, 0.08, 255]
    fs.writeFileSync(temporaryTokenPath, `${JSON.stringify(valid, null, 2)}\n`)
    execFileSync(process.execPath, [path.join(frontendRoot, "scripts", "build-design-tokens.mjs")], {
      cwd: temporaryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    const propagatedLine = fs.readFileSync(generatedCssPath, "utf8").split("\n")
      .find((line) => line.includes("--primary:"))?.trim()

    const invalid = structuredClone(source)
    invalid.semantic.light.paper.$value.components = [0.94, 0, 0]
    fs.writeFileSync(temporaryTokenPath, `${JSON.stringify(invalid, null, 2)}\n`)
    let rejection = null
    try {
      execFileSync(process.execPath, [path.join(frontendRoot, "scripts", "build-design-tokens.mjs")], {
        cwd: temporaryRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      rejection = error.stderr?.trim() || error.message
    }
    if (!propagatedLine || !rejection) throw new Error("temporary token generator did not prove both propagation and refusal")

    return {
      validEdit: "semantic.light.primary -> oklch(0.32 0.08 255)",
      propagatedLine,
      invalidEdit: "semantic.light.paper -> oklch(0.94 0 0)",
      rejection: rejection.split("\n").find((line) => line.includes("Canvas to Paper lightness step")) || rejection,
      canonicalSha256: sha256(fs.readFileSync(canonicalPath)),
      temporaryWorkingDirectory: true,
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

export function collectPrCaseEvidence() {
  const basePackage = readJsonAt(PR_CASE_BASE_REVISION, "package.json")
  const branchPackage = readJsonAt(PR_CASE_BRANCH_REVISION, "frontend/package.json")
  const catalog = readJsonAt(PR_CASE_BRANCH_REVISION, "frontend/design-system/catalog.json")
  const contextPolicy = readJsonAt(PR_CASE_BRANCH_REVISION, "frontend/design-system/context-budget.json")
  const interfaceLaws = fileAt(PR_CASE_BRANCH_REVISION, "frontend/design-system/interface-laws.md").toString("utf8")
  const receiptPath = path.join(repoRoot, "docs", "pr-case", "receipts", "integration.json")
  const gate = JSON.parse(fs.readFileSync(receiptPath, "utf8"))
  const captureManifestPath = path.join(repoRoot, "docs", "pr-case", "capture-manifest.json")
  const captureManifest = JSON.parse(fs.readFileSync(captureManifestPath, "utf8"))
  const contextMeasurement = collectContextBudgetMeasurement()
  const progressiveContext = collectProgressiveContext()
  const tokenDemo = buildTokenDemo()
  const tierCounts = Object.fromEntries(["element", "block", "feature"].map((tier) => [
    tier,
    catalog.components.filter((component) => component.tier === tier).length,
  ]))

  const baseTailwindPages = filesAt(PR_CASE_BASE_REVISION, "public", /\.html$/)
    .filter((fileName) => fileContains(PR_CASE_BASE_REVISION, fileName, "cdn.tailwindcss.com"))
  const basePaletteCssFiles = filesAt(PR_CASE_BASE_REVISION, "public", /\.css$/)
    .filter((fileName) => fileContains(PR_CASE_BASE_REVISION, fileName, "--bg-primary:"))
  const baseTests = filesAt(PR_CASE_BASE_REVISION, "tests", /\.test\.js$/)
  const branchTests = filesAt(PR_CASE_BRANCH_REVISION, "tests", /\.test\.js$/)
  const branchTestSet = new Set(branchTests)
  const removedBaseTests = baseTests.filter((fileName) => !branchTestSet.has(fileName))
  const branchStories = filesAt(PR_CASE_BRANCH_REVISION, "frontend/@", /\.stories\.[jt]sx?$/)
  const branchOnlyCommits = Number(git(["rev-list", "--count", `${PR_CASE_BASE_REVISION}..${PR_CASE_BRANCH_REVISION}`]))
  const log = git(["log", "--format=%H%x00%B%x00END", `${PR_CASE_BASE_REVISION}..${PR_CASE_BRANCH_REVISION}`])
  const commitMessages = log.split("\u0000END\n").filter(Boolean)
  const provenanceMessages = commitMessages.filter((message) => /^Task:\s*.+$/m.test(message) && /^Origin-Buzz-Event:\s*[0-9a-f]{64}$/m.test(message))
  const provenanceEvents = new Set(provenanceMessages.flatMap((message) => (
    [...message.matchAll(/^Origin-Buzz-Event:\s*([0-9a-f]{64})$/gm)].map((match) => match[1])
  )))
  const guardedInvalidMutations = (fs.readFileSync(path.join(frontendRoot, "scripts", "check-design-tokens.mjs"), "utf8")
    .match(/expectRejected\(/g) || []).length - 1
  const canonicalTokenSources = filesAt(PR_CASE_BRANCH_REVISION, "frontend/design-system", /(?:^|\/)tokens\.json$/).length
  const legacyMarkupFiles = filesAt(PR_CASE_BASE_REVISION, "public", /\.html$/)
  const legacyStyleFiles = filesAt(PR_CASE_BASE_REVISION, "public/css", /./)
  const legacyScriptFiles = filesAt(PR_CASE_BASE_REVISION, "public/js", /./)
  const frontendFiles = filesAt(PR_CASE_BRANCH_REVISION, "frontend", /./)
    .filter((fileName) => fileName !== "frontend/package-lock.json")
  const frontendProductFiles = filesAt(PR_CASE_BRANCH_REVISION, "frontend", /^(?:frontend\/@\/|frontend\/src\/)/)
    .filter((fileName) => !/\.stories\.[jt]sx?$/.test(fileName))
  const frontendProofFiles = [
    ...filesAt(PR_CASE_BRANCH_REVISION, "frontend", /\.stories\.[jt]sx?$/),
    ...filesAt(PR_CASE_BRANCH_REVISION, "frontend/tests", /./),
    ...filesAt(PR_CASE_BRANCH_REVISION, "frontend/scripts", /./),
    ...filesAt(PR_CASE_BRANCH_REVISION, "frontend/design-system", /./),
  ]
  const frontendProductSet = new Set(frontendProductFiles)
  const frontendProofSet = new Set(frontendProofFiles)
  if (frontendProductSet.size !== frontendProductFiles.length || frontendProofSet.size !== frontendProofFiles.length) {
    throw new Error("front-end size evidence contains duplicate files")
  }
  for (const fileName of frontendProductSet) {
    if (frontendProofSet.has(fileName)) throw new Error(`front-end size evidence overlaps at ${fileName}`)
  }
  const frontendConfigurationFiles = frontendFiles.filter((fileName) => (
    !frontendProductSet.has(fileName) && !frontendProofSet.has(fileName)
  ))
  const surfaceSize = {
    legacy: {
      markup: measuredFiles(PR_CASE_BASE_REVISION, legacyMarkupFiles),
      styling: measuredFiles(PR_CASE_BASE_REVISION, legacyStyleFiles),
      scripts: measuredFiles(PR_CASE_BASE_REVISION, legacyScriptFiles),
      total: measuredFiles(PR_CASE_BASE_REVISION, [...legacyMarkupFiles, ...legacyStyleFiles, ...legacyScriptFiles]),
    },
    react: {
      product: measuredFiles(PR_CASE_BRANCH_REVISION, frontendProductFiles),
      proof: measuredFiles(PR_CASE_BRANCH_REVISION, frontendProofFiles),
      configuration: measuredFiles(PR_CASE_BRANCH_REVISION, frontendConfigurationFiles),
      total: measuredFiles(PR_CASE_BRANCH_REVISION, frontendFiles),
    },
  }
  const mainSource = fileAt(PR_CASE_BRANCH_REVISION, "frontend/src/main.tsx").toString("utf8")
  const routesSource = fileAt(PR_CASE_BRANCH_REVISION, "frontend/@/lib/routes.ts").toString("utf8")
  const proposalSource = fileAt(PR_CASE_BRANCH_REVISION, "frontend/@/features/dev/dev-proposal-detail.tsx").toString("utf8")
  const basename = mainSource.match(/<BrowserRouter basename="([^"]+)"/)?.[1]
  const proposalPattern = mainSource.match(/<Route element={<DevProposalDetail \/>} path="([^"]+)"/)?.[1]
  const routeExample = { slug: "usernode-2d5619", proposalId: "2971" }
  if (basename !== "/react" || proposalPattern !== "/apps/:slug/dev/proposals/:proposalId") {
    throw new Error("pinned React proposal route no longer matches the staged route contract")
  }
  if (!routesSource.includes("appDevProposalPath") || !proposalSource.includes("castProposalVote")
    || !proposalSource.includes("giveProposalKudos") || !proposalSource.includes("More proposal actions")) {
    throw new Error("pinned React proposal route no longer exposes the measured compatibility seam")
  }
  const routeShape = {
    basename,
    proposalPattern,
    legacyExample: `/#app/${routeExample.slug}/dev/proposals/${routeExample.proposalId}`,
    reactExample: `${basename}/apps/${routeExample.slug}/dev/proposals/${routeExample.proposalId}`,
  }

  const facts = {
    revisions: { base: PR_CASE_BASE_REVISION, branch: PR_CASE_BRANCH_REVISION },
    base: {
      tailwindHtmlPages: baseTailwindPages.length,
      tailwindRuntimeFiles: ["public/index.html", "public/sw.js", "public/usernode-native/v1/demo.html"]
        .filter((fileName) => fileContains(PR_CASE_BASE_REVISION, fileName, "cdn.tailwindcss.com")).length,
      rootNodeTestFiles: baseTests.length,
      componentStoryFiles: filesAt(PR_CASE_BASE_REVISION, "frontend/@", /\.stories\.[jt]sx?$/).length,
      scripts: Object.keys(basePackage.scripts || {}).length,
      hasCentralPalette: objectExists(PR_CASE_BASE_REVISION, "public/css/app.css"),
      centralPaletteCssFiles: basePaletteCssFiles.length,
    },
    branch: {
      rootNodeTestFiles: branchTests.length,
      retainedBaseTestFiles: baseTests.length - removedBaseTests.length,
      removedBaseTestFiles: removedBaseTests.length,
      storyFiles: branchStories.length,
      checkScripts: Object.keys(branchPackage.scripts || {}).filter((name) => name.startsWith("check:")).length,
      catalogComponents: catalog.components.length,
      catalogTiers: tierCounts,
      catalogTierCount: Object.keys(tierCounts).length,
      branchOnlyCommits,
      provenanceCommits: provenanceMessages.length,
      provenanceEvents: provenanceEvents.size,
    },
    laws: {
      physicalLines: interfaceLaws.split("\n").length - 1,
      nonblankLines: interfaceLaws.split("\n").filter((line) => line.trim()).length,
      bytes: Buffer.byteLength(interfaceLaws),
    },
    context: {
      alwaysLoadedBytes: contextMeasurement.alwaysLoadedBytes,
      alwaysLoadedRatchetBytes: contextPolicy.globalRatchets.alwaysLoadedBytes,
      componentReviewBytes: progressiveContext.route.totalBytes,
      componentReviewRatchetBytes: contextPolicy.componentReview.postRoutingRatchetBytes,
      ownerCeilingBytes: progressiveContext.ownerCeilingBytes,
    },
    gate: {
      stages: gate.stageIds.length,
      passed: gate.result.passed,
      skipped: gate.result.skipped,
      omitted: gate.result.omitted,
      receiptGrade: gate.result.receiptGrade,
      sourceStart: gate.source.start,
      sourceEnd: gate.source.end,
      cleanStart: gate.source.cleanStart,
      cleanEnd: gate.source.cleanEnd,
      failedExactHeads: gate.failedExactHeads.length,
      serverTestsPassed: gate.verification.serverTestsPassed,
      browserTestsPassed: gate.verification.browserTestsPassed,
      browserDeclaredSkips: gate.verification.browserDeclaredSkips,
      artifactSha256: gate.artifactSha256,
      integrationAlwaysLoadedBytes: gate.contextCorrection.regressedAlwaysLoadedBytes,
      integrationAlwaysLoadedRatchetBytes: gate.contextCorrection.alwaysLoadedRatchetBytes,
      routedGuidanceBytes: gate.contextCorrection.routedGuidanceBytes,
    },
    capture: {
      images: captureManifest.captures.length,
      width: captureManifest.viewport.width,
      height: captureManifest.viewport.height,
      themes: new Set(captureManifest.captures.map((capture) => capture.theme)).size,
      routes: [...new Set(captureManifest.captures.map((capture) => capture.route))],
    },
    surfaceSize,
    routeShape,
    guardedInvalidMutations,
    canonicalTokenSources,
    tokenDemo,
  }

  const tokenAuthorityRevision = `sha256:${repositoryProjectionSha256([
    "frontend/design-system/tokens.json",
    "frontend/scripts/build-design-tokens.mjs",
    "frontend/scripts/design-token-tools.mjs",
    "frontend/scripts/check-design-tokens.mjs",
  ])}`
  const contextAuthorityRevision = `sha256:${repositoryProjectionSha256([
    "AGENTS.md",
    "frontend/AGENTS.md",
    "agent-skills/ui-development/workflows.json",
    "frontend/design-system/context-budget.json",
    "frontend/scripts/check-context-budget.mjs",
    "frontend/scripts/check-harness-fitness.mjs",
    "frontend/scripts/check-progressive-context.mjs",
    "tool/ui-workflow.mjs",
    ...progressiveContext.route.context,
  ])}`
  const captureAuthorityRevision = `sha256:${sha256(fs.readFileSync(captureManifestPath))}`
  const claims = [
    manifestClaim({
      id: "R1", slideId: "main-partial-centralization",
      statement: `Pinned main centralizes its platform palette in one CSS file, while ${facts.base.tailwindHtmlPages} HTML pages still load the browser compiler.`,
      metrics: [
        metric("centralPaletteFiles", facts.base.centralPaletteCssFiles, "CSS files", PR_CASE_BASE_REVISION, "pinned main palette definition"),
        metric("browserCompilerHtmlPages", facts.base.tailwindHtmlPages, "HTML files", PR_CASE_BASE_REVISION, "pinned main"),
      ],
      sources: ["public/css/app.css", "public/index.html", "public/usernode-native/v1/demo.html"],
    }),
    manifestClaim({
      id: "R2", slideId: "token-authority-demo",
      statement: "A temporary-directory token generation propagates one valid edit and refuses an inverted Canvas-to-Paper ladder.",
      metrics: [
        metric("guardedInvalidMutations", facts.guardedInvalidMutations, "guarded mutations", tokenAuthorityRevision, "D1 token check"),
        metric("validPrimaryLightness", 0.32, "OKLCH lightness", tokenAuthorityRevision, "temporary generator"),
        metric("validPrimaryChroma", 0.08, "OKLCH chroma", tokenAuthorityRevision, "temporary generator"),
        metric("validPrimaryHue", 255, "degrees", tokenAuthorityRevision, "temporary generator"),
        metric("invalidPaperLightness", 0.94, "OKLCH lightness", tokenAuthorityRevision, "temporary generator"),
        metric("rejectedLightnessStep", -0.01, "OKLCH lightness", tokenAuthorityRevision, "temporary generator"),
        metric("minimumLightnessStep", 0.02, "OKLCH lightness", tokenAuthorityRevision, "temporary generator"),
        metric("temporaryWorkingDirectory", true, "boolean", tokenAuthorityRevision, "temporary generator"),
        metric("canonicalTokenSha256", tokenDemo.canonicalSha256, "SHA-256 digest", tokenAuthorityRevision, "token authority"),
      ],
      sources: ["frontend/design-system/tokens.json", "frontend/scripts/check-design-tokens.mjs", "frontend/scripts/design-token-tools.mjs"],
    }),
    manifestClaim({
      id: "R3", slideId: "verification-files",
      statement: `The integrated branch retains all ${facts.base.rootNodeTestFiles} pinned-main root Node test files, adds ${facts.branch.rootNodeTestFiles - facts.base.rootNodeTestFiles}, and passes ${facts.gate.serverTestsPassed} root tests.`,
      metrics: [
        metric("baseRootNodeTestFiles", facts.base.rootNodeTestFiles, "root Node test files", PR_CASE_BASE_REVISION, "pinned main"),
        metric("branchRootNodeTestFiles", facts.branch.rootNodeTestFiles, "root Node test files", PR_CASE_BRANCH_REVISION, "integrated branch"),
        metric("retainedBaseRootNodeTestFiles", facts.branch.retainedBaseTestFiles, "root Node test files", PR_CASE_BRANCH_REVISION, "base-path retention"),
        metric("removedBaseRootNodeTestFiles", facts.branch.removedBaseTestFiles, "root Node test files", PR_CASE_BRANCH_REVISION, "base-path retention"),
        metric("rootTestsPassed", facts.gate.serverTestsPassed, "root tests", PR_CASE_BRANCH_REVISION, "integration receipt"),
      ],
      sources: ["tests/", "docs/pr-case/receipts/integration.json"],
    }),
    manifestClaim({
      id: "R4", slideId: "verification-category",
      statement: `The branch carries ${facts.branch.storyFiles} Storybook story files and a ${facts.gate.stages}-stage receipt-grade gate.`,
      metrics: [
        metric("storybookStoryFiles", facts.branch.storyFiles, "Storybook story files", PR_CASE_BRANCH_REVISION, "integrated branch"),
        metric("gateStages", facts.gate.stages, "gate stages", PR_CASE_BRANCH_REVISION, "integration receipt"),
        metric("receiptGrade", facts.gate.receiptGrade, "boolean", PR_CASE_BRANCH_REVISION, "integration receipt"),
      ],
      sources: ["frontend/@/", "docs/pr-case/receipts/integration.json"],
    }),
    manifestClaim({
      id: "R5", slideId: "surface-grammar",
      statement: `${facts.branch.catalogComponents} catalog entries expose the component inventory across ${facts.branch.catalogTierCount} explicit tiers.`,
      metrics: [
        metric("catalogComponents", facts.branch.catalogComponents, "catalog entries", PR_CASE_BRANCH_REVISION, "integrated branch"),
        metric("catalogTiers", facts.branch.catalogTierCount, "catalog tiers", PR_CASE_BRANCH_REVISION, "integrated branch"),
        metric("elementTierComponents", facts.branch.catalogTiers.element, "catalog entries", PR_CASE_BRANCH_REVISION, "element tier"),
        metric("blockTierComponents", facts.branch.catalogTiers.block, "catalog entries", PR_CASE_BRANCH_REVISION, "block tier"),
        metric("featureTierComponents", facts.branch.catalogTiers.feature, "catalog entries", PR_CASE_BRANCH_REVISION, "feature tier"),
      ],
      sources: ["frontend/design-system/catalog.json", "frontend/design-system/interface-laws.md"],
    }),
    manifestClaim({
      id: "R6", slideId: "legacy-interface-loop",
      statement: `Pinned main has ${facts.base.rootNodeTestFiles} root Node test files and zero component-isolated Storybook files.`,
      metrics: [
        metric("baseRootNodeTestFiles", facts.base.rootNodeTestFiles, "root Node test files", PR_CASE_BASE_REVISION, "pinned main"),
        metric("baseComponentStoryFiles", facts.base.componentStoryFiles, "Storybook story files", PR_CASE_BASE_REVISION, "pinned main"),
      ],
      sources: ["tests/", "frontend/design-system/"],
    }),
    manifestClaim({
      id: "R7", slideId: "lean-mechanical-loop",
      statement: `Component-review context is ${facts.context.componentReviewBytes} bytes under a ${facts.context.componentReviewRatchetBytes}-byte ratchet and ${facts.context.ownerCeilingBytes}-byte owner ceiling.`,
      metrics: [
        metric("alwaysLoadedBytes", facts.context.alwaysLoadedBytes, "bytes", contextAuthorityRevision, "current projection"),
        metric("alwaysLoadedRatchetBytes", facts.context.alwaysLoadedRatchetBytes, "bytes", contextAuthorityRevision, "current projection"),
        metric("componentReviewBytes", facts.context.componentReviewBytes, "bytes", contextAuthorityRevision, "current projection"),
        metric("componentReviewRatchetBytes", facts.context.componentReviewRatchetBytes, "bytes", contextAuthorityRevision, "current projection"),
        metric("ownerCeilingBytes", facts.context.ownerCeilingBytes, "bytes", contextAuthorityRevision, "owner policy"),
      ],
      sources: ["frontend/design-system/context-budget.json", "frontend/scripts/check-progressive-context.mjs", "frontend/scripts/check-context-budget.mjs"],
    }),
    manifestClaim({
      id: "R8", slideId: "harness-integrity",
      statement: `${facts.gate.passed} of ${facts.gate.stages} gate stages passed at one clean immutable source revision.`,
      metrics: [
        metric("passedGateStages", facts.gate.passed, "gate stages", PR_CASE_BRANCH_REVISION, "integration receipt"),
        metric("totalGateStages", facts.gate.stages, "gate stages", PR_CASE_BRANCH_REVISION, "integration receipt"),
        metric("skippedGateStages", facts.gate.skipped, "gate stages", PR_CASE_BRANCH_REVISION, "integration receipt"),
        metric("omittedGateStages", facts.gate.omitted, "gate stages", PR_CASE_BRANCH_REVISION, "integration receipt"),
        metric("sourceStable", facts.gate.sourceStart === facts.gate.sourceEnd, "boolean", PR_CASE_BRANCH_REVISION, "integration receipt"),
        metric("cleanStart", facts.gate.cleanStart, "boolean", PR_CASE_BRANCH_REVISION, "integration receipt"),
        metric("cleanEnd", facts.gate.cleanEnd, "boolean", PR_CASE_BRANCH_REVISION, "integration receipt"),
        metric("receiptGrade", facts.gate.receiptGrade, "boolean", PR_CASE_BRANCH_REVISION, "integration receipt"),
        metric("fullArtifactSha256", facts.gate.artifactSha256, "SHA-256 digest", PR_CASE_BRANCH_REVISION, "local artifact when present"),
      ],
      sources: ["docs/pr-case/receipts/integration.json"],
    }),
    manifestClaim({
      id: "R9", slideId: "regression-caught",
      statement: `${facts.gate.failedExactHeads} preserved exact-head failures caught integration defects before the clean ${facts.gate.passed}-stage receipt.`,
      metrics: [
        metric("preservedFailedArtifacts", facts.gate.failedExactHeads, "failed gate artifacts", PR_CASE_BRANCH_REVISION, "integration receipt"),
        metric("regressedAlwaysLoadedBytes", facts.gate.integrationAlwaysLoadedBytes, "bytes", "731921cf158ab1392881e0861135986f61d30611", "failed exact head"),
        metric("alwaysLoadedRatchetBytes", facts.gate.integrationAlwaysLoadedRatchetBytes, "bytes", "731921cf158ab1392881e0861135986f61d30611", "failed exact head"),
        metric("routedGuidanceBytes", facts.gate.routedGuidanceBytes, "bytes", "eb2a8059402d5e3db28ded64a5e0beafa59feb4d", "corrected exact head"),
        metric("cleanGateStages", facts.gate.passed, "gate stages", PR_CASE_BRANCH_REVISION, "integration receipt"),
      ],
      sources: ["docs/pr-case/receipts/integration.json"],
    }),
    manifestClaim({
      id: "R10", slideId: "costs-honestly",
      statement: `${facts.branch.checkScripts} check-prefixed package scripts and a ${facts.gate.stages}-stage gate are maintained infrastructure.`,
      metrics: [
        metric("checkPrefixedScriptNames", facts.branch.checkScripts, "package script names", PR_CASE_BRANCH_REVISION, "integrated branch"),
        metric("gateStages", facts.gate.stages, "gate stages", PR_CASE_BRANCH_REVISION, "integration receipt"),
        metric("canonicalTokenSources", facts.canonicalTokenSources, "token source files", tokenAuthorityRevision, "pinned design-system authority"),
      ],
      sources: ["frontend/package.json", "agent-skills/ui-development/workflows.json"],
    }),
    manifestClaim({
      id: "R11", slideId: "review-the-system",
      statement: `${facts.branch.provenanceCommits} of ${facts.branch.branchOnlyCommits} branch commits carry both task and origin-event trailers, pointing to ${facts.branch.provenanceEvents} distinct events.`,
      metrics: [
        metric("branchOnlyCommits", facts.branch.branchOnlyCommits, "commits", PR_CASE_BRANCH_REVISION, "base-to-branch range"),
        metric("provenanceCommits", facts.branch.provenanceCommits, "commits", PR_CASE_BRANCH_REVISION, "valid trailer grammar"),
        metric("distinctOriginEvents", facts.branch.provenanceEvents, "event identifiers", PR_CASE_BRANCH_REVISION, "valid 64-hex origins"),
      ],
      sources: ["docs/commit-grammar.md", ".githooks/commit-msg"],
    }),
    manifestClaim({
      id: "R12", slideId: "compatibility-evidence",
      statement: "Four pinned Home captures compare legacy / with staged React /react/ under one deterministic data fixture in light and dark themes.",
      metrics: [
        metric("captureImages", facts.capture.images, "capture images", captureAuthorityRevision, "capture manifest"),
        metric("captureWidth", facts.capture.width, "pixels", captureAuthorityRevision, "capture viewport"),
        metric("captureHeight", facts.capture.height, "pixels", captureAuthorityRevision, "capture viewport"),
        metric("captureThemes", facts.capture.themes, "themes", captureAuthorityRevision, "capture manifest"),
        metric("baseRoute", facts.capture.routes[0], "route", captureAuthorityRevision, "pinned main capture"),
        metric("branchRoute", facts.capture.routes[1], "route", captureAuthorityRevision, "integrated branch capture"),
        metric("baseRootNodeTestFiles", facts.base.rootNodeTestFiles, "root Node test files", PR_CASE_BASE_REVISION, "pinned main"),
        metric("branchRootNodeTestFiles", facts.branch.rootNodeTestFiles, "root Node test files", PR_CASE_BRANCH_REVISION, "integrated branch"),
        metric("retainedBaseRootNodeTestFiles", facts.branch.retainedBaseTestFiles, "root Node test files", PR_CASE_BRANCH_REVISION, "base-path retention"),
        metric("removedBaseRootNodeTestFiles", facts.branch.removedBaseTestFiles, "root Node test files", PR_CASE_BRANCH_REVISION, "base-path retention"),
      ],
      sources: ["docs/pr-case/capture-manifest.json", "docs/pr-case/images/"],
    }),
    manifestClaim({
      id: "R13", slideId: "surface-size-contrast",
      statement: `${facts.surfaceSize.legacy.total.files} legacy shell files carry ${facts.surfaceSize.legacy.total.lines} physical lines; the staged React front end carries ${facts.surfaceSize.react.total.files} files and ${facts.surfaceSize.react.total.lines} physical lines excluding its lockfile.`,
      metrics: [
        metric("legacyMarkupFiles", facts.surfaceSize.legacy.markup.files, "files", PR_CASE_BASE_REVISION, "legacy HTML"),
        metric("legacyMarkupLines", facts.surfaceSize.legacy.markup.lines, "physical lines", PR_CASE_BASE_REVISION, "legacy HTML"),
        metric("legacyStyleFiles", facts.surfaceSize.legacy.styling.files, "files", PR_CASE_BASE_REVISION, "legacy CSS"),
        metric("legacyStyleLines", facts.surfaceSize.legacy.styling.lines, "physical lines", PR_CASE_BASE_REVISION, "legacy CSS"),
        metric("legacyScriptFiles", facts.surfaceSize.legacy.scripts.files, "files", PR_CASE_BASE_REVISION, "legacy JavaScript"),
        metric("legacyScriptLines", facts.surfaceSize.legacy.scripts.lines, "physical lines", PR_CASE_BASE_REVISION, "legacy JavaScript"),
        metric("legacyTotalFiles", facts.surfaceSize.legacy.total.files, "files", PR_CASE_BASE_REVISION, "legacy shell"),
        metric("legacyTotalLines", facts.surfaceSize.legacy.total.lines, "physical lines", PR_CASE_BASE_REVISION, "legacy shell"),
        metric("reactProductFiles", facts.surfaceSize.react.product.files, "files", PR_CASE_BRANCH_REVISION, "React product source"),
        metric("reactProductLines", facts.surfaceSize.react.product.lines, "physical lines", PR_CASE_BRANCH_REVISION, "React product source"),
        metric("reactProofFiles", facts.surfaceSize.react.proof.files, "files", PR_CASE_BRANCH_REVISION, "React stories, tests, harness and design system"),
        metric("reactProofLines", facts.surfaceSize.react.proof.lines, "physical lines", PR_CASE_BRANCH_REVISION, "React stories, tests, harness and design system"),
        metric("reactConfigurationFiles", facts.surfaceSize.react.configuration.files, "files", PR_CASE_BRANCH_REVISION, "React configuration and manifests"),
        metric("reactConfigurationLines", facts.surfaceSize.react.configuration.lines, "physical lines", PR_CASE_BRANCH_REVISION, "React configuration and manifests"),
        metric("reactTotalFiles", facts.surfaceSize.react.total.files, "files", PR_CASE_BRANCH_REVISION, "React front end excluding package-lock.json"),
        metric("reactTotalLines", facts.surfaceSize.react.total.lines, "physical lines", PR_CASE_BRANCH_REVISION, "React front end excluding package-lock.json"),
      ],
      sources: ["public/", "frontend/"],
    }),
    manifestClaim({
      id: "R14", slideId: "staged-route-shape",
      statement: `The legacy proposal address ${facts.routeShape.legacyExample} becomes ${facts.routeShape.reactExample} in the staged React shell, whose router basename is ${facts.routeShape.basename}.`,
      metrics: [
        metric("reactBasename", facts.routeShape.basename, "route prefix", PR_CASE_BRANCH_REVISION, "React router"),
        metric("proposalRoutePattern", facts.routeShape.proposalPattern, "route pattern", PR_CASE_BRANCH_REVISION, "React router"),
        metric("legacyExample", facts.routeShape.legacyExample, "address path", PR_CASE_BRANCH_REVISION, "legacy compatibility route"),
        metric("reactExample", facts.routeShape.reactExample, "address path", PR_CASE_BRANCH_REVISION, "staged React route"),
        metric("reactProposalReadsVotesAndKudos", true, "boolean", PR_CASE_BRANCH_REVISION, "proposal detail implementation"),
        metric("legacyProposalModerationFallback", true, "boolean", PR_CASE_BRANCH_REVISION, "proposal detail implementation"),
      ],
      sources: ["frontend/src/main.tsx", "frontend/@/lib/routes.ts", "frontend/@/features/dev/dev-proposal-detail.tsx"],
    }),
  ]

  return {
    schemaVersion: 2,
    generatedFrom: {
      comparisonBaseRevision: PR_CASE_BASE_REVISION,
      comparisonBranchRevision: PR_CASE_BRANCH_REVISION,
      projectionAuthority: {
        tokenHarness: tokenAuthorityRevision,
        contextHarness: contextAuthorityRevision,
        capture: captureAuthorityRevision,
      },
    },
    facts,
    claims,
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly && process.argv.includes("--probe")) {
  const base = process.argv[process.argv.indexOf("--base") + 1]
  const branch = process.argv[process.argv.indexOf("--branch") + 1]
  if (base !== PR_CASE_BASE_REVISION || branch !== PR_CASE_BRANCH_REVISION) {
    throw new Error("probe revisions must match the full pinned comparison revisions")
  }
  const id = process.argv[process.argv.indexOf("--probe") + 1]
  const claim = collectPrCaseEvidence().claims.find((item) => item.id === id)
  if (!claim) throw new Error(`unknown pull-request case probe: ${id}`)
  console.log(JSON.stringify({ id: claim.id, metrics: claim.metrics }, null, 2))
}
