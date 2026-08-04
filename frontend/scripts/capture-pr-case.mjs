import { execFileSync, spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import zlib from "node:zlib"

import { chromium } from "playwright"
import { PNG } from "pngjs"

import { PR_CASE_BASE_REVISION, PR_CASE_BRANCH_REVISION } from "./pr-case-tools.mjs"

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = path.resolve(frontendRoot, "..")
const outputRoot = path.join(repoRoot, "docs", "pr-case")
const imageRoot = path.join(outputRoot, "images")
const fixtureRoot = path.join(outputRoot, "capture-fixtures")
const legacyPort = 4381
const reactPort = 4382

const user = { id: 7, username: "ava", canAdminWrite: true, isAdmin: false }
const apps = {
  apps: [
    {
      id: "recipebot", slug: "recipebot", name: "RecipeBot", status: "running",
      tagline: "Find a recipe for what you have at home", description: null,
      active_users: 24, is_favorited: true, is_collaborator: true,
      your_apps_hidden: false, favorite_order: 0, open_prs: 0,
      active_sessions: 0, open_issues: 0, icon_url: null,
    },
    {
      id: "game-corner", slug: "game-corner", name: "Game Corner", status: "building",
      tagline: "A daily puzzle for the community", description: null,
      active_users: 8, is_favorited: false, is_collaborator: false,
      your_apps_hidden: false, favorite_order: null, open_prs: 0,
      active_sessions: 0, open_issues: 0, icon_url: null,
    },
    {
      id: "pantry-planner", slug: "pantry-planner", name: "Pantry Planner", status: "running",
      tagline: "Keep ingredients organised", description: null,
      active_users: 6, is_favorited: true, is_collaborator: false,
      your_apps_hidden: false, favorite_order: 1, open_prs: 0,
      active_sessions: 0, open_issues: 0, icon_url: null,
    },
  ],
}
const notifications = { notifications: [], unread: 0, pendingInvites: [], hasMore: false, nextBefore: null }
const apiFixture = {
  authMe: { user },
  apps,
  notifications,
  version: { sha: PR_CASE_BRANCH_REVISION },
  nodeStatus: { status: "synced" },
  nodeStatusFull: { status: "synced", node: { status: "running" } },
  models: { models: [], default: "" },
  kudosBudget: { remaining: 8, limit: 10, spent: 2 },
  aiBudget: { limitCents: 500, remainingCents: 500, spentCents: 0, byokCents: 0 },
  activeSessions: { sessions: [] },
  proposals: { proposals: [], governance: [] },
  wallet: { error: "not available in fixture" },
  health: { status: "ok" },
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function stabilizeRaster(candidatePath, outputPath) {
  const boundary = { maxChannelDelta: 40, maxChangedPixelRatio: 0.001 }
  if (!fs.existsSync(outputPath)) {
    fs.renameSync(candidatePath, outputPath)
    return { boundary, observation: { retainedExisting: false, reason: "no-existing-raster" } }
  }
  const existing = PNG.sync.read(fs.readFileSync(outputPath))
  const candidate = PNG.sync.read(fs.readFileSync(candidatePath))
  if (existing.width !== candidate.width || existing.height !== candidate.height) {
    fs.renameSync(candidatePath, outputPath)
    return { boundary, observation: { retainedExisting: false, reason: "dimensions-changed" } }
  }
  let changedPixels = 0
  let observedMaxChannelDelta = 0
  for (let pixel = 0; pixel < existing.width * existing.height; pixel += 1) {
    let pixelChanged = false
    for (let channel = 0; channel < 4; channel += 1) {
      const index = pixel * 4 + channel
      const delta = Math.abs(existing.data[index] - candidate.data[index])
      observedMaxChannelDelta = Math.max(observedMaxChannelDelta, delta)
      if (delta) pixelChanged = true
    }
    if (pixelChanged) changedPixels += 1
  }
  const changedPixelRatio = changedPixels / (existing.width * existing.height)
  const retainExisting = changedPixelRatio <= boundary.maxChangedPixelRatio
    && observedMaxChannelDelta <= boundary.maxChannelDelta
  if (retainExisting) fs.unlinkSync(candidatePath)
  else fs.renameSync(candidatePath, outputPath)
  return {
    boundary,
    observation: { retainedExisting: retainExisting, changedPixels, changedPixelRatio, observedMaxChannelDelta },
  }
}

function git(args, options = {}) {
  return execFileSync("git", args, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024, ...options })
}

function verifySelectedLegacyEquivalence() {
  const exactPaths = [
    "public/index.html",
    "public/css/app.css",
    "public/js/app.js",
    "public/js/home.js",
    "public/js/theme.js",
    "public/js/browse.js",
    "public/usernode-native/v1/native.css",
    "public/usernode-native/v1/native.js",
  ]
  try {
    git(["diff", "--quiet", PR_CASE_BASE_REVISION, PR_CASE_BRANCH_REVISION, "--", ...exactPaths], { stdio: "ignore" })
  } catch {
    throw new Error("selected legacy Home equivalence assertions differ between the pinned base and branch revisions")
  }
  return exactPaths
}

function extractLegacySource() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "usernode-pr-case-"))
  const archivePath = path.join(temporaryRoot, "public.tar")
  fs.writeFileSync(archivePath, git(["archive", "--format=tar", PR_CASE_BASE_REVISION, "public"]))
  execFileSync("tar", ["-xf", archivePath, "-C", temporaryRoot])
  return temporaryRoot
}

function start(command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  child.stdout.on("data", (chunk) => { output += chunk.toString() })
  child.stderr.on("data", (chunk) => { output += chunk.toString() })
  child.output = () => output
  return child
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`capture server exited early:\n${child.output()}`)
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`capture server did not become ready: ${url}\n${child.output()}`)
}

async function stop(child) {
  if (child.exitCode !== null) return
  child.kill("SIGTERM")
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ])
  if (child.exitCode === null) child.kill("SIGKILL")
}

async function installRoutes(page, tailwindPlay, errors) {
  await page.route("https://cdn.tailwindcss.com/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/javascript; charset=utf-8",
    body: tailwindPlay,
  }))
  await page.route(/^https:\/\/(?:cdn\.jsdelivr\.net|raw\.githubusercontent\.com)\//, (route) => route.abort())
  const rootBootAssets = {
    "/react/usernode-bridge.js": "public/usernode-bridge.js",
    "/react/js/dev-host.js": "public/js/dev-host.js",
    "/react/js/offline.js": "public/js/offline.js",
  }
  for (const [requestPath, sourcePath] of Object.entries(rootBootAssets)) {
    await page.route(`**${requestPath}`, (route) => route.fulfill({
      status: 200,
      contentType: "text/javascript; charset=utf-8",
      body: fs.readFileSync(path.join(repoRoot, sourcePath)),
    }))
  }
  await page.route("**/health", (route) => route.fulfill({ json: apiFixture.health }))
  await page.route("**/api/**", (route) => {
    const requestUrl = new URL(route.request().url())
    if (requestUrl.pathname === "/api/auth/me") return route.fulfill({ json: apiFixture.authMe })
    if (requestUrl.pathname === "/api/apps") return route.fulfill({ json: apiFixture.apps })
    if (requestUrl.pathname === "/api/notifications") return route.fulfill({ json: apiFixture.notifications })
    if (requestUrl.pathname === "/api/version") return route.fulfill({ json: apiFixture.version })
    if (requestUrl.pathname === "/api/node-status") return route.fulfill({ json: apiFixture.nodeStatus })
    if (requestUrl.pathname === "/api/node-status/full") return route.fulfill({ json: apiFixture.nodeStatusFull })
    if (requestUrl.pathname === "/api/models") return route.fulfill({ json: apiFixture.models })
    if (requestUrl.pathname === "/api/me/kudos-budget") return route.fulfill({ json: apiFixture.kudosBudget })
    if (requestUrl.pathname === "/api/me/ai-budget") return route.fulfill({ json: apiFixture.aiBudget })
    if (requestUrl.pathname === "/api/me/active-sessions") return route.fulfill({ json: apiFixture.activeSessions })
    if (requestUrl.pathname === "/api/me/proposals") return route.fulfill({ json: apiFixture.proposals })
    if (requestUrl.pathname === "/api/wallet") return route.fulfill({ status: 404, json: apiFixture.wallet })
    errors.push(`fixture has no response for ${requestUrl.pathname}`)
    return route.fulfill({ status: 404, json: { error: `fixture has no response for ${requestUrl.pathname}` } })
  })
}

async function settle(page) {
  await page.addStyleTag({ content: `
    *, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      caret-color: transparent !important;
      scroll-behavior: auto !important;
    }
  ` })
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
}

async function capture(browser, { name, url, route, theme, before, tailwindPlay }) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: theme,
    serviceWorkers: "block",
  })
  await context.addInitScript((selectedTheme) => {
    window.localStorage.setItem("theme", selectedTheme)
    class CaptureWebSocket extends EventTarget {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3
      readyState = CaptureWebSocket.CONNECTING
      constructor(url) {
        super()
        this.url = String(url)
        setTimeout(() => {
          this.readyState = CaptureWebSocket.OPEN
          this.dispatchEvent(new Event("open"))
          this.onopen?.(new Event("open"))
        }, 0)
      }
      send() {}
      close() {
        this.readyState = CaptureWebSocket.CLOSED
        this.dispatchEvent(new CloseEvent("close"))
        this.onclose?.(new CloseEvent("close"))
      }
    }
    window.WebSocket = CaptureWebSocket
  }, theme)
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text())
  })
  page.on("requestfailed", (request) => {
    const url = request.url()
    if (/^https:\/\/(?:cdn\.jsdelivr\.net|raw\.githubusercontent\.com)\//.test(url)) return
    if (request.failure()?.errorText === "net::ERR_ABORTED" && new URL(url).pathname.startsWith("/api/")) return
    errors.push(`request failed: ${url} (${request.failure()?.errorText || "unknown"})`)
  })
  page.on("response", (response) => {
    const url = new URL(response.url())
    if (response.status() >= 400 && !(url.pathname === "/api/wallet" && response.status() === 404)) {
      errors.push(`unexpected response ${response.status()}: ${url.pathname}`)
    }
  })
  await installRoutes(page, tailwindPlay, errors)
  await page.goto(url, { waitUntil: "domcontentloaded" })
  if (before) {
    await page.locator('.app-card[data-yours="true"]').first().waitFor({ state: "visible", timeout: 20_000 })
    await page.waitForFunction(() => document.querySelectorAll('.app-card[data-yours="true"]').length >= 2)
  } else {
    await page.getByRole("heading", { name: "Home", exact: true }).waitFor({ state: "visible", timeout: 20_000 })
    await page.getByTestId("home-app-shortcut-recipebot").waitFor({ state: "visible" })
  }
  await settle(page)
  const bodyFontFamily = await page.evaluate(() => getComputedStyle(document.body).fontFamily)
  const outputPath = path.join(imageRoot, `${name}-${theme}.png`)
  const candidatePath = path.join(imageRoot, `.${name}-${theme}.candidate.png`)
  await page.screenshot({ path: candidatePath, fullPage: false })
  if (errors.length) {
    fs.unlinkSync(candidatePath)
    throw new Error(`${name}-${theme} emitted browser errors:\n${errors.join("\n")}`)
  }
  const { boundary: rasterBoundary, observation } = stabilizeRaster(candidatePath, outputPath)
  console.log(`${name}-${theme}: raster ${observation.retainedExisting ? "retained" : "replaced"} (${observation.reason || `${observation.changedPixels} changed pixels; maximum channel delta ${observation.observedMaxChannelDelta}`})`)
  await context.close()
  return {
    file: path.relative(outputRoot, outputPath),
    sha256: sha256(fs.readFileSync(outputPath)),
    width: 1280,
    height: 720,
    route,
    theme,
    bodyFontFamily,
    rasterBoundary,
  }
}

const legacyPathsVerifiedUnchangedBetweenRevisions = verifySelectedLegacyEquivalence()
const tailwindFixturePath = path.join(fixtureRoot, "tailwind-play-2026-08-04.js.gz")
if (!fs.existsSync(tailwindFixturePath)) {
  throw new Error(`missing frozen Tailwind capture fixture: ${path.relative(repoRoot, tailwindFixturePath)}`)
}
const tailwindPlay = zlib.gunzipSync(fs.readFileSync(tailwindFixturePath))
const temporaryRoot = extractLegacySource()
const legacyServer = start("python3", ["-m", "http.server", String(legacyPort), "--bind", "127.0.0.1", "--directory", path.join(temporaryRoot, "public")], repoRoot)
const reactServer = start("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(reactPort)], frontendRoot)

try {
  fs.mkdirSync(imageRoot, { recursive: true })
  await Promise.all([
    waitForServer(`http://127.0.0.1:${legacyPort}/`, legacyServer),
    waitForServer(`http://127.0.0.1:${reactPort}/react/`, reactServer),
  ])
  const browser = await chromium.launch()
  try {
    const captures = []
    for (const theme of ["light", "dark"]) {
      captures.push(await capture(browser, {
        name: "home-before", theme, before: true, tailwindPlay,
        route: "/",
        url: `http://127.0.0.1:${legacyPort}/`,
      }))
      captures.push(await capture(browser, {
        name: "home-after", theme, before: false, tailwindPlay,
        route: "/react/",
        url: `http://127.0.0.1:${reactPort}/react/`,
      }))
    }
    const provenance = {
      schemaVersion: 1,
      revisions: { base: PR_CASE_BASE_REVISION, branch: PR_CASE_BRANCH_REVISION },
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      environment: { locale: "en-US", timezone: "UTC", serviceWorkers: "blocked" },
      runtime: {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
        playwright: JSON.parse(fs.readFileSync(path.join(frontendRoot, "node_modules", "playwright", "package.json"), "utf8")).version,
        chromium: browser.version(),
      },
      legacyPathsVerifiedUnchangedBetweenRevisions,
      networkPolicy: {
        tailwindBrowserCompiler: "frozen-fixture",
        applicationProgrammingInterface: "deterministic-fixture",
        serviceWorkers: "blocked",
        blockedExternalPrefixes: [
          "https://cdn.jsdelivr.net/",
          "https://raw.githubusercontent.com/",
        ],
      },
      fixture: apiFixture,
      fixtureSha256: sha256(JSON.stringify(apiFixture)),
      tailwindPlaySha256: sha256(tailwindPlay),
      tailwindPlayGzipSha256: sha256(fs.readFileSync(tailwindFixturePath)),
      captures,
    }
    fs.writeFileSync(path.join(outputRoot, "capture-manifest.json"), `${JSON.stringify(provenance, null, 2)}\n`)
    console.log(`Captured ${captures.length} pinned Home comparison images.`)
  } finally {
    await browser.close()
  }
} finally {
  await Promise.all([stop(legacyServer), stop(reactServer)])
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
}
