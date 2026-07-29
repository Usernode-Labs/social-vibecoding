import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = path.resolve(frontendRoot, "..")
const requireReady = process.argv.includes("--require-ready")

function source(relativeToRepo) {
  return fs.readFileSync(path.join(repositoryRoot, relativeToRepo), "utf8")
}

function frontendSource(relativeToFrontend) {
  return fs.readFileSync(path.join(frontendRoot, relativeToFrontend), "utf8")
}

const server = source("server.js")
const vite = frontendSource("vite.config.ts")
const entry = frontendSource("src/main.tsx")
const reactServiceWorkerRegistration = frontendSource("src/react-service-worker.ts")
const hostedApp = frontendSource("@/features/apps/hosted-app.tsx")
const bridge = frontendSource("@/lib/native-bridge.ts")
const serviceWorker = source("public/sw.js")
const reactServiceWorker = frontendSource("public/react-sw.js")
const nativeBridgeFixture = frontendSource("tests/native-bridge-contract.spec.ts")
const nativeBridgeFixtureData = frontendSource("tests/fixtures/native-bridge.ts")

const checks = [
  {
    id: "react-history-fallback",
    detail: "Express serves the compiled React document for every /react history path.",
    ok: /app\.get\(\[\s*['"]\/react['"]\s*,\s*['"]\/react\/\*['"]\s*\]/.test(server),
  },
  {
    id: "react-offline-worker-contract",
    detail: "React registers a separately-versioned /react/-scoped, shell-only worker without expanding the legacy worker's cache scope.",
    ok: /navigator\.serviceWorker\.register/.test(reactServiceWorkerRegistration)
      && /scope:\s*import\.meta\.env\.BASE_URL/.test(reactServiceWorkerRegistration)
      && /CACHE_PREFIX = "usernode-react-shell-"/.test(reactServiceWorker)
      && /authenticated API responses, iframe[\s\S]*credentials, event streams/.test(reactServiceWorker)
      && /request\.mode === "navigate"/.test(reactServiceWorker),
  },
  {
    id: "react-asset-base",
    detail: "The built bundle uses /react/ paths instead of shadowing the legacy root shell.",
    ok: /base:\s*["']\/react\/["']/.test(vite),
  },
  {
    id: "hosted-iframe-sandbox",
    detail: "Hosted child apps retain the legacy iframe sandbox allowances.",
    ok: /sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-pointer-lock"/.test(hostedApp),
  },
  {
    id: "hosted-iframe-token-refresh",
    detail: "The React host still obtains the short-lived iframe token through its typed adapter and refreshes it.",
    ok: /getIframeToken/.test(hostedApp) && /TOKEN_REFRESH_MS/.test(hostedApp),
  },
  {
    id: "hosted-deep-link-validation",
    detail: "The host refuses an unsafe inner iframe path before assigning src.",
    ok: /function validInnerPath/.test(hostedApp) && /source\.origin !== origin/.test(hostedApp),
  },
  {
    id: "native-title-bridge",
    detail: "The page can still signal titleChanged through Flutter's Usernode channel.",
    ok: /Usernode/.test(bridge) && /titleChanged/.test(bridge),
  },
  {
    id: "native-capability-fixtures",
    detail: "Fixture-backed browser checks cover desktop absence, old-build capability gating, current v3 reads, and malformed discovery failure.",
    ok: /old-native-build/.test(nativeBridgeFixtureData)
      && /current-native-build/.test(nativeBridgeFixtureData)
      && /malformed capability response is fail-closed/.test(nativeBridgeFixture),
  },
  {
    id: "legacy-offline-safety",
    detail: "The existing service worker bypasses iframe credentials and SSE, and clears cached API data on logout.",
    ok: /p === '\/api\/iframe-token'/.test(serviceWorker)
      && /text\\\/event-stream/.test(serviceWorker)
      && /clear-api-cache/.test(serviceWorker)
      && /api\/auth\/logout/.test(serviceWorker),
  },
]

const blockers = []

if (!/navigator\.serviceWorker\.register/.test(reactServiceWorkerRegistration) || !/CACHE_PREFIX = "usernode-react-shell-"/.test(reactServiceWorker)) {
  blockers.push({
    id: "react-service-worker-scope",
    detail: "React needs a separately-versioned /react/-scoped shell worker; do not expand the legacy root worker's cache scope.",
  })
}

if (!/webview_flutter|WKWebView|Usernode JS-channel/i.test(frontendSource("AGENTS.md"))) {
  blockers.push({
    id: "native-webview-e2e",
    detail: "No executable Flutter WebView contract is wired into the React test command. A real iOS/Android run still must prove cookies, Usernode bridge timing, browser history, and App-Bound-Domain navigation.",
  })
}

const failed = checks.filter((check) => !check.ok)
const report = {
  status: failed.length || blockers.length ? "not-ready" : "ready",
  verified: checks.filter((check) => check.ok).map(({ id, detail }) => ({ id, detail })),
  failed: failed.map(({ id, detail }) => ({ id, detail })),
  blockers,
}

console.log(JSON.stringify(report, null, 2))

if (failed.length || (requireReady && blockers.length)) process.exit(1)
