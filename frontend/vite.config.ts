import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const REACT_SHELL_REVISION_PLACEHOLDER = "__USERNODE_REACT_SHELL_BUILD_REVISION__";
const REACT_SHELL_BOOT_ASSETS_PLACEHOLDER = "__USERNODE_REACT_SHELL_BOOT_ASSETS__";
const reactOutputDir = path.resolve(dirname, "../public/react");
const rootPublicDir = path.resolve(dirname, "../public");
const rootBootAssets = [
  "/usernode-bridge.js",
  "/js/dev-host.js",
  "/js/offline.js",
] as const;

const SAFE_PRODUCTION_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type ProductionWriteScope = {
  apiTarget: string;
  appSlug: string | null;
  readOnly: boolean;
};

function jsonError(response: import("node:http").ServerResponse, status: number, error: string) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ error }));
}

function pathForApp(pathname: string, appSlug: string) {
  const encodedSlug = encodeURIComponent(appSlug);
  return pathname === `/api/apps/${encodedSlug}` || pathname.startsWith(`/api/apps/${encodedSlug}/`);
}

function isScopedFeedbackRequest(requestUrl: string, appSlug: string) {
  const url = new URL(requestUrl, "http://local.usernode")
  return url.pathname === "/api/feedback" && url.searchParams.get("app") === appSlug
}

/**
 * The normal HTTP middleware cannot inspect WebSocket upgrades. Keep the
 * local production-review/write-scope promise true for group-chat sockets as
 * well: only the selected app can receive a writable chat proxy, while the
 * global events socket remains a read-only subscription.
 */
function allowScopedWebSocket(requestUrl: string | undefined, scope: ProductionWriteScope) {
  if (!requestUrl) return false
  const pathname = requestUrl.split("?")[0]
  if (!pathname.startsWith("/ws/chat/")) return true
  if (scope.readOnly) return false
  if (!scope.appSlug) return true
  return pathname === `/ws/chat/${encodeURIComponent(scope.appSlug)}`
}

async function sessionBelongsToScopedApp(request: import("node:http").IncomingMessage, apiTarget: string, sessionId: string, appSlug: string) {
  const url = new URL(`/api/sessions/${encodeURIComponent(sessionId)}`, apiTarget);
  const headers = new Headers();
  const cookie = request.headers.cookie;
  if (cookie) headers.set("cookie", cookie);
  const authorization = request.headers.authorization;
  if (authorization) headers.set("authorization", authorization);

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return false;
    const payload = await response.json() as { session?: { app_slug?: unknown } };
    return payload.session?.app_slug === appSlug;
  } catch {
    return false;
  }
}

/**
 * A deliberately local-only safety valve for exercising real Dev actions.
 *
 * `SV_PRODUCTION_READONLY=true` remains the default review mode. Setting
 * `SV_PRODUCTION_WRITE_APP_SLUG` instead permits writes only for that app's
 * `/api/apps/:slug/*` endpoints and sessions which the production API itself
 * confirms belong to that app. Every other mutation is rejected before proxy.
 */
function productionApiGuard(scope: ProductionWriteScope): Plugin {
  return {
    name: "production-api-scope-guard",
    configureServer(server) {
      if (!scope.readOnly && !scope.appSlug) return;
      server.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith("/api/")) return next();
        const authPath = request.url.split("?")[0];
        const isSessionAuth = request.method === "POST" && (authPath === "/api/auth/login" || authPath === "/api/auth/logout");
        if (isSessionAuth || SAFE_PRODUCTION_METHODS.has(request.method ?? "GET")) return next();

        if (scope.readOnly) {
          return jsonError(response, 405, "Production API is read-only in the local React review.");
        }

        const pathname = request.url.split("?")[0];
        if (scope.appSlug && pathForApp(pathname, scope.appSlug)) return next();

        // Feedback is a write to an app repository, but the canonical API is
        // intentionally global (`/api/feedback`). Permit it only when the
        // React client has explicitly selected the same app as this local
        // write scope; the API still verifies the body and authorisation.
        if (scope.appSlug && isScopedFeedbackRequest(request.url, scope.appSlug)) return next();

        const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/|$)/);
        if (scope.appSlug && sessionMatch && await sessionBelongsToScopedApp(request, scope.apiTarget, sessionMatch[1], scope.appSlug)) {
          return next();
        }

        return jsonError(response, 403, `Local production writes are limited to Dev sessions for ${scope.appSlug}.`);
      });
    },
  };
}

function filesBelow(directory: string) {
  const results: string[] = [];
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else results.push(target);
    }
  };
  visit(directory);
  return results.sort();
}

function isBootAsset(relativePath: string) {
  return relativePath === "app-shortcut-contract.js"
    || relativePath.startsWith("assets/")
      && /\.(?:css|js|mjs|woff2?|ttf|svg|png|webp|ico)$/i.test(relativePath);
}

function validatedExplicitRevision(value: string | undefined) {
  const revision = value?.trim();
  if (!revision) return null;
  if (revision.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(revision)) {
    throw new Error("SV_REACT_SHELL_REVISION must be a stable 1-128 character build identifier.");
  }
  return revision;
}

/**
 * Finalizes one already-emitted Vite artifact. With no explicit immutable
 * deployment id, the revision is the deterministic digest of the generated
 * artifact and its required root runtimes—never wall-clock time or entropy.
 */
function reactShellArtifactPlugin(explicitRevision: string | null): Plugin {
  let targetsReactShellOutput = false;

  return {
    name: "react-shell-artifact-contract",
    apply: "build",
    configResolved(config) {
      targetsReactShellOutput = path.resolve(config.build.outDir) === reactOutputDir;
    },
    closeBundle() {
      // Storybook imports this Vite config but writes a separate catalog
      // artifact. Only the deployable React shell owns this worker contract.
      if (!targetsReactShellOutput) return;

      const workerPath = path.join(reactOutputDir, "react-sw.js");
      const outputFiles = filesBelow(reactOutputDir);
      const bootAssets = [
        "/react/",
        ...outputFiles
          .map((file) => path.relative(reactOutputDir, file).split(path.sep).join("/"))
          .filter(isBootAsset)
          .map((file) => `/react/${file}`),
        ...rootBootAssets,
      ];
      const uniqueBootAssets = [...new Set(bootAssets)].sort();
      const digest = crypto.createHash("sha256");
      for (const file of outputFiles) {
        digest.update(path.relative(reactOutputDir, file));
        digest.update("\0");
        digest.update(fs.readFileSync(file));
        digest.update("\0");
      }
      for (const asset of rootBootAssets) {
        const file = path.join(rootPublicDir, asset.slice(1));
        if (!fs.existsSync(file)) throw new Error(`Missing React shell root runtime: ${asset}`);
        digest.update(asset);
        digest.update("\0");
        digest.update(fs.readFileSync(file));
        digest.update("\0");
      }
      const revision = explicitRevision ?? `sha256-${digest.digest("hex").slice(0, 32)}`;
      const worker = fs.readFileSync(workerPath, "utf8");
      if (
        !worker.includes(REACT_SHELL_REVISION_PLACEHOLDER)
        || !worker.includes(REACT_SHELL_BOOT_ASSETS_PLACEHOLDER)
      ) {
        throw new Error("React shell worker is missing its artifact-contract placeholders.");
      }

      for (const file of outputFiles) {
        if (!/\.(?:html|js|mjs)$/i.test(file)) continue;
        const source = fs.readFileSync(file, "utf8");
        const finalized = source
          .replaceAll(REACT_SHELL_REVISION_PLACEHOLDER, revision)
          .replaceAll(REACT_SHELL_BOOT_ASSETS_PLACEHOLDER, JSON.stringify(uniqueBootAssets));
        if (finalized !== source) fs.writeFileSync(file, finalized);
      }

      for (const file of filesBelow(reactOutputDir)) {
        if (!/\.(?:html|js|mjs)$/i.test(file)) continue;
        const source = fs.readFileSync(file, "utf8");
        if (
          source.includes(REACT_SHELL_REVISION_PLACEHOLDER)
          || source.includes(REACT_SHELL_BOOT_ASSETS_PLACEHOLDER)
        ) throw new Error(`React shell artifact placeholder remained in ${file}`);
      }
    },
  };
}

function contentType(file: string) {
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

/**
 * `vite preview` serves only the React output directory, while production
 * Express also serves the root bridge runtimes. Mirror those exact files so
 * the production-build worker contract is exercised rather than a 404/fallback.
 *
 * In SW contract mode it also exposes a minimal client and a controlled old
 * worker response. Both deployments derive from the same single build output;
 * tests never rewrite or rebuild that artifact.
 */
function reactShellPreviewContractPlugin(enabled: boolean): Plugin {
  return {
    name: "react-shell-preview-contract",
    apply: "serve",
    configurePreviewServer(server) {
      let deployment: "current" | "old" = "current";
      const workerPath = path.join(reactOutputDir, "react-sw.js");

      server.middlewares.use((request, response, next) => {
        const requestUrl = new URL(request.url ?? "/", "http://preview.usernode");
        const rootAsset = rootBootAssets.find((asset) => asset === requestUrl.pathname);
        if (rootAsset) {
          const file = path.join(rootPublicDir, rootAsset.slice(1));
          response.statusCode = 200;
          response.setHeader("Content-Type", contentType(file));
          response.end(fs.readFileSync(file));
          return;
        }
        if (!enabled) return next();

        if (requestUrl.pathname === "/react/__sw-test/deployment" && request.method === "POST") {
          deployment = requestUrl.searchParams.get("mode") === "old" ? "old" : "current";
          response.statusCode = 204;
          response.end();
          return;
        }
        if (requestUrl.pathname === "/react/__sw-test/client") {
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end("<!doctype html><html><body><main>Worker fixture</main></body></html>");
          return;
        }
        if (requestUrl.pathname === "/react/__sw-test/old-lazy.js") {
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/javascript; charset=utf-8");
          response.end("globalThis.__oldLazyChunk = 'available';");
          return;
        }
        if (requestUrl.pathname === "/react/react-sw.js" && deployment === "old") {
          const current = fs.readFileSync(workerPath, "utf8");
          const revision = current.match(/const BUILD_REVISION = "([^"]+)"/)?.[1];
          if (!revision) throw new Error("Built React worker has no finalized revision.");
          const oldRevision = `old-${revision}`;
          const oldWorker = current
            .replace(`const BUILD_REVISION = "${revision}"`, `const BUILD_REVISION = "${oldRevision}"`)
            .replace(
              /const BOOT_ASSETS = (\[[^\n]+\])/,
              (_match, serialized: string) => {
                const assets = JSON.parse(serialized) as string[];
                return `const BOOT_ASSETS = ${JSON.stringify([
                  ...assets,
                  "/react/__sw-test/old-lazy.js",
                ].sort())}`;
              },
            );
          response.statusCode = 200;
          response.setHeader("Cache-Control", "no-store");
          response.setHeader("Content-Type", "text/javascript; charset=utf-8");
          response.end(oldWorker);
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");
  const apiTarget = environment.SV_API_TARGET || "http://127.0.0.1:3000";
  const usesProductionApi = environment.SV_PRODUCTION_READONLY === "true";
  const productionWriteAppSlug = environment.SV_PRODUCTION_WRITE_APP_SLUG?.trim() || null;
  const certificatePath = path.resolve(dirname, ".local-dev-cert.pem");
  const privateKeyPath = path.resolve(dirname, ".local-dev-key.pem");
  const useLocalHttps = environment.SV_LOCAL_HTTPS === "true";
  const explicitReactShellRevision = validatedExplicitRevision(
    environment.SV_REACT_SHELL_REVISION,
  );
  const swContractTest = environment.SV_SW_CONTRACT_TEST === "true";

  if (usesProductionApi && !apiTarget.startsWith("https://")) {
    throw new Error("SV_PRODUCTION_READONLY requires an HTTPS SV_API_TARGET.");
  }
  if (productionWriteAppSlug && !apiTarget.startsWith("https://")) {
    throw new Error("SV_PRODUCTION_WRITE_APP_SLUG requires an HTTPS SV_API_TARGET.");
  }
  if (usesProductionApi && productionWriteAppSlug) {
    throw new Error("Choose either SV_PRODUCTION_READONLY or SV_PRODUCTION_WRITE_APP_SLUG, not both.");
  }
  if (useLocalHttps && (!fs.existsSync(certificatePath) || !fs.existsSync(privateKeyPath))) {
    throw new Error("SV_LOCAL_HTTPS requires frontend/.local-dev-cert.pem and frontend/.local-dev-key.pem.");
  }

  return {
    base: "/react/",
    build: {
      outDir: reactOutputDir,
      emptyOutDir: true,
    },
    define: {
      "import.meta.env.VITE_PRODUCTION_READONLY": JSON.stringify(usesProductionApi),
      "import.meta.env.VITE_PRODUCTION_WRITE_APP_SLUG": JSON.stringify(productionWriteAppSlug),
      "import.meta.env.VITE_REACT_SHELL_REVISION": JSON.stringify(REACT_SHELL_REVISION_PLACEHOLDER),
    },
    server: {
      https: useLocalHttps ? { cert: fs.readFileSync(certificatePath), key: fs.readFileSync(privateKeyPath) } : undefined,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          secure: true,
        },
        // The Express shell owns this read-only passthrough to the leaderboard
        // service. Keep it at the same origin as `/api` so the React shell
        // preserves the existing browser/WebView CORS and cookie boundary.
        "/challenges-api": {
          target: apiTarget,
          changeOrigin: true,
          secure: true,
        },
        // React discussion uses the established cookie-authenticated socket.
        // Vite's `bypass` also runs for upgrade requests, so it enforces the
        // same local production mutation scope as the HTTP API guard.
        "/ws": {
          target: apiTarget,
          changeOrigin: true,
          secure: true,
          ws: true,
          bypass: (request) => allowScopedWebSocket(request.url, { apiTarget, appSlug: productionWriteAppSlug, readOnly: usesProductionApi }) ? undefined : false,
        },
      },
    },
    plugins: [
      productionApiGuard({ apiTarget, appSlug: productionWriteAppSlug, readOnly: usesProductionApi }),
      react(),
      tailwindcss(),
      reactShellArtifactPlugin(explicitReactShellRevision),
      reactShellPreviewContractPlugin(swContractTest),
    ],
    resolve: {
      alias: {
        "@": path.resolve(dirname, "./@"),
      },
    },
  };
});
