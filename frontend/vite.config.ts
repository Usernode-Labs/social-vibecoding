import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));

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

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");
  const apiTarget = environment.SV_API_TARGET || "http://127.0.0.1:3000";
  const usesProductionApi = environment.SV_PRODUCTION_READONLY === "true";
  const productionWriteAppSlug = environment.SV_PRODUCTION_WRITE_APP_SLUG?.trim() || null;
  const certificatePath = path.resolve(dirname, ".local-dev-cert.pem");
  const privateKeyPath = path.resolve(dirname, ".local-dev-key.pem");
  const useLocalHttps = environment.SV_LOCAL_HTTPS === "true";

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
      outDir: path.resolve(dirname, "../public/react"),
      emptyOutDir: true,
    },
    define: {
      "import.meta.env.VITE_PRODUCTION_READONLY": JSON.stringify(usesProductionApi),
      "import.meta.env.VITE_PRODUCTION_WRITE_APP_SLUG": JSON.stringify(productionWriteAppSlug),
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
    plugins: [productionApiGuard({ apiTarget, appSlug: productionWriteAppSlug, readOnly: usesProductionApi }), react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(dirname, "./@"),
      },
    },
  };
});
