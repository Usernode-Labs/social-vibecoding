require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const { load: loadConfig } = require('./src/config');
const { migrate } = require('./src/db/migrate');
const { shellAssetCacheControl } = require('./src/services/static-cache');
const { authMiddleware } = require('./src/middleware/auth');
const { authRoutes } = require('./src/routes/auth');
const jwt = require('jsonwebtoken');
const { appRoutes } = require('./src/routes/apps');
const { chatRoutes } = require('./src/routes/chat');
const { sessionRoutes } = require('./src/routes/sessions');
const { voteRoutes } = require('./src/routes/votes');
const { kudosRoutes } = require('./src/routes/kudos');
const { publicApiRoutes } = require('./src/routes/public-api');
const { issueRoutes } = require('./src/routes/issues');
const { adminRoutes } = require('./src/routes/admin');
const { dashboardRoutes } = require('./src/routes/dashboard');
const { feedbackRoutes } = require('./src/routes/feedback');
const { notificationsRoutes } = require('./src/routes/notifications');
const { collaboratorRoutes } = require('./src/routes/collaborators');
const { approverRoutes } = require('./src/routes/approvers');
const { statusRoutes } = require('./src/routes/status');
const { internalRoutes } = require('./src/routes/internal');
const { appErrorRoutes } = require('./src/routes/app-error');
const { visualsRoutes } = require('./src/routes/visuals');
const { appIconRoutes } = require('./src/routes/app-icons');
const { issueImageRoutes } = require('./src/routes/issue-images');
const { appFileServeRoutes, appFileShellRoutes } = require('./src/routes/app-files');
const appStorageRoutes = require('./src/routes/app-storage');
const anthropicProxyRoutes = require('./src/routes/anthropic-proxy');
const appLlmProxyRoutes = require('./src/routes/app-llm-proxy');
const appPlatformApiRoutes = require('./src/routes/app-platform-api');
const { llmGrantsRoutes } = require('./src/routes/llm-grants');
const { userAgentFilesRoutes } = require('./src/routes/user-agent-files');
const { proposalDiscussRoutes } = require('./src/routes/proposal-discuss');
const { topicAttributeRoutes } = require('./src/routes/topic-attributes');
const { boardOrderRoutes } = require('./src/routes/board-order');
const { pmOrderRoutes } = require('./src/routes/pm-order');
const { debugRoutes } = require('./src/routes/debug');
const { galleryRoutes } = require('./src/routes/gallery');
const github = require('./src/services/github');
const llm = require('./src/services/llm');
const worker = require('./src/services/worker');
const activeWorkersSvc = require('./src/services/active-workers');
const turnWatchdog = require('./src/services/turn-watchdog');
const recoveryPills = require('./src/services/recovery-pills');
const sessionLifecycle = require('./src/services/session-lifecycle');
const stagingRecovery = require('./src/services/staging-recovery');
const limits = require('./src/services/limits');
const ws = require('./src/services/ws');
const log = require('./src/services/logger');
const lifecycle = require('./src/services/lifecycle');
const chainPoller = require('./src/services/chain-poller');
const genesisAccounts = require('./src/services/genesis-accounts');
const nodeStatus = require('./src/services/node-status');
const statusService = require('./src/services/status');
const { getActiveWorkerCount } = require('./src/routes/sessions');
const { sweepStuckCreatingApps } = require('./src/routes/apps');
const { getPool } = require('./src/db/pool');

const config = loadConfig();
log.setLevel(config.logLevel);

const app = express();

// One hop (Caddy) in front of us — enables accurate req.ip for rate limits.
app.set('trust proxy', 1);

// ── Explorer API passthrough ───────────────────────────────────────────────
// The mobile app's in-webview "Transaction Log" panel resolves the explorer
// against the origin it is loaded from and calls
// `GET /explorer-api/active_chain` + `POST /explorer-api/<chain>/transactions`
// (usernode flutter `dapp_webview_screen.dart`). On the per-dApp subdomains
// the dapp template server (usernode-dapp-homepage/server.js `proxyExplorer`)
// proxies that prefix to the explorer; on the launcher origin the path used to
// fall through the JWT gate and 302 to /login.html, so the webview got HTML
// back and `jsonDecode` threw "Explorer fetch failed". Mounting the same
// public passthrough here — before the JSON body parser so the raw body
// streams through, and before authMiddleware so it isn't redirected — makes
// the panel work without an app redeploy. Matches the documented
// PUBLIC_PREFIXES = ['/explorer-api/'] convention (src/prompts/app-conventions.md).
const EXPLORER_UPSTREAM =
  process.env.EXPLORER_UPSTREAM || 'testnet-explorer.usernodelabs.org';
const EXPLORER_UPSTREAM_BASE = process.env.EXPLORER_UPSTREAM_BASE || '/api';
const EXPLORER_USE_HTTP = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01]))/.test(
  EXPLORER_UPSTREAM.replace(/:\d+$/, '')
);

app.use('/explorer-api', (req, res) => {
  const transport = EXPLORER_USE_HTTP ? require('http') : require('https');
  // req.url is the path *after* the /explorer-api mount point, e.g.
  // "/active_chain" or "/<chain>/transactions" (query string preserved).
  const subPath = req.url.replace(/^\/+/, '');
  const upstreamPath = `${EXPLORER_UPSTREAM_BASE}/${subPath}`;
  const [hostname, portStr] = EXPLORER_UPSTREAM.split(':');
  const port = portStr ? Number(portStr) : EXPLORER_USE_HTTP ? 80 : 443;

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const bodyBuf = chunks.length ? Buffer.concat(chunks) : null;
    const upReq = transport.request(
      {
        hostname,
        port,
        path: upstreamPath,
        method: req.method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(bodyBuf ? { 'content-length': bodyBuf.length } : {}),
        },
      },
      (upRes) => {
        const rChunks = [];
        upRes.on('data', (c) => rChunks.push(c));
        upRes.on('end', () => {
          res.writeHead(upRes.statusCode || 502, {
            'content-type': upRes.headers['content-type'] || 'application/json',
            'access-control-allow-origin': '*',
          });
          res.end(Buffer.concat(rChunks));
        });
      }
    );
    upReq.on('error', (err) => {
      log.error('explorer-proxy', 'upstream error', { err: err.message });
      res.status(502).type('text/plain').send(`Explorer proxy error: ${err.message}`);
    });
    if (bodyBuf) upReq.write(bodyBuf);
    upReq.end();
  });
});

// ── Challenges API passthrough ─────────────────────────────────────────────
// The SV challenges screen (public/js/challenges.js, #challenges hash route
// — app-as-SV-chrome migration) renders the same data the mobile app's
// native Challenges tab pulls from the leaderboard service. Browsers can't
// call that host cross-origin, so proxy a READ-ONLY allowlist of its
// public endpoints here. Mounted before authMiddleware (public, like
// /explorer-api) and restricted to GET + known paths so the participant-
// scoped /register surface is never reachable through SV. The two /me/*
// GETs backing the SV #profile screen are allowlisted: identity there is
// just the participant_id query param, the same trust model as the mobile
// app calling the leaderboard API directly.
const CHALLENGES_UPSTREAM_BASE =
  process.env.CHALLENGES_API_BASE ||
  'https://leaderboard.usernodelabs.org/api/v2/mobile';
const CHALLENGES_ALLOWED_PATHS = new Set([
  '/seasons',
  '/challenges',
  '/leaderboard',
  '/me/ranking',
  '/me/breakdown',
]);

app.use('/challenges-api', (req, res) => {
  const [subPath, query] = req.url.split('?');
  const normalized = '/' + subPath.replace(/^\/+|\/+$/g, '');
  if (req.method !== 'GET' || !CHALLENGES_ALLOWED_PATHS.has(normalized)) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const upstream = new URL(CHALLENGES_UPSTREAM_BASE + normalized +
    (query ? `?${query}` : ''));
  const transport = upstream.protocol === 'http:'
    ? require('http') : require('https');
  const upReq = transport.request(
    upstream,
    { method: 'GET', headers: { accept: 'application/json' } },
    (upRes) => {
      const rChunks = [];
      upRes.on('data', (c) => rChunks.push(c));
      upRes.on('end', () => {
        res.writeHead(upRes.statusCode || 502, {
          'content-type':
            upRes.headers['content-type'] || 'application/json',
          // Same short-cache tier as other read-only public data; the
          // screen re-fetches on open anyway.
          'cache-control': 'no-store',
        });
        res.end(Buffer.concat(rChunks));
      });
    }
  );
  upReq.on('error', (err) => {
    log.error('challenges-proxy', 'upstream error', { err: err.message });
    res.status(502).json({ error: `Challenges proxy error: ${err.message}` });
  });
  upReq.end();
});

// Skip the global JSON parser for the Anthropic-proxy path so the proxy
// can mount its own parser with a 32MB limit (matching Anthropic's
// actual request-size cap). With the default 100kb limit a normal CC
// turn body (often a few MB of file context) gets 413'd at the parser
// boundary, and the `claude` CLI surfaces the generic
// "Request too large (max 32MB). Try with a smaller file." message —
// even though our parser, not Anthropic, is the one rejecting. Keep
// the rest of the app on the small default; only the proxy needs the
// large limit. See routes/anthropic-proxy.js for the scoped parser.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/internal/anthropic/')) return next();
  if (req.path.startsWith('/api/app-llm/')) return next();
  // Agent-file uploads (#460) carry up to 48 KB of file content, which
  // can exceed the 100kb default once JSON-escaped — the route mounts
  // its own 256kb parser (see routes/user-agent-files.js).
  if (req.path === '/api/me/agent-files' && req.method === 'POST') return next();
  express.json()(req, res, next);
});
app.use(cookieParser());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// The platform is never a dapp in "mock mode". The shared usernode-bridge
// auto-detects mock mode by probing `GET /__mock/enabled` and treating ANY
// 200 as "use the local-dev /__mock/* endpoints". Our SPA catch-all
// (`app.get('*')` below) answers that probe with index.html + 200, which
// fools the bridge into routing `sendTransaction` to `/__mock/sendTransaction`
// — an endpoint we don't implement — so the POST 404s and surfaces the
// misleading "Mock API not enabled" error on the wallet register flow.
// Explicitly 404 the whole mock namespace (before authMiddleware so it's
// authoritative for anonymous + authenticated callers alike) so the bridge
// correctly concludes mock is off and uses the native transport.
app.all('/__mock/*', (_req, res) => {
  res.status(404).json({ error: 'mock mode not available on the platform' });
});

// Lightweight endpoint polled by the header "platform version" pill
// (public/js/app.js → renderPlatformVersionPill). Four pieces of
// information packaged together so the client only needs one fetch:
//   - `sha`            : the SHA the running platform was built from.
//   - `name`           : short label shown in the pill (mirrors how the
//                        per-app pill leads with the app slug, so the
//                        two read symmetrically as "usernode · sha"
//                        and "myapp · sha · #pr"). Overridable via env.
//   - `repoUrl`        : where to link the pill (commit on GitHub).
//                        Overridable via env so forks point at their own repo.
//   - `deployProgress` : null in idle state, or { deploying, sha, startedAt }
//                        when the deploy workflow has flagged a redeploy in
//                        flight (see services/deploy-status.js + deploy.yml).
const deployStatus = require('./src/services/deploy-status');
app.get('/api/version', (_req, res) => {
  res.json({
    sha: process.env.GIT_SHA || 'dev',
    name: process.env.USERNODE_PROJECT_NAME || 'usernode',
    repoUrl: process.env.USERNODE_REPO_URL || 'https://github.com/Usernode-Labs/social-vibecoding',
    deployProgress: deployStatus.read(),
    // SELF-HOSTING.md Phase 2f / Phase 3: the platform's own slug
    // in the apps table. Clients use this to recognize self-app
    // surfaces (e.g. the "Platform updating…" banner cross-checks
    // sessionStorage state against the live self-app slug). Cheap to
    // include — already available in config; saves the client a second
    // round-trip for any code path that needs it.
    selfAppSlug: config.selfAppSlug,
  });
});

// Public conventions endpoint. Apps' own CLAUDE.md files point here so
// a developer (or Claude Code) running locally against a repo can
// fetch the current platform rules without cloning the harness.
// Mounted before authMiddleware so it's open to anyone.
app.get('/claude.md', (_req, res) => {
  const fs = require('fs');
  const fp = path.join(__dirname, 'src', 'prompts', 'app-conventions.md');
  try {
    const body = fs.readFileSync(fp, 'utf-8');
    const stat = fs.statSync(fp);
    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.set('Last-Modified', stat.mtime.toUTCString());
    // No strong caching — the whole point is that this URL serves the
    // current conventions, not a snapshot.
    res.set('Cache-Control', 'public, max-age=60');
    res.send(body);
  } catch (err) {
    log.error('conventions', 'Failed to serve /claude.md', { err: err.message });
    res.status(500).type('text/plain').send('conventions unavailable');
  }
});

// Public sidecar-status endpoints. All read the cached snapshot maintained
// by `services/node-status.js` (one poll per process, regardless of how
// many clients are watching). Mounted before authMiddleware so anonymous
// visitors and embedded child-app pages can both read them. All on-chain
// info is already public, so no progressive disclosure here.
//
// Three surfaces:
//   - /api/node-status        : compact node snapshot (powers the summary
//                                card on the main /status page)
//   - /api/node-status/full   : full snapshot (server + node + explorer +
//                                chain-dependent services). Powers the
//                                /node-status viewer page.
//   - /node-status            : the standalone HTML viewer (modeled on
//                                dapp-server.js's /status page)
app.get('/api/node-status', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(nodeStatus.get());
});

app.get('/api/node-status/full', (_req, res) => {
  // Lazy require here (rather than top of file) keeps the import graph
  // straight: chain-poller and genesis-accounts are leaf modules; node-
  // status doesn't import them. The callback shape is what wires them
  // together at request time.
  const chainPollerSvc = require('./src/services/chain-poller');
  const genesisAccountsSvc = require('./src/services/genesis-accounts');
  res.set('Cache-Control', 'no-store');
  res.json(nodeStatus.getFull({
    name: 'usernode-social-vibecoding',
    mode: process.env.USERNODE_LOCAL_DEV ? 'local-dev' : 'production',
    services: () => ({
      chainPoller: chainPollerSvc.getStatus(),
      genesisAccounts: {
        loaded: genesisAccountsSvc.isLoaded(),
        count: genesisAccountsSvc.count(),
      },
    }),
  }));
});

app.get('/node-status', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'node-status.html'));
});

// Status routes are public (with progressive disclosure for admins) —
// mount before authMiddleware so they don't redirect anonymous visitors.
app.use(statusRoutes(config));

// Worker → platform internal API (git push proxy, PR creation).
// Mounted BEFORE authMiddleware because requests come from worker
// containers, not users — they carry a session-scoped JWT in
// Authorization: Bearer, verified by internal-auth middleware inside
// the router. Also gated by a private-IP check; not reachable through
// Caddy's external vhosts in production.
app.use(internalRoutes(config));

// Worker → platform Anthropic proxy. The CC worker container holds a
// session-scoped JWT (in ANTHROPIC_API_KEY env, picked up as x-api-key
// by the SDK) and ANTHROPIC_BASE_URL points at /api/internal/anthropic
// here. The proxy verifies the JWT, swaps in the real platform key, and
// forwards to api.anthropic.com — so the platform key never enters the
// worker container and "echo $ANTHROPIC_API_KEY" exfiltrates only a
// short-lived JWT useless against Anthropic directly. Same private-IP
// gate as internalRoutes; not reachable through Caddy externally.
app.use(anthropicProxyRoutes(config));

// Dapp → platform LLM proxy (issue #34). App containers call
// /api/app-llm/v1/messages with their per-app token
// (USERNODE_LLM_PROXY_TOKEN) plus the user's iframe JWT; the proxy
// verifies both, requires an active per-(app,user) grant, swaps in the
// real key (platform or the user's own, per the grant), meters spend
// against the user's daily budget AND the grant's per-app cap, and
// forwards to api.anthropic.com. Same private-IP gate as the worker
// proxy; mounted before authMiddleware because callers are app
// containers, not browser sessions.
app.use(appLlmProxyRoutes(config));

// Dapp → platform app-storage API (#752). App containers upload/delete
// user files with their per-app token (USERNODE_STORAGE_TOKEN) plus the
// user's iframe JWT — same credential pattern and private-IP gate as
// the app-LLM proxy above; mounted before authMiddleware because
// callers are app containers, not browser sessions.
app.use(appStorageRoutes(config));

// App-facing read-only platform API (#744). App containers call
// /api/app-platform/governance/feed with the same per-app token
// (USERNODE_LLM_PROXY_TOKEN) to read their OWN proposal/vote/merge
// feed for in-app "what's changing" strips. App-token-only (no user
// token or grant — the feed holds nothing an app viewer can't already
// see in the vote panel), same private-IP gate; mounted before
// authMiddleware because callers are app containers, not browser
// sessions.
app.use(appPlatformApiRoutes(config));

// Before/after visuals artifacts (#195). Public by design: GitHub's camo
// proxy fetches the PR-body embeds anonymously, so this must not redirect
// to login. Access control is the unguessable 32-hex artifact id.
app.use(visualsRoutes(config));

// App homescreen icon images. Public for the same reason as visuals:
// home tiles load them with plain <img> tags; access control is the
// unguessable 32-hex icon id.
app.use(appIconRoutes(config));

// Issue-screenshot images (#683). Public for the same reason as visuals:
// GitHub's camo proxy fetches the issue-body embeds anonymously; access
// control is the unguessable 32-hex screenshot id.
app.use(issueImageRoutes(config));

// App-stored user files (#752). Public for the same reason as app-icons:
// app pages load them with plain <img> tags from their own subdomains.
// visibility='public' rows are guarded by the unguessable 32-hex id;
// visibility='private' rows additionally require a user JWT (?token=)
// inside the route. Bytes stream from the MinIO sidecar.
app.use(appFileServeRoutes(config));

// Friendly "app is restarting" page for dead app containers (#426).
// Caddy's wildcard-site handle_errors rewrites upstream 502/503/504s to
// /__app_unavailable and proxies them here with the original app-
// subdomain Host. Mounted before authMiddleware: the request carries no
// platform session (and needs none — for view-private apps the edge
// gate already passed before the proxy attempt failed).
app.use(appErrorRoutes(config));

app.use(authMiddleware(config));
app.use(authRoutes(config));
app.use(appRoutes(config));
// Shell relay for usernode.uploadFile()/deleteFile()/getStorageUsage()
// (#752): session-cookie authed, called only by public/js/app-view.js's
// storage bridge handler on behalf of the app iframe.
app.use(appFileShellRoutes(config));
app.use(chatRoutes(config));
app.use(sessionRoutes(config));
app.use(voteRoutes(config));
app.use(kudosRoutes(config));
// Public read-only apps + contributors API. Mounted after authMiddleware
// like kudosRoutes; reachable anonymously via the `/api/public/` prefix in
// PUBLIC_PATHS (src/middleware/auth.js).
app.use(publicApiRoutes(config));
app.use(issueRoutes(config));
app.use(adminRoutes(config));
app.use(dashboardRoutes(config));
app.use(feedbackRoutes(config));
app.use(notificationsRoutes(config));
app.use(collaboratorRoutes(config));
app.use(approverRoutes(config));
app.use(llmGrantsRoutes(config));
app.use(userAgentFilesRoutes(config));
app.use(proposalDiscussRoutes(config));
app.use(topicAttributeRoutes(config));
app.use(boardOrderRoutes(config));
app.use(pmOrderRoutes(config));
app.use(debugRoutes(config));
app.use(galleryRoutes(config));

app.get('/api/iframe-token', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  let usernodePubkey = null;
  // Platform-level language preference (issue #757): a BCP-47 tag or null
  // when unset. Always present in the payload so app servers never need
  // `'locale' in payload` checks. Additive claim only — signing secret,
  // algorithm, expiry, and the existing claims are unchanged.
  let userLocale = null;
  try {
    const { rows } = await getPool(config).query(
      'SELECT usernode_pubkey, locale FROM users WHERE id = $1',
      [req.user.id]
    );
    usernodePubkey = rows[0]?.usernode_pubkey || null;
    userLocale = rows[0]?.locale || null;
  } catch {}
  const token = jwt.sign(
    { id: req.user.id, username: req.user.username, usernode_pubkey: usernodePubkey, locale: userLocale },
    config.jwtSecret,
    { expiresIn: '1h' }
  );
  res.json({ token });
});

// Bridge centralization: versioned bridge served from /usernode-bridge/vN/.
// Within a major version (e.g. v1), bug fixes ship by editing the file in
// SV and redeploying — every dapp picks the fix up on next page load.
// Browsers must therefore revalidate on every request so changes propagate
// quickly; the file is ~100KB and revalidates via 304 when unchanged.
// Across major versions the URL changes (/v1/ → /v2/) so caches segregate
// naturally. Dapps still vendor their own copy for now; this is the
// additive scaffolding for a future migration off vendoring.
app.use('/usernode-bridge', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  next();
});

// Serve the shell's static assets, but force HTML/JS/CSS to revalidate on
// every load (see src/services/static-cache.js). Without this, mobile
// WebViews cached the shell's own /js/app.js on a PR's stable staging URL
// and kept running pre-fix code across redeploys — fixes appeared to have
// no effect ("same as before"). setHeaders runs as `send` streams the file,
// so it reliably overrides send's default `max-age=0`. 304s still apply.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    const cc = shellAssetCacheControl(filePath);
    if (cc) res.setHeader('Cache-Control', cc);
  },
}));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Cross-app "submitted features" admin view (#562). Like /admin, the static
// shell is served to anyone; admin-features.js checks /api/auth/me and gates
// non-admins, while the GET /api/admin/submitted-features data endpoint it
// calls is independently enforced by adminMiddleware. Must be registered
// before the app.get('*') SPA fallback below.
app.get('/admin-features', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-features.html'));
});

// Admin analytics dashboard. Like /admin, the static shell is served to
// anyone; the page bootstraps by checking /api/auth/me and redirects
// non-admins, while the /api/admin/analytics/* data endpoints it calls
// are independently enforced by adminMiddleware.
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Admin merge-debug view. Like /admin and /dashboard the static shell is
// served to anyone; debug.js checks /api/auth/me and redirects non-admins,
// while the /api/debug/* endpoints it calls are enforced by adminMiddleware.
// Must be registered before the app.get('*') SPA fallback below.
app.get('/debug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'debug.html'));
});

// Admin before/after screenshot gallery. Like /admin, /dashboard and /debug
// the static shell is served to anyone; gallery.js checks /api/auth/me and
// shows an "Admins only" message, while the /api/gallery/* endpoints it
// calls are independently enforced in src/routes/gallery.js. Must be
// registered before the app.get('*') SPA fallback below.
app.get('/gallery', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'gallery.html'));
});

app.get('*', (req, res) => {
  if (req.accepts('html')) {
    // Client-side-routing fallback: serve the SPA shell. Same revalidation
    // policy as the static handler so a redeployed index.html (which pulls
    // in fresh /js/*.js) is never pinned in a WebView cache.
    res.setHeader('Cache-Control', shellAssetCacheControl('index.html'));
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

async function start() {
  await migrate(config);

  // #616: ensure the read-only prod-debug Postgres role (fresh in-memory
  // password every boot) and refresh its deny-listed grants so tables
  // added by this deploy's migrations are covered. Non-blocking: on
  // failure the prod-debug endpoints return 503 and dev sessions run
  // without the capability — boot proceeds normally.
  const debugAccess = require('./src/services/debug-access');
  debugAccess.ensureRole(config).catch((err) => {
    log.warn('server', 'prod-debug role bootstrap failed (capability disabled)', {
      err: err.message,
    });
  });

  await github.init(config);
  await llm.init(config);

  // Any app stuck in 'creating' from a previous process crash gets flipped
  // to 'error' so the creator can retry instead of staring at a spinner.
  await sweepStuckCreatingApps(getPool(config)).catch(() => {});

  // Backfill `main_sha` for apps created before #21 added the column.
  // Non-blocking: we log and continue so a single slow/unauthorized
  // repo doesn't delay the server coming up.
  const { backfillMainShas } = require('./src/services/app-version');
  backfillMainShas(getPool(config)).catch((err) => {
    log.warn('server', 'main_sha backfill failed', { err: err.message });
  });

  // Public-only audit: scan existing `apps` rows and log a warning for
  // any repo that's currently private. The worker bootstrap guard
  // refuses to spawn against private repos, so these apps will fail
  // to start a dev session until the user makes the repo public —
  // surfacing them at boot lets operators see the impact ahead of
  // first user contact. Non-blocking.
  auditExistingRepoPrivacy(getPool(config)).catch((err) => {
    log.warn('server', 'private-repo audit failed', { err: err.message });
  });

  // One-time, idempotent: convert any open legacy rename *issues* into
  // rename PRs (the new dapp.json-name flow), then close the issues so
  // the backlog drains. Runs after github.init so it can actually open
  // PRs; no-op when GitHub isn't configured. Non-blocking + guarded
  // per-app so one failing repo doesn't hold up boot or the batch.
  const { migrateOpenRenameIssues } = require('./src/services/rename-pr');
  migrateOpenRenameIssues(config, getPool(config)).catch((err) => {
    log.warn('server', 'rename-issue migration failed', { err: err.message });
  });

  worker.ensureWorkerImage().catch((err) => {
    log.warn('server', 'Worker image build deferred', { err: err.message });
  });

  // Module-scoped so cleanup() can close it on SIGTERM (#767) — a
  // function-local handle left the listener accepting new connections
  // for the entire drain, then exited from under them.
  const server = app.listen(config.port, () => {
    log.info('server', `Listening on :${config.port}`);
  });
  httpServer = server;
  shutdownPool = getPool(config);

  ws.attach(server, config);
  chainPoller.start(config);
  genesisAccounts.start();
  nodeStatus.start({ nodeRpcUrl: process.env.NODE_RPC_URL });
  // Warm the /api/status cache so the first dashboard load doesn't have
  // to wait 1-2s on `docker stats`. Subsequent loads are served from
  // cache via stale-while-revalidate (see services/status.js).
  statusService.start(config);
  // Periodically check imported / bot-owned repos for new commits on
  // `main` we didn't make ourselves and redeploy via the same path
  // that the dev-chat merge flow uses. See main-drift-poller.js.
  require('./src/services/main-drift-poller').start(config);
  // Production app-container watchdog (#426): restart/rebuild
  // status='running' apps whose `usernode-app-<slug>` container is
  // stopped or missing — the drift poller above only acts on new
  // commits, so without this a dead container 502s forever. Not gated
  // on GitHub config: the fast `docker start` path needs none.
  require('./src/services/app-heal').start(config);

  // Adopt any worker containers left over from a previous server run —
  // either still executing or already exited but un-finalized. These
  // orphans are a feature, not a bug: workers are intentionally detached
  // from the server lifecycle so `node --watch` restarts don't interrupt
  // in-flight Claude Code sessions.
  recoverActiveWorkers(config)
    .catch((err) => {
      log.warn('server', 'Worker adoption failed', { err: err.message });
    })
    .finally(() => {
      // Resume headless auto sessions that were 'generating' when the
      // previous process died. Runs after worker adoption so any warm
      // container for a headless session is already registered (the
      // resume path also tolerates adoption not having finished — it
      // falls back to the deterministic container name). Each row is
      // carried forward from its persisted headless_step checkpoint;
      // unresumable rows are marked 'failed' (the pre-resume behavior).
      const { resumeHeadlessRuns } = require('./src/routes/sessions');
      resumeHeadlessRuns(config)
        .catch((err) => {
          log.warn('server', 'Headless resume failed', { err: err.message });
        })
        // #786: last of the recovery chain — repair dev-chat pill bars the
        // restart emptied in shapes that leave NO breadcrumb of their own
        // (a Mayor turn killed mid-stream, a phase-2 wrap-up lost while the
        // worker was merely warm-idle, plus sessions left broken by earlier
        // restarts). Runs after the paths above have claimed their sessions,
        // and its busy / active_turn guards skip anything still in flight.
        .then(() => restoreMissingQuickReplies(config))
        .catch((err) => {
          log.warn('server', 'Quick-reply backfill failed', { err: err.message });
        });
    });

  // Idle-eviction sweeper. Warm workers cost ~256MB resident; eviction
  // reclaims that memory after a tunable idle period. The CC volume
  // (cc-volume-<sessionId>) is preserved so the next dispatch's
  // re-warm replays prior conversation state via `claude --resume`.
  //
  // WORKER_IDLE_EVICTION_MS is the only knob (default 10min). Lower it
  // if memory headroom shrinks; raise it if we're seeing frequent
  // re-warms in production logs.
  startIdleEvictionSweeper();

  // Session auto-pause sweeper (separate, longer timer than worker
  // eviction above). Flips long-idle 'active' sessions to 'paused' so
  // they stop counting against the per-user / global session caps. The
  // CC volume + branch + PR are preserved; reopening auto-resumes.
  startSessionAutoPauseSweeper(config);

  // Stale-promoted-PR policy + reversible-archive GC. Warns authors of
  // promoted PRs that have gone quiet, auto-archives them after a grace
  // period, and hard-purges archived CC volumes once their retention
  // window elapses. Day-scale, so it polls on its own slow interval.
  startStalePrSweeper(config);

  // Reconcile open PR sessions ('promoted'/'merging') against GitHub's
  // actual merge state. Heals sessions that merged on GitHub but whose
  // post-merge step (prod rebuild, etc.) failed — those would otherwise
  // stay 'promoted' and keep showing as "up for voting" forever — and
  // demotes 'merging' rows GitHub never merged (crash mid-merge) back to
  // 'promoted' so the next vote/retry can redrive. See the function body.
  // #390: after the GitHub-state reconcile completes (which demotes
  // crash-stuck 'merging' rows back to 'promoted' so they're eligible
  // again this same boot), re-drive the per-app drain for every app with
  // open proposals so any PR that crossed the vote-majority threshold
  // while the process was down — or whose background merge was lost to the
  // restart — actually merges now instead of waiting for a fresh vote.
  // Both stay off the critical path so the server still comes up
  // immediately, like the other recovery steps below.
  recoverStuckMerges(config)
    .then(() => reconcileEligibleMerges(config))
    // #447: after reconciling merge state, re-run any stuck/never-recorded
    // proposal checks so PRs left permanently "still running its tests" by a
    // restart mid-capture self-heal on boot. Off the critical path; the
    // re-checked PRs become merge-eligible and the next vote (or the eligible-
    // merge reconcile on a later boot) merges them.
    .then(() => reconcileStuckChecks(config))
    .catch((err) => {
      log.warn('server', 'Stuck-merge recovery / eligible-merge reconcile failed', {
        err: err.message,
      });
    });

  // #144: re-arm post-merge issue-close watches a restart killed. The
  // watcher (services/issue-close-watcher.js) is fired-and-forgotten
  // in-process from the merge path; for the self-edits app a merge
  // triggers the GitHub Actions deploy that rolls THIS platform process,
  // so the watcher dies before it can confirm GitHub's async auto-close
  // and refresh the "Open Issues" panel — the closed issue then lingers
  // until someone happens to reload after the cache TTL. Re-watching
  // recently-merged sessions on boot closes that gap (and covers crash
  // restarts mid-watch for ordinary apps too).
  resumeIssueCloseWatches(config).catch((err) => {
    log.warn('server', 'Issue-close watch resume failed', { err: err.message });
  });

  // Fallback recovery: for sessions whose container is already gone but
  // whose branch is ahead of main (i.e. CC pushed commits during an old
  // pre-autonomous-worker run), complete the PR + staging tail.
  recoverSessions(config).catch((err) => {
    log.warn('server', 'Session recovery failed', { err: err.message });
  });

  // Merge-debug retention: prune /debug runs (and their cascaded steps)
  // older than the window once at boot and then on a slow timer, so the
  // staging:private merge_debug_* tables can't grow without bound. Off the
  // critical path; swallows its own errors.
  const mergeDebug = require('./src/services/merge-debug');
  const MERGE_DEBUG_RETENTION_DAYS = parseInt(process.env.MERGE_DEBUG_RETENTION_DAYS || '30', 10);
  mergeDebug.pruneOldRuns(getPool(config), MERGE_DEBUG_RETENTION_DAYS).catch(() => {});
  setInterval(() => {
    mergeDebug.pruneOldRuns(getPool(config), MERGE_DEBUG_RETENTION_DAYS).catch(() => {});
  }, 6 * 60 * 60 * 1000).unref();

  // #451: periodic auto-merge safety net. The boot sequence above runs
  // reconcileEligibleMerges / reconcileStuckChecks exactly once; the live
  // triggers (a vote landing, a checks verdict turning green — see
  // services/visuals.js, services/conflict-resolver.js, routes/votes.js)
  // cover the common case, but a lost broadcast or a crash between the
  // checks-store and its drain trigger could still leave a PR that has both
  // a winning vote AND passing checks sitting in review until the next
  // restart. Re-run the same idempotent, bounded reconcilers on a slow
  // interval so a genuinely-ready proposal can never stall indefinitely.
  // Off the critical path, single-flight per app inside the drain, and a
  // no-op when GitHub isn't wired up. Tunable via ELIGIBLE_MERGE_SWEEP_MS.
  startEligibleMergeSweeper(config);

  // Title auto-heal: retry LLM title generation for PRs/feedback issues
  // that were filed with the fallback template while the Anthropic API was
  // unavailable (services/title-heal.js). Bounded, non-overlapping, no-op
  // while the LLM stays disabled.
  startTitleHealSweeper(config);

  return server;
}

// Boot only when run as the entry point (`node server.js` — the Docker CMD
// and npm start path). Tests require() this module to reach the recovery
// internals exported below without starting servers or sweepers.
if (require.main === module) {
  start().catch((err) => {
    // pg's ECONNREFUSED and some Octokit errors leave `.message` empty, so
    // also surface `.code` and the stack — otherwise boot failures print
    // as `{"message":""}` and there's nothing to act on.
    log.error('server', 'Failed to start', {
      message: err.message || '(empty)',
      code: err.code,
      stack: err.stack,
    });
    process.exit(1);
  });
}

// Test-only surface (#183): the orphan-adoption + recovered-turn finalize
// internals, so the headless-recovery guards stay covered by node --test.
// `recoverStuckMerges` rides along so the GitHub-reconciliation sweep stays
// covered too, and `reconcileEligibleMerges` (#390) so the boot-time
// auto-merge eligibility sweep is covered. `cleanup` + `__setShutdownTargets`
// (#767) let tests drive the graceful-shutdown sequence against a stubbed
// listener and pool without booting a server. Not used by any runtime caller.
module.exports = {
  adoptOrphanWorker,
  finalizeRecoveredTurn,
  restoreMissingQuickReplies,
  recoverStuckMerges,
  reconcileEligibleMerges,
  reconcileStuckChecks,
  cleanup,
  // Getters, not values: this module.exports literal is evaluated long
  // before the `const`s down by cleanup(), so a direct reference would hit
  // the temporal dead zone and crash the whole require.
  get DRAIN_TIMEOUT_MS() { return DRAIN_TIMEOUT_MS; },
  get POOL_CLOSE_TIMEOUT_MS() { return POOL_CLOSE_TIMEOUT_MS; },
  __setShutdownTargets: ({ server, pool } = {}) => {
    httpServer = server ?? null;
    shutdownPool = pool ?? null;
    cleanupStarted = false;
  },
};

// Scan existing imported apps for privacy violations. Usernode workers
// run with zero GitHub credentials and rely on unauthenticated public
// HTTPS clones; a private repo can't be cloned by the worker, so dev
// sessions against it will fail at bootstrap. Surface those rows at
// boot so the operator can decide whether to ask the user to make
// the repo public or delete the import.
//
// Bounded concurrency (a small pool) keeps the scan from spending
// minutes on a large `apps` table during startup. The check is purely
// read-only — we log and move on.
async function auditExistingRepoPrivacy(pool) {
  const github = require('./src/services/github');
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT id, slug, repo_url FROM apps
       WHERE repo_url IS NOT NULL AND status != 'archived'`
    ));
  } catch (err) {
    log.warn('server', 'private-repo audit: query failed', { err: err.message });
    return;
  }
  if (!rows.length) return;

  log.info('server', 'Starting private-repo audit', { count: rows.length });

  // Cap concurrency so a 100-row deployment doesn't fire 100 GitHub
  // API calls in parallel and trip secondary rate limits.
  const CONCURRENCY = 4;
  const queue = rows.slice();
  let privateCount = 0;
  let errorCount = 0;

  async function worker() {
    while (queue.length) {
      const row = queue.shift();
      const m = (row.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!m) continue;
      const [, owner, repo] = m;
      try {
        const result = await github.checkRepoPublic(owner, repo);
        if (!result.ok) {
          errorCount++;
          log.warn('server', 'private-repo audit: lookup failed', {
            appId: row.id, slug: row.slug, repo: `${owner}/${repo}`, err: result.message,
          });
        } else if (result.private) {
          privateCount++;
          log.warn('server', 'private-repo audit: app references a PRIVATE repo (dev sessions will fail)', {
            appId: row.id, slug: row.slug, repo: `${owner}/${repo}`,
          });
        }
      } catch (err) {
        errorCount++;
        log.warn('server', 'private-repo audit: unexpected error', {
          appId: row.id, slug: row.slug, err: err.message,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  log.info('server', 'Private-repo audit complete', {
    total: rows.length, private: privateCount, errors: errorCount,
  });
}

// Reconcile open PR sessions against GitHub's actual merge state.
// See the call site for rationale.
//
// Two failure modes are healed here:
//   1. A session merged on GitHub whose post-merge step (prod rebuild,
//      etc.) failed, leaving the row stuck in 'promoted'/'merging' even
//      though the PR is merged. Such a row keeps appearing in the Dev
//      forum's vote panel forever (GET /api/apps/:slug/promoted returns
//      `status IN ('promoted','merging')`). This is the whiteboard
//      #41/#44/#52/#54 bug.
//   2. A crash mid-merge that left a row in 'merging'. If GitHub never
//      merged it, flip it back to 'promoted' so the next vote/retry can
//      redrive (the original recoverStuckMerges behavior).
//
// We ask GitHub the truth rather than guessing. Bounded concurrency keeps
// the boot scan cheap; genuinely-open PRs simply report merged=false and
// are left untouched (only 'merging' rows are demoted to 'promoted').
async function recoverStuckMerges(config) {
  const { getPool } = require('./src/db/pool');
  const github = require('./src/services/github');
  const pool = getPool(config);

  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT cs.id, cs.status, cs.pr_number, cs.merge_commit_sha,
              a.repo_url
         FROM chat_sessions cs
         JOIN apps a ON a.id = cs.app_id
        WHERE cs.status IN ('promoted', 'merging')`
    ));
  } catch (err) {
    log.warn('server', 'recoverStuckMerges query failed', { err: err.message });
    return;
  }
  if (!rows.length) return;

  // Without GitHub auth we can't ask the truth. Preserve the original
  // crash-recovery behavior for 'merging' rows (flip back to 'promoted')
  // and leave 'promoted' rows alone.
  if (!github.isEnabled()) {
    try {
      const { rows: flipped } = await pool.query(
        `UPDATE chat_sessions SET status = 'promoted'
          WHERE status = 'merging' RETURNING id`
      );
      if (flipped.length) {
        log.info('server', 'Unstuck merging sessions on startup (no GitHub auth)', {
          count: flipped.length, ids: flipped.map((r) => r.id),
        });
      }
    } catch (err) {
      log.warn('server', 'recoverStuckMerges fallback flip failed', { err: err.message });
    }
    return;
  }

  log.info('server', 'Reconciling open PR sessions against GitHub', { count: rows.length });

  const CONCURRENCY = 4;
  const queue = rows.slice();
  let healed = 0;
  let demoted = 0;
  let errors = 0;

  async function worker() {
    while (queue.length) {
      const row = queue.shift();
      const m = (row.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!m || !row.pr_number) {
        // Can't ask GitHub. Only demote 'merging' (crash recovery); leave
        // 'promoted' rows as-is.
        if (row.status === 'merging') {
          await pool.query(
            `UPDATE chat_sessions SET status = 'promoted'
              WHERE id = $1 AND status = 'merging'`,
            [row.id]
          ).catch(() => {});
          demoted++;
        }
        continue;
      }
      const [, owner, repo] = m;
      try {
        const pr = await github.getPR(owner, repo, row.pr_number);
        if (pr && pr.merged) {
          const { rowCount } = await pool.query(
            `UPDATE chat_sessions
                SET status = 'merged',
                    merged_at = COALESCE(merged_at, $2),
                    merge_commit_sha = COALESCE(merge_commit_sha, $3)
              WHERE id = $1 AND status IN ('promoted', 'merging')`,
            [row.id, pr.merged_at || null, pr.merge_commit_sha || null]
          );
          if (rowCount) {
            healed++;
            log.info('server', 'Reconciled merged-on-GitHub session to merged', {
              sessionId: row.id, prNumber: row.pr_number,
              repo: `${owner}/${repo}`, mergeSha: pr.merge_commit_sha || null,
            });
          }
        } else if (row.status === 'merging') {
          // Not merged on GitHub and stuck in 'merging' (crash mid-merge):
          // demote so the next vote/retry can redrive.
          await pool.query(
            `UPDATE chat_sessions SET status = 'promoted'
              WHERE id = $1 AND status = 'merging'`,
            [row.id]
          ).catch(() => {});
          demoted++;
        }
        // Not merged + 'promoted' == genuinely open proposal: leave alone.
      } catch (err) {
        errors++;
        log.warn('server', 'recoverStuckMerges: GitHub lookup failed', {
          sessionId: row.id, prNumber: row.pr_number,
          repo: `${owner}/${repo}`, err: err.message,
        });
        // On a lookup error, fall back to the safe crash-recovery move for
        // 'merging' rows only.
        if (row.status === 'merging') {
          await pool.query(
            `UPDATE chat_sessions SET status = 'promoted'
              WHERE id = $1 AND status = 'merging'`,
            [row.id]
          ).catch(() => {});
          demoted++;
        }
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  } catch (err) {
    log.warn('server', 'recoverStuckMerges reconciliation failed', { err: err.message });
  }
  log.info('server', 'PR session reconciliation complete', {
    scanned: rows.length, healed, demoted, errors,
  });
}

// Boot-time auto-merge reconcile sweep (#390). recoverStuckMerges above
// reconciles each open session's status against GitHub's actual merge
// state, but it deliberately leaves genuinely-open 'promoted' rows alone
// (see its body: "Not merged + 'promoted' == genuinely open proposal:
// leave alone"). It never re-checks whether a proposal has crossed the
// vote-majority threshold.
//
// Auto-merge is otherwise PURELY event-driven: a merge is only attempted
// in the background of a live vote (routes/votes.js fires checkAndMerge
// fire-and-forget). So a proposal that crossed threshold while the process
// was down — or whose background merge was lost to a restart mid-flight,
// or that became eligible because the active-user count (and thus the
// majority) dropped — sits in the Dev vote panel forever until someone
// happens to cast a fresh vote. That is the "auto-merge stops after
// restart/update" bug.
//
// The fix re-drives the existing per-app drain (checkAndResolveConflicts →
// drainApp) once at boot for every app that has any open proposal. The
// drain re-reads everything from Postgres, only ever touches PRs already
// at/above the active-user majority (the same bar checkAndMerge gates on,
// so nothing below threshold is resolved pre-emptively — #380), merges
// them in the normal priority order, and inherits the normal single-flight
// + Phase 1/Phase 2 conflict handling. It is idempotent and safe to run on
// every boot. Bounded cross-app concurrency keeps a many-app fleet from
// fanning out unbounded GitHub calls; per-app work is already serialized
// by the drain's own single-flight.
async function reconcileEligibleMerges(config) {
  const github = require('./src/services/github');
  // Without GitHub auth the drain's per-session resolve is a no-op
  // (github_disabled_or_no_pr merges nothing), so skip the work entirely —
  // matches the no-auth short-circuit in recoverStuckMerges above.
  if (!github.isEnabled()) return;

  const { getPool } = require('./src/db/pool');
  const { checkAndResolveConflicts } = require('./src/services/conflict-resolver');
  const pool = getPool(config);

  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT DISTINCT app_id FROM chat_sessions WHERE status = 'promoted'`
    ));
  } catch (err) {
    log.warn('server', 'reconcileEligibleMerges query failed', { err: err.message });
    return;
  }
  if (!rows.length) return;

  log.info('server', 'Reconciling eligible auto-merges on startup', { apps: rows.length });

  const CONCURRENCY = 4;
  const queue = rows.slice();
  let drained = 0;
  let errors = 0;

  async function worker() {
    while (queue.length) {
      const { app_id: appId } = queue.shift();
      try {
        await checkAndResolveConflicts(config, { app_id: appId });
        drained++;
      } catch (err) {
        // checkAndResolveConflicts swallows drainApp errors internally, so
        // this is belt-and-braces; never let one app's failure abort the rest.
        errors++;
        log.warn('server', 'reconcileEligibleMerges: drain failed', {
          appId, err: err.message,
        });
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  } catch (err) {
    log.warn('server', 'reconcileEligibleMerges sweep failed', { err: err.message });
  }
  log.info('server', 'Eligible auto-merge reconciliation complete', {
    apps: rows.length, drained, errors,
  });
}

// #447: how long a 'pending' check may sit before it's treated as stuck.
// The headless capture run is capped at RUN_TIMEOUT_MS (240s in
// services/visuals.js) plus the staging build, so 10 minutes is comfortably
// beyond any legitimately in-flight run. Tunable via CHECKS_STALE_MS.
const CHECKS_STALE_MS = parseInt(
  process.env.CHECKS_STALE_MS || String(10 * 60 * 1000),
  10
);

// #237: crash-loop short-circuit. A staging build that crashes deterministically
// (e.g. an app whose staging-only seed hits a missing constraint) used to be
// retried by the sweeper every sweep forever — a silent, churning deadlock.
// Build/boot failures now land a terminal 'error' verdict (services/visuals
// storeChecks) with an exponential backoff retry schedule (check_next_retry_at:
// 2m → 4m → … → 30m). The sweeper only re-picks an errored row once its backoff
// has elapsed AND it's still under this cap; past the cap we stop auto-retrying
// and leave it 'error' (the owner is already notified, and a NEW commit resets
// the streak via setChecksPending so a fix re-enables checks). Tunable.
const CHECK_MAX_AUTO_RETRIES = parseInt(
  process.env.CHECK_MAX_AUTO_RETRIES || '6',
  10
);

// #447: reconcile stuck proposal checks. check_state is only ever advanced
// out of 'pending' by the same captureForSession invocation that set it, so
// a process restart/crash mid-capture (or a staging rebuild that predated
// the #447 capture wiring) can leave a promoted PR 'pending'/NULL forever —
// past the vote threshold but permanently "still running its tests", blocked
// from merging with no retry. This re-runs the checks for promoted sessions
// whose verdict is NULL or has been 'pending' longer than CHECKS_STALE_MS.
// captureForSession always resolves to a terminal state (or 'error' via its
// catch), so this guarantees no row stays 'pending' indefinitely. Bounded
// per run like the staging-heal sweep; runs at boot and from the session
// sweeper (Pass 4). Safe + idempotent on every boot.
async function reconcileStuckChecks(config) {
  const github = require('./src/services/github');
  // Without GitHub auth a rebuild/capture is a no-op (rebuildSessionStaging
  // returns 'skipped' with no bot token), so skip the work entirely.
  if (!github.isEnabled()) return;

  const { getPool } = require('./src/db/pool');
  const pool = getPool(config);

  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url
         FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
        WHERE cs.status = 'promoted'
          AND cs.branch_name IS NOT NULL
          AND (cs.check_state IS NULL
               OR (cs.check_state = 'pending'
                   AND cs.checks_checked_at < NOW() - make_interval(secs => $1::double precision / 1000.0))
               OR (cs.check_state = 'error'
                   AND cs.consecutive_check_failures < $2
                   AND cs.check_next_retry_at IS NOT NULL
                   AND cs.check_next_retry_at < NOW()))
        ORDER BY cs.promoted_at ASC NULLS FIRST
        LIMIT 50`,
      [CHECKS_STALE_MS, CHECK_MAX_AUTO_RETRIES]
    ));
  } catch (err) {
    log.warn('server', 'reconcileStuckChecks query failed', { err: err.message });
    return;
  }
  if (!rows.length) return;

  log.info('server', 'Reconciling stuck proposal checks on startup', { count: rows.length });

  const MAX_RECHECKS = 5;
  let rechecked = 0;
  for (const session of rows) {
    if (rechecked >= MAX_RECHECKS) break;
    if (worker.isInFlight(session.id)) continue;
    rechecked++;
    try {
      await stagingRecovery.recheckSessionChecks({
        config, pool, session, reason: 'stuck-checks-boot',
      });
    } catch (err) {
      log.warn('server', 'reconcileStuckChecks recheck failed', {
        sessionId: session.id, err: err.message,
      });
    }
  }
  log.info('server', 'Stuck-check reconciliation complete', {
    scanned: rows.length, rechecked,
  });
}

// #451: how often the auto-merge safety-net sweep runs. A few minutes is
// well below the cost of letting a ready proposal linger but far above the
// per-pass work (one indexed query per app with an open proposal, then the
// single-flight drain). Tunable via ELIGIBLE_MERGE_SWEEP_MS; floored so a
// mis-set tiny value can't busy-loop the drain.
const ELIGIBLE_MERGE_SWEEP_MS = Math.max(
  parseInt(process.env.ELIGIBLE_MERGE_SWEEP_MS || String(4 * 60 * 1000), 10) || (4 * 60 * 1000),
  30 * 1000
);

// #451: periodic re-drive of the boot-time auto-merge reconcilers. Both
// reconcileEligibleMerges (merge any promoted PR that now has votes + passing
// checks) and reconcileStuckChecks (re-run checks left 'pending'/NULL by a
// mid-capture restart, so they reach a terminal verdict the eligible-merge
// pass can then act on) are idempotent and bounded, so re-running them on a
// timer is safe. Guards: skip when GitHub isn't enabled (both are no-ops
// then), never overlap a still-running sweep, and swallow all errors so the
// timer can't crash the process. Not awaited — fire-and-forget per tick.
function startEligibleMergeSweeper(config) {
  const github = require('./src/services/github');
  let running = false;
  setInterval(() => {
    if (running) return;
    if (!github.isEnabled()) return;
    running = true;
    Promise.resolve()
      .then(() => reconcileStuckChecks(config))
      .then(() => reconcileEligibleMerges(config))
      .catch((err) => {
        log.warn('server', 'Eligible-merge sweep tick failed', { err: err.message });
      })
      .finally(() => { running = false; });
  }, ELIGIBLE_MERGE_SWEEP_MS).unref?.();
}

// How often the title auto-heal sweep runs (services/title-heal.js). Ten
// minutes keeps the placeholder window short once credits/API come back
// without hammering a still-dead API (each pass is a handful of Haiku
// calls at most, and issue rows carry their own per-row backoff on top).
// Tunable via TITLE_HEAL_SWEEP_MS; floored so a mis-set value can't spin.
const TITLE_HEAL_SWEEP_MS = Math.max(
  parseInt(process.env.TITLE_HEAL_SWEEP_MS || String(10 * 60 * 1000), 10) || (10 * 60 * 1000),
  60 * 1000
);

// Periodic re-drive of title generation for fallback-titled PRs and
// feedback issues. Same guard shape as startEligibleMergeSweeper: never
// overlap a still-running pass, swallow all errors, unref'd timer. An
// early first pass (~90s after boot) covers the common "credits restored,
// platform redeployed" sequence so placeholders heal right away instead
// of waiting out the first full interval.
function startTitleHealSweeper(config) {
  const titleHeal = require('./src/services/title-heal');
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    titleHeal.sweep(config)
      .catch((err) => {
        log.warn('server', 'Title-heal sweep tick failed', { err: err.message });
      })
      .finally(() => { running = false; });
  };
  setTimeout(tick, 90 * 1000).unref?.();
  setInterval(tick, TITLE_HEAL_SWEEP_MS).unref?.();
}

// Resume post-merge issue-close watches for sessions merged shortly
// before this process started. See the call site for rationale. The
// 15-minute window comfortably covers the merge → GHA build → rolling
// restart sequence of the self-edits app; re-watching an issue GitHub
// already closed is cheap (first poll confirms, one cache bust + panel
// broadcast) and idempotent.
async function resumeIssueCloseWatches(config) {
  const github = require('./src/services/github');
  if (!github.isEnabled()) return;
  const { getPool } = require('./src/db/pool');
  const pool = getPool(config);
  const { rows } = await pool.query(
    `SELECT cs.id, cs.pr_number, cs.linked_issues,
            a.repo_url, a.slug AS app_slug, a.id AS app_id
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
      WHERE cs.status = 'merged'
        AND cs.merged_at > NOW() - INTERVAL '15 minutes'
        AND cs.pr_number IS NOT NULL`
  );
  if (!rows.length) return;
  const { watchIssuesClosedAfterMerge } = require('./src/services/issue-close-watcher');
  log.info('server', 'Resuming post-merge issue-close watches', {
    count: rows.length, sessionIds: rows.map((r) => r.id),
  });
  for (const row of rows) {
    const [, owner, repo] = (row.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
    if (!owner || !repo) continue;
    watchIssuesClosedAfterMerge({
      owner, repo,
      prNumber: row.pr_number,
      linkedIssues: row.linked_issues,
      appSlug: row.app_slug,
      appId: row.app_id,
      // The merge-time superseded-proposal resolve ran in the dead
      // pre-restart process — the resumed watch re-runs it for observed
      // closes so no close-issue proposal is left dangling.
      pool,
    }).catch((err) => {
      log.warn('server', 'Resumed issue-close watch failed', {
        sessionId: row.id, err: err.message,
      });
    });
  }
}

// stagingNeedsRebuild + rebuildSessionStaging moved to
// src/services/staging-recovery.js so the startup recovery, the heal
// sweep (Pass 3), and the on-demand ensure-staging route share one
// implementation. Imported as stagingRecovery at the top of this file.

// Recover sessions where CC finished but post-processing didn't complete,
// AND promoted/merging PRs whose staging preview is missing or dead.
//
// The staging gap: GC (sweeper Pass 2 → teardownStagingForSession) nulls
// staging_url for idle sessions, and a container can also be lost
// independently (host restart that didn't bring it back, manual cleanup,
// crash). Either way a promoted PR's group-chat vote card loses its
// working preview. recoverSessions heals these on startup; the sweeper's
// Pass 3 heals them live without a restart. The liveness check
// (stagingNeedsRebuild) means healthy, still-running previews are left
// untouched — only genuinely broken ones are rebuilt.
async function recoverSessions(config) {
  const { getPool } = require('./src/db/pool');
  const pool = getPool(config);

  const { rows } = await pool.query(
    `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url
     FROM chat_sessions cs
     JOIN apps a ON cs.app_id = a.id
     WHERE cs.status IN ('active', 'promoted', 'merging')
       AND cs.branch_name IS NOT NULL`
  );

  for (const session of rows) {
    try {
      if (!(await stagingRecovery.stagingNeedsRebuild(session))) continue;
      await stagingRecovery.rebuildSessionStaging({ config, pool, session, reason: 'startup' });
    } catch (err) {
      log.warn('server', 'Failed to recover session', { sessionId: session.id, err: err.message });
    }
  }
}

// Boot-time dev-chat quick-reply backfill (#786).
//
// The recovery paths above each drop a breadcrumb carrying pills, but two
// restart shapes leave no breadcrumb at all and so no pills:
//
//   1. A Mayor-only turn (no dispatch) killed mid-stream. It isn't in
//      activeWorkers, so the 5s drain doesn't wait for it and nothing is
//      persisted — the session's last rows are the user's message and the
//      "Thinking about your request..." status line, and the user has no
//      indication their message was dropped.
//   2. A phase-2 wrap-up lost while the worker was already warm-idle:
//      adoptOrphanWorker's warm-idle branch adopts silently (correctly —
//      nothing was interrupted), so the dispatch turn's pills, which only
//      ever come from phase 2, never land.
//
// Both leave the newest user/assistant row without quickReplies, which is
// exactly what the client's pill resolution reads. Repair them in place:
// attach derived pills to an assistant row, or post the missed-reply
// breadcrumb when the turn died before replying at all. The reap/skip
// decision itself is the pure classifyMissingPills policy in
// services/recovery-pills.js.
//
// Deliberately a one-shot boot sweep (not a sweeper pass): the shapes it
// heals are created by a restart, so a restart is exactly when to look.
// Bounded by LIMIT + a recency window so a large history can't make boot
// recovery expensive. Exported for tests.
const QR_BACKFILL_LIMIT = 200;
const QR_BACKFILL_WINDOW_DAYS = 7;

async function restoreMissingQuickReplies(config) {
  const pool = getPool(config);
  const { broadcastGlobal } = require('./src/services/ws');

  const { rows } = await pool.query(
    `SELECT id, pr_number, spec_md FROM chat_sessions
     WHERE status IN ('active', 'promoted')
       AND is_headless = FALSE
       AND active_turn IS NULL
       AND last_activity_at > NOW() - make_interval(days => $1::int)
     ORDER BY last_activity_at DESC
     LIMIT $2`,
    [QR_BACKFILL_WINDOW_DAYS, QR_BACKFILL_LIMIT]
  );
  if (!rows.length) return;

  let attached = 0;
  let breadcrumbs = 0;
  let skipped = 0;

  for (const session of rows) {
    try {
      // A live consumer owns this session right now (a detached-turn
      // resume started above, or a turn came in while we were sweeping) —
      // its own wrap-up/breadcrumb will supply the pills.
      if (activeWorkersSvc.isSessionBusy(session.id)) { skipped++; continue; }

      // System rows are transparent to the client's pill resolution, so
      // the deciding row is the newest user/assistant one.
      const { rows: lastRows } = await pool.query(
        `SELECT id, role, content, metadata FROM chat_session_messages
         WHERE session_id = $1 AND role IN ('user', 'assistant')
         ORDER BY id DESC LIMIT 1`,
        [session.id]
      );
      const lastRow = lastRows[0] || null;
      const verdict = recoveryPills.classifyMissingPills({ lastRow });

      if (verdict === 'attach_assistant') {
        const kind = recoveryPills.backfillKindForSession({
          hasPr: session.pr_number != null,
          hasSpec: !!(session.spec_md || '').trim(),
        });
        const pills = recoveryPills.buildRecoveryQuickReplies(kind);
        if (!pills) { skipped++; continue; }
        await pool.query(
          `UPDATE chat_session_messages
           SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{quickReplies}', $1::jsonb)
           WHERE id = $2`,
          [JSON.stringify(pills), lastRow.id]
        );
        attached++;
        continue;
      }

      if (verdict === 'breadcrumb_unanswered') {
        // Idempotence across boots: if this sweep already posted its
        // breadcrumb (and the user hasn't sent anything since), the row is
        // still the session's newest system row.
        const { rows: sysRows } = await pool.query(
          `SELECT content FROM chat_session_messages
           WHERE session_id = $1 AND role = 'system'
           ORDER BY id DESC LIMIT 1`,
          [session.id]
        );
        if (sysRows.length && sysRows[0].content === recoveryPills.UNANSWERED_BREADCRUMB) {
          skipped++;
          continue;
        }
        const pills = recoveryPills.buildRecoveryQuickReplies('unanswered', {
          lastUserText: lastRow.content || '',
        });
        await pool.query(
          `INSERT INTO chat_session_messages (session_id, role, content, metadata)
           VALUES ($1, 'system', $2, $3)`,
          [session.id, recoveryPills.UNANSWERED_BREADCRUMB,
            JSON.stringify(pills ? { quickReplies: pills } : {})]
        );
        broadcastGlobal({
          type: 'session_event', sessionId: session.id, event: 'status',
          text: recoveryPills.UNANSWERED_BREADCRUMB,
          quickReplies: pills || undefined,
        });
        breadcrumbs++;
        continue;
      }

      skipped++;
    } catch (err) {
      skipped++;
      log.warn('server', 'Quick-reply backfill skipped a session', {
        sessionId: session.id, err: err.message,
      });
    }
  }

  log.info('server', 'Dev-chat quick-reply backfill done', {
    scanned: rows.length, attached, breadcrumbs, skipped,
  });
}

// Adopt orphan worker containers on startup.
//
// A worker is "orphan" if its container (usernode-worker-<sessionId>)
// still exists on the host after the server comes up. That can happen
// two ways:
//
//   1) The previous server exited (SIGTERM from `node --watch`, crash,
//      host reboot) while a worker was in flight. Because the worker's
//      entrypoint runs the full clone→claude→commit→push pipeline on
//      its own, it may be STILL RUNNING or may have EXITED cleanly
//      while we were gone.
//   2) A past server exited after push but before building staging.
//
// For each case we re-attach to `docker logs -f` (which blocks on
// running containers and dumps everything immediately on exited ones),
// parse the final __USERNODE_RESULT__ line, and run PR + staging the
// same way the live chat handler does. All client updates go over the
// global WebSocket so any open tab sees the tail of its own session.
async function recoverActiveWorkers(config) {
  const pool = getPool(config);
  const staging = require('./src/services/staging');
  const ghub = require('./src/services/github');
  const { broadcastGlobal } = require('./src/services/ws');

  const orphans = await worker.listOrphanWorkers();
  if (!orphans.length) return;

  log.info('server', 'Adopting orphan worker containers', {
    count: orphans.length,
    names: orphans.map((o) => o.name),
  });

  for (const orphan of orphans) {
    // Run each adoption in parallel; they're IO-bound and isolated.
    adoptOrphanWorker(orphan, { config, pool, staging, ghub, broadcastGlobal })
      .catch((err) => {
        log.warn('server', 'Orphan adoption failed', {
          name: orphan.name, err: err.message,
        });
      });
  }
}

async function adoptOrphanWorker(orphan, { config, pool, staging, ghub, broadcastGlobal }) {
  const { name: containerName, sessionId, state: containerState } = orphan;

  const { rows } = await pool.query(
    `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url, u.username
     FROM chat_sessions cs
     JOIN apps a ON cs.app_id = a.id
     JOIN users u ON cs.user_id = u.id
     WHERE cs.id = $1`,
    [sessionId]
  );
  if (!rows.length) {
    // Session gone (archived/deleted). Just reap the container.
    log.info('server', 'Orphan has no session row — removing', { containerName });
    await worker.destroyWorker(containerName);
    return;
  }
  const session = rows[0];

  if (session.status !== 'active') {
    // Session archived while we were down — drop the container.
    await worker.destroyWorker(containerName);
    return;
  }

  // #183: headless auto sessions own their multi-step loop for ALL
  // container states — the turn resume AND the Mayor wrap-up continuation
  // both happen in resumeHeadlessRuns (runs right after worker adoption).
  // Running containers are registered warm so that loop can drive them;
  // exited ones are left strictly alone: scraping them here would replay
  // the interactive post-turn tail (PR + staging on the auto branch — the
  // original #183 bug) and clearing active_turn would destroy the journal
  // pointer the cc_running resume step needs. Leftover exited containers
  // are reaped by the normal worker sweeps once the run goes terminal.
  if (session.is_headless) {
    if (containerState === 'running') {
      log.info('server', 'Adopting headless worker (resume owned by resumeHeadlessRuns)', {
        containerName, sessionId,
      });
      worker.adoptWarmWorker(sessionId, containerName);
    } else {
      log.info('server', 'Leaving exited headless worker to resumeHeadlessRuns', {
        containerName, sessionId,
      });
    }
    return;
  }

  // Long-lived worker reality check: a *running* container could be
  //   (a) a warm-idle wrapper sitting in `sleep infinity` — clean adopt,
  //       no log scrape needed.
  //   (b) a legacy single-shot still in flight — only possible during
  //       rollout from the old worker contract; tail logs as before.
  //   (c) a warm wrapper with a detached turn in flight (or finished
  //       while we were down). The turn's output lives in a journal
  //       file in the CC volume, recorded on chat_sessions.active_turn
  //       — resume it from line 0 and finish the post-turn work as if
  //       we'd never restarted.
  //   (d) a mid-exec wrapper from BEFORE the detached-turn contract
  //       (no active_turn record). Its output went to a dead pipe and
  //       is unrecoverable; kill it so it can't race the next dispatch.
  if (containerState === 'running') {
    // Case (c): detached turn with a durable record — resume it.
    const activeTurn = session.active_turn || null;
    if (activeTurn && activeTurn.journal) {
      worker.adoptWarmWorker(sessionId, containerName);
      await resumeDetachedTurn({
        config, pool, staging, broadcastGlobal, session, sessionId,
        containerName, activeTurn,
      });
      return;
    }

    const busy = await worker.isWorkerExecuting(containerName);
    if (busy === false) {
      log.info('server', 'Adopting warm-idle worker (no in-flight exec)', {
        containerName, sessionId,
      });
      worker.adoptWarmWorker(sessionId, containerName);
      return;
    }
    if (busy === true && session.cc_session_id) {
      // Case (d) conservative recovery: the prior in-flight turn
      // predates the detached contract and is unrecoverable from the
      // host. Kill the orphan exec to free the warm container for
      // fresh dispatches, then post a system message so the user
      // knows to retry.
      log.info('server', 'Adopting mid-exec worker — killing orphan exec', {
        containerName, sessionId,
      });
      // worker.stopTurn walks /proc inside the container — the worker
      // image has no pkill (see TURN_PROC_KILL_SCRIPT in worker.js).
      await worker.stopTurn(sessionId).catch(() => {});
      // #786: the breadcrumb carries the turn's quick-reply pills. The
      // Mayor wrap-up that normally supplies them can't run here, and
      // without pills the bar above the composer stays empty until the
      // user types — so there'd be no one-tap way to retry.
      const killedPills = recoveryPills.buildRecoveryQuickReplies('unrecoverable');
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', $2, $3)`,
        [
          sessionId,
          'Lost connection mid-turn after restart — please retry your request.',
          JSON.stringify(killedPills ? { quickReplies: killedPills } : {}),
        ]
      ).catch(() => {});
      broadcastGlobal({
        type: 'session_event', sessionId, event: 'status',
        text: 'Lost connection mid-turn after restart — please retry your request.',
        quickReplies: killedPills || undefined,
      });
      worker.adoptWarmWorker(sessionId, containerName);
      return;
    }
    // busy === null (couldn't probe) or true with no cc_session_id
    // (legacy single-shot rollout): fall through to the legacy
    // watchWorker scrape. Safe on already-exited containers; for a
    // hung warm wrapper it'd block, but the idle sweeper plus session
    // archive cap the worst case.
  } else if (session.active_turn) {
    // A detached turn was recorded but its container is gone (evicted /
    // host reboot). The journal lives in the unreachable volume, so the
    // turn itself can't be replayed — but if it pushed before dying,
    // recoverSessions' staging heal picks the branch up. Clear the
    // record and let the user know.
    await worker.clearActiveTurn(sessionId);
    // Terminal marker so the dead turn's progress card doesn't stay
    // frozen on its last in-progress line ("Pushing", "Editing …").
    await appendTerminalProgressLine(pool, sessionId, '[interrupted]');
    // #786: pills on the breadcrumb — see the mid-exec branch above.
    const goneP = recoveryPills.buildRecoveryQuickReplies('unrecoverable');
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', $2, $3)`,
      [
        sessionId,
        'A coding turn was interrupted by a restart and its worker is gone — please retry your request.',
        JSON.stringify(goneP ? { quickReplies: goneP } : {}),
      ]
    ).catch(() => {});
  }

  const [, repoOwner, repoName] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];

  const emit = (event, data) => {
    broadcastGlobal({ type: 'session_event', sessionId, event, ...data });
  };

  emit('status', { text: 'Reconnecting to in-flight coding agent...' });

  const result = await worker.watchWorker(containerName, {
    onProgress: (text) => {
      emit('cc_progress', { text });
      pool.query(
        `UPDATE chat_session_messages
         SET metadata = jsonb_set(
           metadata, '{progressLog}',
           (COALESCE(metadata->'progressLog', '[]'::jsonb) || $1::jsonb)
         )
         WHERE id = (
           SELECT id FROM chat_session_messages
           WHERE session_id = $2 AND role = 'system'
             AND metadata->>'progressLog' IS NOT NULL
           ORDER BY id DESC LIMIT 1
         )`,
        [JSON.stringify([text]), sessionId]
      ).catch(() => {});
    },
  });

  await finalizeRecoveredTurn({
    config, pool, staging, session, sessionId, result, repoOwner, repoName,
    emit, containerName,
    // Legacy single-shot containers are per-turn; reap when done.
    keepWorker: false,
  });
}

// Shared post-turn finalization for both recovery transports (legacy
// `docker logs` scrape and detached-journal resume): persist the CC
// session id, then — when the turn pushed a commit — run the same PR +
// staging tail the live dev-turn path runs. `keepWorker` distinguishes
// the long-lived warm contract (container stays adoptable) from the
// legacy single-shot contract (container is reaped when done).
// Append one line to the session's latest persisted progressLog row —
// the same row flushProgress/onProgress write to. Used to stamp a
// terminal marker ([interrupted] etc.) on turns whose journal can't
// provide one, so the dev-chat progress card never ends frozen on an
// in-progress label. Best-effort: a session with no progress row is a
// clean no-op (the WHERE id subquery matches nothing).
async function appendTerminalProgressLine(pool, sessionId, line) {
  await pool.query(
    `UPDATE chat_session_messages
     SET metadata = jsonb_set(metadata, '{progressLog}',
       (COALESCE(metadata->'progressLog', '[]'::jsonb) || $1::jsonb))
     WHERE id = (
       SELECT id FROM chat_session_messages
       WHERE session_id = $2 AND role = 'system'
         AND metadata->>'progressLog' IS NOT NULL
       ORDER BY id DESC LIMIT 1
     )`,
    [JSON.stringify([line]), sessionId]
  ).catch(() => {});
}

// Returns a terminal outcome for the recovered turn's progress card:
// 'done' (turn wrapped up, including the no-changes case),
// 'push_failed' (commit exists only in the worker — re-push heal failed),
// or 'skip' (headless — owned by resumeHeadlessRuns).
async function finalizeRecoveredTurn({
  config, pool, staging, session, sessionId, result, repoOwner, repoName,
  emit, containerName, keepWorker,
}) {
  // #183 belt-and-braces: headless rows must never get the interactive
  // post-turn tail (PR on the auto branch + staging + system message) from
  // any recovery transport — resumeHeadlessRuns owns them. adoptOrphanWorker
  // already routes headless sessions away before reaching here; this guard
  // protects against future transports forgetting to.
  if (session.is_headless) {
    log.info('server', 'Skipping recovered-turn finalize for headless session (owned by resumeHeadlessRuns)', {
      sessionId,
    });
    return 'skip';
  }

  // Capture the CC session id so the next turn can --resume, even though
  // the server process that originally spawned this worker is gone.
  const newCcId = result.sessionId || result.initSessionId || null;
  if (newCcId && newCcId !== session.cc_session_id) {
    await pool.query(
      `UPDATE chat_sessions SET cc_session_id = $1 WHERE id = $2`,
      [newCcId, sessionId]
    ).catch(() => {});
  }

  const hasChanges = result.ahead > 0 && !!result.sha;
  if (!hasChanges) {
    emit('status', { text: 'Recovered session produced no changes.' });
    if (!keepWorker) await worker.destroyWorker(containerName);
    return 'done';
  }

  // The turn committed locally (ahead/sha set) but the worker's
  // usernode-push callback never landed the branch on GitHub
  // (push_ok=0 — e.g. the platform was mid-restart when the worker
  // called POST /api/internal/sessions/:id/push). `result.ahead` is
  // computed from the worker's LOCAL `origin/main..HEAD`, so it's >0
  // even with the remote branch still empty. Heal it here, while the
  // worker container still exists, before applyPrMetadata's createPR —
  // otherwise createPR 422s ("No commits between main and <branch>")
  // and, once the worker is evicted, the only copy of the commit is
  // gone. (chat 510 / issue #295: a restart mid-push left the branch
  // un-pushable and the work recoverable only from the CC transcript.)
  if (!result.pushOk) {
    try {
      const pushed = await worker.execPushFromWorker(sessionId, session.branch_name);
      result.pushOk = true;
      log.info('server', 'Recovered turn: re-pushed un-pushed branch', {
        sessionId, branch: session.branch_name,
        sha: (pushed?.sha || result.sha || '').substring(0, 8),
      });
    } catch (err) {
      log.warn('server', 'Recovered turn: re-push failed — skipping PR creation', {
        sessionId, branch: session.branch_name, err: err.message,
      });
      emit('status', {
        text: 'Recovered your changes but could not push them to GitHub — please retry your request.',
      });
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', $2, $3)`,
        [
          sessionId,
          'Your changes were committed but could not be pushed to GitHub after a restart — please retry your request to re-push and open the PR.',
          JSON.stringify({}),
        ]
      ).catch(() => {});
      if (!keepWorker) await worker.destroyWorker(containerName);
      return 'push_failed';
    }
  }

  try {
    // Pull the user's most recent message so the PR title helper has
    // the same "what did you ask for?" signal that the normal dev-turn
    // path gets via the live SSE request body. Without this, recovery
    // would hit the fallback template ("<user>'s changes") and never
    // regenerate titles for iterative edits.
    const { rows: userMsgRows } = await pool.query(
      `SELECT content FROM chat_session_messages
       WHERE session_id = $1 AND role = 'user'
       ORDER BY id DESC LIMIT 1`,
      [sessionId]
    );
    const recoveredUserMessage = userMsgRows[0]?.content || '';

    // #127: same TESTING-block handling as the live dev-turn path — peel
    // the block off the recovered summary (so markers don't leak into the
    // PR body prompt) and persist the guidance before applyPrMetadata
    // reads it back for the "How to test" section.
    const testingNotes = require('./src/services/testing-notes');
    const recoveredTesting = testingNotes.extract(result.lastResultText || '');
    const recoveredCcSummary = recoveredTesting.cleanedText;
    if (recoveredTesting.testingMd || recoveredTesting.testingPath) {
      await pool.query(
        `UPDATE chat_sessions SET testing_md = $1, testing_path = $2 WHERE id = $3`,
        [recoveredTesting.testingMd, recoveredTesting.testingPath, sessionId]
      ).catch(() => {});
      session.testing_md = recoveredTesting.testingMd;
      session.testing_path = recoveredTesting.testingPath;
    }

    const prMetadata = require('./src/services/pr-metadata');
    await prMetadata.applyPrMetadata({
      pool, session, repoOwner, repoName,
      userMessage: recoveredUserMessage,
      ccSummary: recoveredCcSummary,
      username: session.username,
      broadcast: (event, data) => emit(event, data),
      userId: session.user_id,
    });

    emit('status', { text: 'Building staging preview...' });
    const app = { id: session.app_id, slug: session.app_slug, name: session.app_name, repo_url: session.repo_url };
    const stagingResult = await staging.buildAndDeployStaging(config, session, app, result.sha);

    await pool.query(
      `UPDATE chat_sessions SET staging_container_id = $1, staging_url = $2 WHERE id = $3`,
      [stagingResult.containerId, stagingResult.stagingUrl, sessionId]
    );

    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', 'Staging deployed (recovered after restart)', $2)`,
      [sessionId, JSON.stringify({ stagingUrl: stagingResult.stagingUrl })]
    );

    emit('staging_ready', {
      url: stagingResult.stagingUrl,
      testingMd: session.testing_md || null,
      testingPath: session.testing_path || null,
    });
    log.info('server', 'Orphan finalized', {
      sessionId, commitHash: result.sha.substring(0, 8), url: stagingResult.stagingUrl,
    });
  } finally {
    if (!keepWorker) await worker.destroyWorker(containerName);
  }
  return 'done';
}

// Resume a detached CC turn after a restart. The turn kept running (or
// finished) while we were down — its output is in the journal file
// recorded on chat_sessions.active_turn. Replays the journal from line
// 0 (rebuilding progress + result state), follows it live if the turn
// is still going, then runs the standard post-turn tail. The warm
// container stays registered for the session's next dispatch.
async function resumeDetachedTurn(args) {
  const { pool, sessionId } = args;
  // Register the whole recovery (journal tail + finalize's PR/staging
  // work) in the shared activeWorkers set so the auto-pause/staging-GC
  // sweepers see the session as busy — the sessions 2391/2386 incident
  // was the sweeper pausing sessions and destroying their workers in
  // the window between the journal tail ending and finalize completing.
  activeWorkersSvc.activeWorkers.add(sessionId);
  try {
    return await resumeDetachedTurnInner(args);
  } finally {
    activeWorkersSvc.activeWorkers.delete(sessionId);
    // Turn completion counts as activity: give the freshly recovered
    // session a full idle window instead of leaving last_activity_at at
    // the pre-restart user message (which made it instantly pause-
    // eligible the moment the busy guard dropped).
    await pool.query(
      `UPDATE chat_sessions SET last_activity_at = NOW() WHERE id = $1`,
      [sessionId]
    ).catch(() => {});
  }
}

async function resumeDetachedTurnInner({
  config, pool, staging, broadcastGlobal, session, sessionId,
  containerName, activeTurn,
}) {
  const [, repoOwner, repoName] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  const emit = (event, data) => {
    broadcastGlobal({ type: 'session_event', sessionId, event, ...data });
  };

  log.info('server', 'Resuming detached turn from journal', {
    sessionId, containerName, mode: activeTurn.mode, journal: activeTurn.journal,
  });
  emit('status', { text: 'Resuming in-flight coding agent after restart...' });

  // The journal replay re-feeds every line from the start of the turn,
  // including ones the previous process already appended to the latest
  // "Claude Code progress" row. Rebuild that row's progressLog
  // WHOLESALE from the replayed lines (idempotent) instead of appending
  // duplicates; live tabs still get each line over the WebSocket.
  const progressLines = [];
  let flushQueued = false;
  const flushProgress = () => {
    flushQueued = false;
    pool.query(
      `UPDATE chat_session_messages
       SET metadata = jsonb_set(metadata, '{progressLog}', $1::jsonb)
       WHERE id = (
         SELECT id FROM chat_session_messages
         WHERE session_id = $2 AND role = 'system'
           AND metadata->>'progressLog' IS NOT NULL
         ORDER BY id DESC LIMIT 1
       )`,
      [JSON.stringify(progressLines), sessionId]
    ).catch(() => {});
  };

  let result;
  try {
    result = await worker.resumeTurnFromJournal(sessionId, {
      journal: activeTurn.journal,
      // #664: seed the per-turn BYOK tally from the persisted record so
      // post-restart switched calls accumulate on top of pre-restart ones.
      byokCentsSoFar: Number(activeTurn.byokCents || 0),
      onProgress: (text) => {
        emit('cc_progress', { text });
        progressLines.push(text);
        if (!flushQueued) {
          flushQueued = true;
          setTimeout(flushProgress, 1000);
        }
      },
    });
  } catch (err) {
    log.warn('server', 'Detached-turn resume failed', { sessionId, err: err.message });
    await worker.clearActiveTurn(sessionId);
    // Terminal marker: the card must not stay frozen on the last line
    // the journal managed to deliver before the resume died. When the
    // replay produced no lines at all, append to the persisted row
    // instead — a wholesale flush of just ['[interrupted]'] would wipe
    // the log the pre-restart process already persisted.
    emit('cc_progress', { text: '[interrupted]' });
    if (progressLines.length) {
      turnWatchdog.appendTerminalLine(progressLines, '[interrupted]');
      flushProgress();
    } else {
      await appendTerminalProgressLine(pool, sessionId, '[interrupted]');
    }
    // #786: the failed-resume breadcrumb carries retry pills — the
    // phase-2 wrap-up that would normally supply them is gone with the
    // dead SSE, so this is the turn's only chance to refill the bar.
    const failedPills = recoveryPills.buildRecoveryQuickReplies('unrecoverable');
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', $2, $3)`,
      [sessionId, 'A coding turn was interrupted by a restart and could not be resumed — please retry your request.',
        JSON.stringify(failedPills ? { quickReplies: failedPills } : {})]
    ).catch(() => {});
    emit('status', {
      text: 'A coding turn was interrupted by a restart and could not be resumed — please retry your request.',
      quickReplies: failedPills || undefined,
    });
    return;
  }
  flushProgress();

  // #174: the journal replay rebuilt the turn's self-reported cost —
  // without this debit a restart silently drops the CC turn's spend from
  // both ledger buckets. active_turn rows persisted before the byok flag
  // shipped fall back to key-on-file (presence of the encrypted key is
  // enough; no decryption needed). #664: a platform-billed turn that
  // switched onto the owner's key mid-run settles split across both
  // buckets (getTurnByokCents covers pre- and post-restart spillover).
  if (result.costUsd) {
    let byok = activeTurn.byok;
    if (byok === undefined || byok === null) {
      try {
        const { rows } = await pool.query(
          'SELECT EXISTS(SELECT 1 FROM users WHERE id = $1 AND anthropic_key_enc IS NOT NULL) AS byok',
          [session.user_id]
        );
        byok = !!rows[0]?.byok;
      } catch {
        byok = false;
      }
    }
    await limits.settleTurnSpend(pool, session.user_id, Math.round(result.costUsd * 100), {
      turnByok: !!byok,
      byokObservedCents: worker.getTurnByokCents(sessionId),
    });
  }

  // Terminal marker for the progress card: pessimistic default so a
  // throw anywhere below still stamps [interrupted]; the happy paths
  // overwrite it with [done] / [push_failed] before the finally runs.
  let terminalLine = '[interrupted]';
  // #786: which pill set the generic breadcrumb below should carry. The
  // scout branches attach their own pills to their own (more specific)
  // row and leave this null — a pill-less system row is transparent to
  // the client's pill resolution, so the earlier row still wins.
  let breadcrumbPillKind = null;
  try {
    if (activeTurn.mode === 'scout') {
      // Scout turns push nothing — their product is the spec text.
      // Persist it the same way runScoutTool does (spec_md + frozen
      // version) so the draft isn't lost with the dead SSE.
      const { stripSpecWrapperFence, snapshotSessionSpec } = require('./src/routes/sessions');
      const ccText = stripSpecWrapperFence((result.lastResultText || '').trim());
      if (ccText) {
        await pool.query(
          'UPDATE chat_sessions SET spec_md = $1 WHERE id = $2',
          [ccText, sessionId]
        ).catch(() => {});
        const specVersion = await snapshotSessionSpec(pool, sessionId, ccText);
        const lineCount = ccText.split('\n').length;
        // #786: "spec drafted" pills ride the spec row itself rather than
        // the generic breadcrumb — it's the row that describes the state
        // the session actually landed in.
        const specPills = recoveryPills.buildRecoveryQuickReplies('spec_done');
        await pool.query(
          `INSERT INTO chat_session_messages (session_id, role, content, metadata)
           VALUES ($1, 'system', $2, $3)`,
          [
            sessionId,
            `Scout finished after restart — drafted a ${lineCount}-line spec.`,
            JSON.stringify({
              specLines: lineCount,
              scoutOutput: ccText,
              specVersion,
              ...(specPills ? { quickReplies: specPills } : {}),
            }),
          ]
        ).catch(() => {});
        emit('status', {
          text: `Scout finished after restart — drafted a ${lineCount}-line spec.`,
          specLines: lineCount,
          scoutOutput: ccText,
          specVersion,
          quickReplies: specPills || undefined,
        });
        emit('spec_updated', { length: ccText.length, lines: lineCount, version: specVersion });
      } else {
        // #786: previously emit-only, so a recovered-but-empty scout turn
        // left no trace at all after a reload. Persist it (with retry
        // pills) so the state is visible and actionable.
        const noSpecPills = recoveryPills.buildRecoveryQuickReplies('unrecoverable');
        await pool.query(
          `INSERT INTO chat_session_messages (session_id, role, content, metadata)
           VALUES ($1, 'system', $2, $3)`,
          [
            sessionId,
            recoveryPills.SCOUT_NO_SPEC_BREADCRUMB,
            JSON.stringify(noSpecPills ? { quickReplies: noSpecPills } : {}),
          ]
        ).catch(() => {});
        emit('status', {
          text: recoveryPills.SCOUT_NO_SPEC_BREADCRUMB,
          quickReplies: noSpecPills || undefined,
        });
      }
      // Persist the CC session id for the next --resume.
      const newCcId = result.sessionId || result.initSessionId || null;
      if (newCcId && newCcId !== session.cc_session_id) {
        await pool.query(
          'UPDATE chat_sessions SET cc_session_id = $1 WHERE id = $2',
          [newCcId, sessionId]
        ).catch(() => {});
      }
      terminalLine = '[done]';
    } else {
      const finalizeOutcome = await finalizeRecoveredTurn({
        config, pool, staging, session, sessionId, result, repoOwner, repoName,
        emit, containerName,
        // Warm contract: the container outlives the turn.
        keepWorker: true,
      });
      terminalLine = finalizeOutcome === 'push_failed' ? '[push_failed]' : '[done]';
      // #786: the build branch has no more specific row of its own, so
      // its pills ride the generic breadcrumb below.
      breadcrumbPillKind = finalizeOutcome === 'push_failed' ? 'push_failed' : 'code_done';
    }
    // The dead SSE's Mayor phase-2 narration can't be resumed (matches
    // pre-existing recovery semantics) — drop a breadcrumb instead.
    // #786: it also carries the turn's quick-reply pills (except on the
    // scout paths, which already put them on their own row).
    const breadcrumbPills = breadcrumbPillKind
      ? recoveryPills.buildRecoveryQuickReplies(breadcrumbPillKind)
      : null;
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', $2, $3)`,
      [sessionId, 'Coding turn recovered after a platform restart.',
        JSON.stringify(breadcrumbPills ? { quickReplies: breadcrumbPills } : {})]
    ).catch(() => {});
    emit('status', {
      text: 'Coding turn recovered after a platform restart.',
      quickReplies: breadcrumbPills || undefined,
    });

    // #161: the pre-restart SSE is guaranteed dead, so the owner cannot
    // have been watching this turn finish — treat recovered turns as
    // armed regardless of the persisted notify_on_done flag: clear it
    // and always create the session_done notification (the WS push
    // reaches them if they have a tab open elsewhere in the app).
    try {
      const notifications = require('./src/services/notifications');
      await pool.query(
        `UPDATE chat_sessions SET notify_on_done = FALSE WHERE id = $1`,
        [sessionId]
      ).catch(() => {});
      const created = await notifications.createSessionDoneNotification(pool, {
        userId: session.user_id, appId: session.app_id, sessionId,
      });
      if (created.length) await notifications.hydrateAndPush(pool, created[0]);
    } catch (err) {
      log.warn('server', 'recovered-turn session_done notify failed', {
        sessionId, err: err.message,
      });
    }
  } finally {
    // Stamp the terminal marker on the rebuilt log (dedup: journals from
    // new worker images already end with their own [done]/[push_failed])
    // so the collapsed card label can't stay frozen on "Pushing".
    if (turnWatchdog.appendTerminalLine(progressLines, terminalLine)) {
      emit('cc_progress', { text: terminalLine });
    }
    flushProgress();
    await worker.clearActiveTurn(sessionId);
  }
}

// Idle-eviction sweeper for warm worker containers.
//
// Runs every SWEEP_INTERVAL_MS. For each session in the warm registry,
// if there's no in-flight exec AND the container hasn't been used in
// WORKER_IDLE_EVICTION_MS, we `docker stop && docker rm` it. The
// per-session CC volume is preserved so the next dispatch can re-warm
// with `claude --resume <id>` and replay conversation state.
//
// Tuning: WORKER_IDLE_EVICTION_MS (default 10min). The sweeper itself
// is cheap — a `Map` walk + at most a couple of execs per cycle — so
// the interval is fixed at 30s.
const WORKER_IDLE_EVICTION_MS = parseInt(
  process.env.WORKER_IDLE_EVICTION_MS || (10 * 60 * 1000),
  10
);
const SWEEP_INTERVAL_MS = 30 * 1000;

let sweeperHandle = null;

function startIdleEvictionSweeper() {
  if (sweeperHandle) return;
  log.info('server', 'Worker idle-eviction sweeper started', {
    idleEvictionMs: WORKER_IDLE_EVICTION_MS,
    sweepIntervalMs: SWEEP_INTERVAL_MS,
  });
  sweeperHandle = setInterval(async () => {
    if (lifecycle.isShuttingDown()) return;
    const now = Date.now();
    const snapshot = worker.warmRegistrySnapshot();
    for (const meta of snapshot) {
      if (meta.inFlight) continue;
      if (meta.bootstrapping) continue;
      if (now - meta.lastUsedMs < WORKER_IDLE_EVICTION_MS) continue;
      try {
        await worker.evictWorker(meta.sessionId);
        log.info('server', 'Idle warm worker evicted', {
          sessionId: meta.sessionId,
          containerName: meta.containerName,
          idleMs: now - meta.lastUsedMs,
        });
      } catch (err) {
        log.warn('server', 'Idle eviction failed', {
          sessionId: meta.sessionId, err: err.message,
        });
      }
    }
  }, SWEEP_INTERVAL_MS).unref();
  // .unref() so the sweeper doesn't hold the event loop open if everything
  // else has shut down. We still clearInterval explicitly in cleanup() to
  // race-free stop the sweeper before exit.
}

// Session auto-pause sweeper. Distinct from the worker idle-eviction
// sweeper above: that one reclaims container RAM on a short timer; this
// one frees the cap *slot* on a long timer by transitioning idle
// 'active' sessions to 'paused' (worker + staging torn down, CC volume +
// branch + PR preserved). Reopening a paused session auto-resumes it.
//
// Tunables: SESSION_AUTOPAUSE_IDLE_MS (default 2h; 0 disables) and
// SESSION_SWEEP_INTERVAL_MS (default 60s). We only ever pause status=
// 'active' here — never 'promoted' (those are awaiting merge votes and
// should stay live, and pausing+resuming would currently lose the
// promoted distinction).
let sessionSweeperHandle = null;

// Per-session throttle for the sweeper's staging-heal pass (Pass 3). Maps
// sessionId -> last rebuild-attempt epoch ms so a promoted PR whose build
// keeps failing (missing secret, broken manifest) isn't rebuilt on every
// 60s tick. Entries are dropped once a build succeeds; the set is bounded
// by the (small) number of promoted sessions currently missing staging.
const stagingHealAttempts = new Map();
const STAGING_HEAL_COOLDOWN_MS = parseInt(
  process.env.STAGING_HEAL_COOLDOWN_MS || String(10 * 60 * 1000),
  10
);

// #447: per-session throttle for the sweeper's stuck-check pass (Pass 4),
// mirroring stagingHealAttempts above. Maps sessionId -> last recheck-attempt
// epoch ms so a check that keeps failing to record (broken build, missing
// secret) isn't re-run on every tick. Same cooldown as the staging heal.
const checkRecheckAttempts = new Map();

// #687 Slice 3: per-session throttle for the sweeper's imported-PR head-sync
// pass (Pass 6), mirroring the two maps above. Maps sessionId -> last
// getPR-check epoch ms so an open imported proposal is polled at most once
// per cooldown (one GitHub getPR per open imported proposal per interval),
// not on every 60s tick — bounding the API cost the spec calls out. Entries
// are naturally evicted when the proposal leaves the open set.
const importedHeadSyncAttempts = new Map();
const IMPORTED_HEAD_SYNC_COOLDOWN_MS = Math.max(
  parseInt(process.env.IMPORTED_HEAD_SYNC_COOLDOWN_MS || String(3 * 60 * 1000), 10) || (3 * 60 * 1000),
  30 * 1000
);

function startSessionAutoPauseSweeper(config) {
  if (sessionSweeperHandle) return;
  if (!config.sessionAutopauseIdleMs || config.sessionAutopauseIdleMs <= 0) {
    log.info('server', 'Session auto-pause sweeper disabled', { reason: 'SESSION_AUTOPAUSE_IDLE_MS<=0' });
    return;
  }
  const pool = getPool(config);
  log.info('server', 'Session auto-pause sweeper started', {
    idleMs: config.sessionAutopauseIdleMs,
    stagingIdleMs: config.stagingIdleTeardownMs,
    sweepIntervalMs: config.sessionSweepIntervalMs,
  });
  sessionSweeperHandle = setInterval(async () => {
    if (lifecycle.isShuttingDown()) return;

    // Pass 1: auto-pause idle 'active' sessions (worker + slot only;
    // staging is left up for the cheap-resume window). Never pause a
    // session mid-turn: `active_turn IS NULL` excludes detached turns at
    // the SQL level (the watchdog pass below reaps stale rows, so this
    // can't block pausing forever), and isSessionBusy covers the whole
    // in-process window including the post-exec PR/staging tail — the
    // bare isInFlight check used to miss that tail and paused sessions
    // mid-wrap-up (sessions 2391/2386).
    try {
      const { rows } = await pool.query(
        `SELECT id FROM chat_sessions
         WHERE status = 'active'
           AND active_turn IS NULL
           AND last_activity_at < NOW() - make_interval(secs => $1::double precision / 1000.0)
         ORDER BY last_activity_at ASC
         LIMIT 50`,
        [config.sessionAutopauseIdleMs]
      );
      for (const row of rows) {
        if (activeWorkersSvc.isSessionBusy(row.id)) continue;
        try {
          await sessionLifecycle.pauseSession({ pool, sessionId: row.id, reason: 'auto-idle' });
        } catch (err) {
          log.warn('server', 'Auto-pause failed', { sessionId: row.id, err: err.message });
        }
      }
    } catch (err) {
      log.warn('server', 'Session auto-pause sweep failed', { err: err.message });
    }

    // Pass 2: staging GC. Reclaim the staging container + cloned DB from
    // sessions cold past the (much longer) staging-idle window. Skips
    // promoted/merging (their preview backs the group vote) and anything
    // mid-turn. Status is untouched — only the preview is reclaimed.
    if (config.stagingIdleTeardownMs && config.stagingIdleTeardownMs > 0) {
      try {
        const { rows } = await pool.query(
          `SELECT id FROM chat_sessions
           WHERE staging_container_id IS NOT NULL
             AND status NOT IN ('promoted', 'merging', 'merged', 'archived')
             AND last_activity_at < NOW() - make_interval(secs => $1::double precision / 1000.0)
           ORDER BY last_activity_at ASC
           LIMIT 20`,
          [config.stagingIdleTeardownMs]
        );
        for (const row of rows) {
          if (activeWorkersSvc.isSessionBusy(row.id)) continue;
          try {
            await sessionLifecycle.teardownStagingForSession({ pool, sessionId: row.id, reason: 'idle-gc' });
          } catch (err) {
            log.warn('server', 'Staging GC failed', { sessionId: row.id, err: err.message });
          }
        }
      } catch (err) {
        log.warn('server', 'Staging GC sweep failed', { err: err.message });
      }
    }

    // Stale active_turn watchdog: an active_turn row whose session is
    // not busy in-process is orphaned — in healthy operation dispatch
    // holds the warm-registry inFlight flag and the recovery flows hold
    // activeWorkers for their full duration, so no live consumer means
    // the process that owned the turn died (e.g. a crash between boot
    // adoption and finalize). Left alone it looks "working" forever and
    // (with Pass 1's active_turn guard) blocks auto-pause. Reap it:
    // clear the record, stamp the progress card [interrupted], tell the
    // user to retry, and notify like any other finished turn. The pure
    // reap/skip policy lives in services/turn-watchdog.js.
    try {
      const { rows } = await pool.query(
        `SELECT id, user_id, app_id, active_turn FROM chat_sessions
         WHERE active_turn IS NOT NULL
         ORDER BY (active_turn->>'startedAt') ASC NULLS FIRST
         LIMIT 20`
      );
      const nowMs = Date.now();
      const { broadcastGlobal } = require('./src/services/ws');
      for (const row of rows) {
        const busy = activeWorkersSvc.isSessionBusy(row.id);
        // Cheap pre-filter (no docker probe): fresh or busy rows skip.
        if (turnWatchdog.classifyStaleTurn({
          activeTurn: row.active_turn, nowMs, busy, executing: false,
        }) !== 'reap') continue;
        // Only now pay for the container probe. A live (or unobservable)
        // detached exec is left strictly alone — boot recovery or the
        // next dispatch will consume its journal.
        const executing = await worker.isWorkerExecuting(worker.workerContainerName(row.id));
        const verdict = turnWatchdog.classifyStaleTurn({
          activeTurn: row.active_turn, nowMs, busy, executing,
        });
        if (verdict !== 'reap') {
          log.warn('server', 'Stale active_turn has a live/unobservable exec — leaving for recovery', {
            sessionId: row.id, executing, startedAt: row.active_turn?.startedAt || null,
          });
          continue;
        }
        try {
          log.warn('server', 'Reaping orphaned active_turn', {
            sessionId: row.id, startedAt: row.active_turn?.startedAt || null,
          });
          await worker.clearActiveTurn(row.id);
          await appendTerminalProgressLine(pool, row.id, '[interrupted]');
          const msg = 'This coding turn was interrupted and could not be recovered — please retry your request.';
          // #786: retry pills on the breadcrumb — no wrap-up will run for
          // a reaped turn, so this row is the pill bar's only source.
          const reapPills = recoveryPills.buildRecoveryQuickReplies('unrecoverable');
          await pool.query(
            `INSERT INTO chat_session_messages (session_id, role, content, metadata)
             VALUES ($1, 'system', $2, $3)`,
            [row.id, msg, JSON.stringify(reapPills ? { quickReplies: reapPills } : {})]
          ).catch(() => {});
          broadcastGlobal({
            type: 'session_event', sessionId: row.id, event: 'status', text: msg,
            quickReplies: reapPills || undefined,
          });
          // Same "the owner cannot have watched this finish" rationale as
          // the recovered-turn notify block in resumeDetachedTurn.
          try {
            const notifications = require('./src/services/notifications');
            await pool.query(
              `UPDATE chat_sessions SET notify_on_done = FALSE WHERE id = $1`,
              [row.id]
            ).catch(() => {});
            const created = await notifications.createSessionDoneNotification(pool, {
              userId: row.user_id, appId: row.app_id, sessionId: row.id,
            });
            if (created.length) await notifications.hydrateAndPush(pool, created[0]);
          } catch (err) {
            log.warn('server', 'stale-turn reap notify failed', { sessionId: row.id, err: err.message });
          }
        } catch (err) {
          log.warn('server', 'Stale active_turn reap failed', { sessionId: row.id, err: err.message });
        }
      }
    } catch (err) {
      log.warn('server', 'Stale active_turn watchdog sweep failed', { err: err.message });
    }

    // Pass 3: staging heal. The flip side of Pass 2 — rebuild the staging
    // preview for promoted/merging sessions whose preview is missing or
    // dead. Two shapes (see stagingNeedsRebuild): staging_url IS NULL
    // (GC'd before/after promotion → no Preview button, gated on
    // staging_url in app-view.js), OR staging_url set but the container
    // is gone (Preview renders but the iframe can't connect). Their
    // preview backs the group's PR vote, so either way it must come back.
    // recoverSessions() heals these on startup; this keeps them healed
    // live without a restart. We over-fetch candidates and gate each on a
    // cheap liveness check, rebuilding at most a few per sweep so healthy
    // previews are never rebuilt and the heavy (docker build + pg clone)
    // work stays bounded. Per-session cooldown so a persistently failing
    // build (missing secret, broken manifest) doesn't retry every tick.
    try {
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url
         FROM chat_sessions cs
         JOIN apps a ON cs.app_id = a.id
         WHERE cs.status IN ('promoted', 'merging')
           AND cs.branch_name IS NOT NULL
         ORDER BY cs.promoted_at ASC NULLS FIRST
         LIMIT 50`
      );
      const MAX_HEALS_PER_SWEEP = 5;
      let healed = 0;
      for (const session of rows) {
        if (healed >= MAX_HEALS_PER_SWEEP) break;
        if (worker.isInFlight(session.id)) continue;
        if (!(await stagingRecovery.stagingNeedsRebuild(session))) continue;
        const last = stagingHealAttempts.get(session.id) || 0;
        if (Date.now() - last < STAGING_HEAL_COOLDOWN_MS) continue;
        // Stamp the attempt BEFORE the (minutes-long) build so a later
        // tick won't kick off a duplicate concurrent rebuild for the same
        // session while this one is still in flight.
        stagingHealAttempts.set(session.id, Date.now());
        healed++;
        try {
          const result = await stagingRecovery.rebuildSessionStaging({ config, pool, session, reason: 'heal' });
          if (result === 'built') stagingHealAttempts.delete(session.id);
        } catch (err) {
          log.warn('server', 'Staging heal failed', { sessionId: session.id, err: err.message });
        }
      }
    } catch (err) {
      log.warn('server', 'Staging heal sweep failed', { err: err.message });
    }

    // Pass 4: stuck-check reconcile (#447). The flip side of the merge gate
    // — a promoted PR whose proposal checks are NULL or stuck 'pending' past
    // CHECKS_STALE_MS is permanently blocked from merging ("still running its
    // tests") because nothing ever advances check_state out of 'pending'
    // after a restart mid-capture. Re-run the checks (rebuild staging if the
    // preview is gone, else recheck the live container) so legitimately-
    // passing PRs flip to 'passing' and become mergeable. Bounded per sweep
    // with a per-session cooldown, exactly like the staging-heal pass above;
    // the boot-time reconcileStuckChecks handles the restart case, this keeps
    // them healed live without a restart.
    try {
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url
           FROM chat_sessions cs
           JOIN apps a ON cs.app_id = a.id
          WHERE cs.status = 'promoted'
            AND cs.branch_name IS NOT NULL
            AND (cs.check_state IS NULL
                 OR (cs.check_state = 'pending'
                     AND cs.checks_checked_at < NOW() - make_interval(secs => $1::double precision / 1000.0))
                 OR (cs.check_state = 'error'
                     AND cs.consecutive_check_failures < $2
                     AND cs.check_next_retry_at IS NOT NULL
                     AND cs.check_next_retry_at < NOW()))
          ORDER BY cs.promoted_at ASC NULLS FIRST
          LIMIT 50`,
        [CHECKS_STALE_MS, CHECK_MAX_AUTO_RETRIES]
      );
      const MAX_RECHECKS_PER_SWEEP = 5;
      let rechecked = 0;
      for (const session of rows) {
        if (rechecked >= MAX_RECHECKS_PER_SWEEP) break;
        if (worker.isInFlight(session.id)) continue;
        const last = checkRecheckAttempts.get(session.id) || 0;
        if (Date.now() - last < STAGING_HEAL_COOLDOWN_MS) continue;
        // Stamp BEFORE the (minutes-long) recheck so a later tick won't kick
        // off a duplicate concurrent run for the same session.
        checkRecheckAttempts.set(session.id, Date.now());
        rechecked++;
        try {
          await stagingRecovery.recheckSessionChecks({ config, pool, session, reason: 'stuck-checks-sweep' });
        } catch (err) {
          log.warn('server', 'Stuck-check recheck failed', { sessionId: session.id, err: err.message });
        }
      }
    } catch (err) {
      log.warn('server', 'Stuck-check reconcile sweep failed', { err: err.message });
    }

    // Pass 5: orphaned dev-chat attachments GC (#450). An upload that was
    // never sent (message_id still NULL — the user removed it from the
    // composer, or navigated away) has no owner message to cascade from,
    // so reclaim its bytea after 24h. Linked rows live with their session.
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM chat_session_attachments
          WHERE message_id IS NULL
            AND created_at < NOW() - INTERVAL '24 hours'`
      );
      if (rowCount) log.info('server', 'GC\'d orphaned chat attachments', { count: rowCount });
    } catch (err) {
      log.warn('server', 'Orphaned-attachment sweep failed', { err: err.message });
    }

    // Pass 6: orphaned issue screenshots GC (#683). An upload whose
    // feedback modal was cancelled (issue_number still NULL — never
    // linked to a filed issue) has nothing referencing it, so reclaim
    // its bytea after 24h. Linked rows live forever with their issue.
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM issue_screenshots
          WHERE issue_number IS NULL
            AND created_at < NOW() - INTERVAL '24 hours'`
      );
      if (rowCount) log.info('server', 'GC\'d orphaned issue screenshots', { count: rowCount });
    } catch (err) {
      log.warn('server', 'Orphaned-screenshot sweep failed', { err: err.message });
    }

    // Same sweep for group-chat attachments (#694): uploads never linked
    // to a message (removed from the composer, or the tab was abandoned)
    // reclaim their bytea after 24h. Linked rows live with their message.
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM chat_message_attachments
          WHERE message_id IS NULL
            AND created_at < NOW() - INTERVAL '24 hours'`
      );
      if (rowCount) log.info('server', 'GC\'d orphaned group-chat attachments', { count: rowCount });
    } catch (err) {
      log.warn('server', 'Orphaned group-chat attachment sweep failed', { err: err.message });
    }

    // Staging app-file GC (#752): uploads made from staging previews
    // (bridge relay path, app_files.staging = TRUE) are test data and
    // reclaim their object-store bytes after 7 days. Object first, row
    // second — a row whose object delete failed is retried next sweep.
    try {
      const appFilesSvc = require('./src/services/app-files');
      const removed = await appFilesSvc.sweepStagingFiles(pool, appFilesSvc.getStore(config));
      if (removed) log.info('server', 'GC\'d expired staging app files', { count: removed });
    } catch (err) {
      log.warn('server', 'Staging app-file sweep failed', { err: err.message });
    }

    // Pass 6: imported-PR head sync (#687, Slice 3). For each OPEN imported
    // proposal, fetch the PR's current head.sha and no-op on an unchanged
    // head; on a head change reset the vote tally, post a "please
    // re-review" note, refresh drift, and re-run checks against the new
    // head (see services/pr-import-sync.js). Reuses this sweeper's cadence
    // + a per-session cooldown (importedHeadSyncAttempts) so the added
    // getPR-per-open-imported-proposal cost stays bounded.
    try {
      const prImportSync = require('./src/services/pr-import-sync');
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url
           FROM chat_sessions cs
           JOIN apps a ON cs.app_id = a.id
          WHERE cs.source = 'imported'
            AND cs.status IN ('promoted', 'merging')
            AND cs.pr_number IS NOT NULL
          ORDER BY cs.promoted_at ASC NULLS FIRST
          LIMIT 50`
      );
      const MAX_HEAD_SYNCS_PER_SWEEP = 10;
      let synced = 0;
      for (const session of rows) {
        if (synced >= MAX_HEAD_SYNCS_PER_SWEEP) break;
        if (worker.isInFlight(session.id)) continue;
        const last = importedHeadSyncAttempts.get(session.id) || 0;
        if (Date.now() - last < IMPORTED_HEAD_SYNC_COOLDOWN_MS) continue;
        // Stamp BEFORE the getPR (+ possible minutes-long rebuild) so a
        // later tick won't kick off a duplicate concurrent sync.
        importedHeadSyncAttempts.set(session.id, Date.now());
        synced++;
        try {
          await prImportSync.syncImportedProposal({ config, pool, session });
        } catch (err) {
          log.warn('server', 'Imported-PR head sync failed', { sessionId: session.id, err: err.message });
        }
      }
    } catch (err) {
      log.warn('server', 'Imported-PR head-sync sweep failed', { err: err.message });
    }
  }, config.sessionSweepIntervalMs).unref();
}

let stalePrSweeperHandle = null;

// Stale-promoted-PR policy + reversible-archive hard GC.
//   Pass 1 (notify): a promoted PR with no voting interest for
//     PR_STALE_NOTIFY_MS gets its author a 'stale_pr' notification, and
//     we stamp stale_notified_at so the warning fires once.
//   Pass 2 (archive): if still untouched PR_STALE_GRACE_MS after that
//     warning, auto-archive it (reversible — keeps CC + branch).
//   Pass 3 (GC): archived sessions past ARCHIVED_RETENTION_MS get their
//     CC volume purged so memory stops occupying disk.
// "Interest" = the later of promoted_at and the newest vote; casting a
// vote clears stale_notified_at (see routes/votes.js), reviving the PR.
function startStalePrSweeper(config) {
  if (stalePrSweeperHandle) return;
  const notifyEnabled = config.prStaleNotifyMs > 0;
  const gcEnabled = config.archivedRetentionMs > 0;
  if (!notifyEnabled && !gcEnabled) {
    log.info('server', 'Stale-PR / archived-GC sweeper disabled');
    return;
  }
  const pool = getPool(config);
  const notifications = require('./src/services/notifications');
  log.info('server', 'Stale-PR / archived-GC sweeper started', {
    notifyMs: config.prStaleNotifyMs, graceMs: config.prStaleGraceMs,
    retentionMs: config.archivedRetentionMs, intervalMs: config.staleSweepIntervalMs,
  });
  const { checkAndMerge } = require('./src/routes/votes');
  const issuesModule = require('./src/routes/issues');
  const governance = require('./src/services/governance');
  const appAdmins = require('./src/services/app-admins');
  stalePrSweeperHandle = setInterval(async () => {
    if (lifecycle.isShuttingDown()) return;

    // Pass 0: window-elapsed merges. A promoted PR can become mergeable
    // purely through the passage of time, with no further vote to drive
    // checkAndMerge — either the threshold path (eased Yes threshold met,
    // minimum visibility window elapses) or the lazy-consensus path (below
    // threshold but unopposed Yes lead, its count-based clock elapses —
    // silence is consent). This pass re-checks each promoted PR's gate and
    // fires the merge once its window has elapsed. Latency is bounded by
    // staleSweepIntervalMs (default 1h) — acceptable; see SPEC "Post-window
    // latency". checkAndMerge re-validates and claims atomically, so a
    // racing vote can't double-merge.
    try {
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug AS app_slug, a.repo_url, a.self_hosted AS app_self_hosted,
                (SELECT COUNT(*)::int FROM pr_votes WHERE session_id = cs.id AND vote = 'yes') AS yes_count,
                (SELECT COUNT(*)::int FROM pr_votes WHERE session_id = cs.id AND vote = 'no')  AS no_count
           FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
          WHERE cs.status = 'promoted' AND cs.is_headless = FALSE
            AND (cs.behind_main IS NULL OR cs.behind_main = 0)
          LIMIT 100`
      );
      for (const session of rows) {
        if (worker.isInFlight(session.id)) continue;
        try {
          // #788: backfill the explicit-approval flag for never-classified
          // rows AND re-verify rows stored TRUE (a flag can go stale once
          // main moves or a sync rewrites the branch); FALSE rows are
          // skipped. All the policy lives in
          // services/app-admins.js sweepExplicitApproval.
          session.requires_explicit_approval =
            await appAdmins.sweepExplicitApproval(pool, session);
          // #646: governance-aware gate — honors the app's approver
          // policy + at-least-N mode (governance/electorate lookups are
          // TTL-cached in the service, so no per-app cache needed here).
          // #788: plus the no-timer modifier for an admins-changing
          // proposal, so the sweeper can never auto-merge one on a clock.
          const gate = await governance.governedGate(pool, session.app_id, {
            kind: 'pr', id: session.id,
            openedAt: session.promoted_at || session.created_at,
            explicitApproval: !!session.requires_explicit_approval,
            // #687 Slice 3: keep this pre-filter consistent with the
            // head-scoped gate checkAndMerge applies to imported rows.
            headSha: session.source === 'imported' ? (session.imported_pr_head_sha || null) : null,
          });
          // Merge takes precedence: a row that just became mergeable should
          // merge, not reject. checkAndMerge re-confirms both gates atomically.
          if (gate.mergeable) {
            const result = await checkAndMerge(config, pool, session);
            if (result?.merged) {
              log.info('server', 'Window-elapsed PR merged by sweeper', {
                sessionId: session.id, yesCount: session.yes_count,
              });
            }
            continue;
          }
          // Auto-takedown: the rejection window has elapsed on a promoted PR
          // the group is voting down (No > Yes, under the keep-alive support
          // line). Reuse the real close/un-promote path (archiveSession),
          // then nudge clients to refetch /promoted so the row drops out (the
          // session_update 'archived' broadcast isn't wired to the vote panel).
          if (gate.rejectable) {
            const res = await sessionLifecycle.archiveSession({
              pool, sessionId: session.id, reason: 'auto-rejected',
            });
            if (res?.archived) {
              try {
                ws.pushVoteUpdate({
                  sessionId: session.id, appSlug: session.app_slug, merged: false,
                });
              } catch {}
              log.info('server', 'Promoted PR auto-rejected by sweeper', {
                sessionId: session.id,
                yesCount: session.yes_count, noCount: session.no_count,
              });
            }
          }
        } catch (err) {
          log.warn('server', 'Window-elapsed merge check failed', {
            sessionId: session.id, err: err.message,
          });
        }
      }
    } catch (err) {
      log.warn('server', 'Window-elapsed merge sweep failed', { err: err.message });
    }

    // Pass 0b: window-elapsed governance applies (rename + secret_change +
    // close_issue). Same rationale as Pass 0 — an open governance proposal
    // can satisfy both gates with no further vote. The apply helpers re-check
    // the gate and lock the issue row atomically, so this can't double-apply
    // against a vote. close_issue rows are dispatched UNCONDITIONALLY (not
    // just when mergeable): maybeApplyCloseIssueProposal runs its superseded
    // guard on every invocation, so the hourly sweep doubles as the catch-all
    // that retires proposals whose target was closed by hand on GitHub. The
    // guard reads the cached fetchPublicIssues — one cheap fetch per app.
    try {
      const { rows } = await pool.query(
        `SELECT i.*, a.slug AS app_slug, a.repo_url,
                (SELECT COUNT(*)::int FROM issue_votes WHERE issue_id = i.id AND vote = 'up')   AS up_count,
                (SELECT COUNT(*)::int FROM issue_votes WHERE issue_id = i.id AND vote = 'down') AS down_count
           FROM issues i JOIN apps a ON a.id = i.app_id
          WHERE i.status = 'open' AND i.kind IN ('rename', 'secret_change', 'close_issue')
          LIMIT 100`
      );
      for (const issue of rows) {
        try {
          if (issue.kind === 'close_issue') {
            await issuesModule.maybeApplyCloseIssueProposal(pool, issue);
            continue;
          }
          // #646: governance-aware gate for issue-vote proposals too.
          const gate = await governance.governedGate(pool, issue.app_id, {
            kind: 'issue', id: issue.id, openedAt: issue.created_at,
          });
          if (!gate.mergeable) continue;
          if (issue.kind === 'rename') {
            await issuesModule.maybeApplyRenameProposal(pool, issue);
          } else {
            await issuesModule.maybeApplySecretChangeProposal(config, pool, issue);
          }
        } catch (err) {
          log.warn('server', 'Window-elapsed governance apply failed', {
            issueId: issue.id, err: err.message,
          });
        }
      }
    } catch (err) {
      log.warn('server', 'Window-elapsed governance sweep failed', { err: err.message });
    }

    if (notifyEnabled) {
      // Pass 1: warn authors of quiet promoted PRs (once).
      try {
        const { rows } = await pool.query(
          `SELECT cs.id AS session_id, cs.user_id, cs.app_id, cs.pr_title, cs.pr_number,
                  a.slug AS app_slug, a.name AS app_name
           FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
           WHERE cs.status = 'promoted'
             AND cs.stale_notified_at IS NULL
             AND GREATEST(
                   COALESCE(cs.promoted_at, cs.created_at),
                   COALESCE((SELECT MAX(created_at) FROM pr_votes WHERE session_id = cs.id), cs.promoted_at, cs.created_at)
                 ) < NOW() - make_interval(secs => $1::double precision / 1000.0)
           LIMIT 50`,
          [config.prStaleNotifyMs]
        );
        for (const row of rows) {
          try {
            const inserted = await notifications.createStalePrNotification(pool, {
              userId: row.user_id, appId: row.app_id, sessionId: row.session_id,
            });
            await pool.query(`UPDATE chat_sessions SET stale_notified_at = NOW() WHERE id = $1`, [row.session_id]);
            if (inserted[0]) {
              ws.pushNotificationToUser(row.user_id, {
                type: 'notification_new',
                notification: notifications.serialize({
                  id: inserted[0].id, kind: 'stale_pr', read_at: null, created_at: inserted[0].created_at,
                  app_id: row.app_id, app_slug: row.app_slug, app_name: row.app_name,
                  chat_message_id: null, message_content: null,
                  session_id: row.session_id, pr_title: row.pr_title, pr_number: row.pr_number,
                  source_username: null, detail: null,
                }),
              });
            }
          } catch (err) {
            log.warn('server', 'Stale-PR notify failed', { sessionId: row.session_id, err: err.message });
          }
        }
      } catch (err) {
        log.warn('server', 'Stale-PR notify sweep failed', { err: err.message });
      }

      // Pass 2: archive PRs still untouched after the grace period.
      try {
        const { rows } = await pool.query(
          `SELECT id FROM chat_sessions
           WHERE status = 'promoted' AND stale_notified_at IS NOT NULL
             AND stale_notified_at < NOW() - make_interval(secs => $1::double precision / 1000.0)
           LIMIT 50`,
          [config.prStaleGraceMs]
        );
        for (const row of rows) {
          if (worker.isInFlight(row.id)) continue;
          try {
            await sessionLifecycle.archiveSession({ pool, sessionId: row.id, reason: 'stale-pr' });
          } catch (err) {
            log.warn('server', 'Stale-PR archive failed', { sessionId: row.id, err: err.message });
          }
        }
      } catch (err) {
        log.warn('server', 'Stale-PR archive sweep failed', { err: err.message });
      }
    }

    if (gcEnabled) {
      // Pass 3: hard-GC archived CC volumes past the retention window.
      try {
        const { rows } = await pool.query(
          `SELECT id FROM chat_sessions
           WHERE status = 'archived' AND cc_purged = FALSE AND archived_at IS NOT NULL
             AND archived_at < NOW() - make_interval(secs => $1::double precision / 1000.0)
           LIMIT 50`,
          [config.archivedRetentionMs]
        );
        for (const row of rows) {
          try {
            await sessionLifecycle.purgeArchivedCc({ pool, sessionId: row.id });
          } catch (err) {
            log.warn('server', 'Archived CC GC failed', { sessionId: row.id, err: err.message });
          }
        }
      } catch (err) {
        log.warn('server', 'Archived CC GC sweep failed', { err: err.message });
      }
    }
  }, config.staleSweepIntervalMs).unref();
}

// Graceful shutdown: mark drain state so new chats/app-creates/builds get
// 503'd, wait up to DRAIN_TIMEOUT_MS for in-flight HTTP handlers to
// finish flushing DB writes, then exit.
//
// IMPORTANT: we deliberately do NOT force-remove worker containers here.
// Two reasons in the long-lived worker world:
//   - In-flight execs (workers in `activeWorkers`): killing them would
//     drop the user's turn mid-CC. Better to drain naturally; if the
//     drain times out the host-side `docker exec` child dies with us
//     and recoverActiveWorkers handles the orphan on restart.
//   - Warm-idle workers (NOT in `activeWorkers`): these are siblings
//     on the host Docker daemon, so they survive a `docker compose up`
//     redeploy of the server. Next boot's recoverActiveWorkers adopts
//     them as warm-idle, so the next dispatch is fast even across
//     production redeploys. The idle sweeper reclaims their memory in
//     steady state.
// Right-sized for deploys (#711): Docker SIGKILLs at stop_grace_period
// (docker-compose.yml, 10s), so the old 60s wait was unreachable dead
// time — and workers are deliberately restart-safe anyway (adopted by
// recoverActiveWorkers on the next boot), so waiting out a whole CC turn
// buys nothing. 5s is enough for in-flight HTTP handlers to flush DB
// writes while keeping the deploy cutover short. Must stay BELOW the
// compose stop_grace_period (tests/caddy-deploy-grace.test.js pins the
// relationship).
const DRAIN_TIMEOUT_MS = 5000;
// Budget for closing the pg pool after the handler drain (#767). Sits
// INSIDE the same compose stop_grace_period as DRAIN_TIMEOUT_MS —
// tests/caddy-deploy-grace.test.js pins DRAIN + POOL_CLOSE <= grace — so a
// pool that refuses to settle can never push the exit past the SIGKILL.
const POOL_CLOSE_TIMEOUT_MS = 1000;
let cleanupStarted = false;
// Set by start() once the listener is up. cleanup() runs at module scope,
// so both need to be reachable from here.
let httpServer = null;
let shutdownPool = null;

async function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  lifecycle.setShuttingDown();

  // Stop accepting BEFORE draining. Caddy's apex proxy and the wildcard
  // forward_auth gate both hold-and-retry a refused dial for 30s
  // (Caddyfile, #711), so a connection refused during the drain is
  // re-dialled into the new container — strictly better than accepting a
  // request into a process that is about to exit. Idle keep-alives are
  // dropped at once; connections still serving a request get until the
  // drain deadline, then closeAllConnections cuts them so `close()` can
  // actually complete.
  if (httpServer) {
    try {
      httpServer.close(() => {});
      httpServer.closeIdleConnections?.();
      const cutoff = setTimeout(() => {
        try { httpServer.closeAllConnections?.(); } catch { /* already gone */ }
      }, DRAIN_TIMEOUT_MS);
      cutoff.unref?.();
      log.info('server', 'Listener closed to new connections', { timeoutMs: DRAIN_TIMEOUT_MS });
    } catch (err) {
      log.warn('server', 'Listener close failed', { err: err.message });
    }
  }
  if (sweeperHandle) {
    clearInterval(sweeperHandle);
    sweeperHandle = null;
  }
  if (sessionSweeperHandle) {
    clearInterval(sessionSweeperHandle);
    sessionSweeperHandle = null;
  }
  if (stalePrSweeperHandle) {
    clearInterval(stalePrSweeperHandle);
    stalePrSweeperHandle = null;
  }

  const startingCount = getActiveWorkerCount();
  log.info('server', 'Shutdown initiated, draining handlers', {
    activeWorkers: startingCount, timeoutMs: DRAIN_TIMEOUT_MS,
  });

  const drained = await lifecycle.waitFor(() => getActiveWorkerCount() === 0, {
    timeoutMs: DRAIN_TIMEOUT_MS, intervalMs: 500,
  });

  if (!drained) {
    log.warn('server', 'Drain timeout — exiting; workers keep running and will be adopted on restart', {
      remaining: getActiveWorkerCount(),
    });
  } else if (startingCount > 0) {
    log.info('server', 'All handlers drained; worker containers persist across restart');
  }

  // Close the pg pool so in-flight queries settle instead of being severed
  // by process.exit(). Bounded: a pool that won't drain must not hold the
  // process past the SIGKILL deadline.
  if (shutdownPool) {
    const poolStartedAt = Date.now();
    // Deliberately NOT unref'd, unlike the drain cutoff above: this timer
    // is what guarantees forward progress to process.exit(0) when end()
    // never settles. Unref'ing it would let the loop drain empty and exit
    // implicitly instead, skipping the exit log. Cleared the moment the
    // race resolves so it holds the loop for at most POOL_CLOSE_TIMEOUT_MS.
    let poolTimer = null;
    try {
      await Promise.race([
        shutdownPool.end(),
        new Promise((resolve) => { poolTimer = setTimeout(resolve, POOL_CLOSE_TIMEOUT_MS); }),
      ]);
      log.info('server', 'Pool closed', { durationMs: Date.now() - poolStartedAt });
    } catch (err) {
      log.warn('server', 'Pool close failed', {
        err: err.message, durationMs: Date.now() - poolStartedAt,
      });
    } finally {
      if (poolTimer) clearTimeout(poolTimer);
    }
  }

  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
