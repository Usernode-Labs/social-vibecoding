'use strict';

// Shared builders for the app starters (src/templates/app-starters).
//
// Every starter is a small, working app: it ships a server.js and a
// public/index.html into the new repository, plus the four pieces of
// documentation (CLAUDE.md's "Starter template" section and README's demo
// list) that every create path writes. The scaffold around them (Dockerfile,
// package files, Tailwind config, ignore files, project.toml, dapp.json and
// .claude/) is the same in every starter and stays in services/template.js.
//
// The pieces here are deliberately small: a starter supplies only its table
// bootstrap, its route code, its screen markup and its client script. The
// auth middleware, the hosted-asset proxy, health, the favicon answer, the
// static mount and the auth-gated catch-all are shared, so a starter can
// never drift from the platform's security model.
//
// Nothing here adds a dependency: every starter runs on express, pg and
// jsonwebtoken, the three the scaffold's package.json already carries.

// Forwarder snippet injected into every scaffolded app's public/index.html.
// Captures console.log/info/warn/error/debug + uncaught errors +
// unhandled promise rejections and posts them to `window.parent` via
// postMessage. The Homeroom platform shell listens for these to power
// the in-app developer console (header icon + log panel).
//
// Sentinel: usernode-dev-console@1 (keep this marker so updates/tooling
// can locate and replace the block in the future).
const DEV_CONSOLE_FORWARDER = `
  <script>
  // usernode-dev-console@1
  (function () {
    if (window.__usernodeDevConsole) return;
    window.__usernodeDevConsole = true;
    var S = '__usernodeDevConsole';
    function serialize(v, depth) {
      depth = depth || 0;
      try {
        if (v === undefined) return 'undefined';
        if (v === null) return 'null';
        if (typeof v === 'string') return v;
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        if (typeof v === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
        if (v instanceof Error) return (v.stack || (v.name + ': ' + v.message));
        if (depth > 3) return '[…]';
        var seen = new WeakSet();
        return JSON.stringify(v, function (k, val) {
          if (typeof val === 'object' && val !== null) {
            if (seen.has(val)) return '[Circular]';
            seen.add(val);
          }
          if (typeof val === 'function') return '[Function ' + (val.name || 'anonymous') + ']';
          if (val instanceof Error) return val.stack || (val.name + ': ' + val.message);
          return val;
        });
      } catch (e) { try { return String(v); } catch (_) { return '[unserializable]'; } }
    }
    function post(level, args, meta) {
      try {
        var payload = {
          sentinel: S,
          level: level,
          args: Array.prototype.slice.call(args).map(function (a) { return serialize(a); }),
          ts: Date.now(),
          url: location.href,
        };
        if (meta) for (var k in meta) payload[k] = meta[k];
        if (window.parent && window.parent !== window) {
          window.parent.postMessage(payload, '*');
        }
      } catch (_) {}
    }
    ['log','info','warn','error','debug'].forEach(function (level) {
      var orig = console[level] ? console[level].bind(console) : function () {};
      console[level] = function () { post(level, arguments); orig.apply(null, arguments); };
    });
    window.addEventListener('error', function (e) {
      var msg = (e.error && (e.error.stack || e.error.message)) || e.message || 'Error';
      post('error', [msg], { source: e.filename || '', line: e.lineno || 0, col: e.colno || 0, kind: 'error' });
    });
    window.addEventListener('unhandledrejection', function (e) {
      var r = e.reason;
      var msg = (r && (r.stack || r.message)) || String(r);
      post('error', [msg], { kind: 'unhandledrejection' });
    });
    try { post('info', ['[dev-console ready]'], { kind: 'ready' }); } catch (_) {}
  })();
  </script>`;

const FAVICON_LINK = `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='45' fill='%237c3aed'/><circle cx='50' cy='50' r='18' fill='white'/></svg>">`;

const CHECK_SVG = `<svg class="w-5 h-5 text-violet-400 shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7 7a1 1 0 0 1-1.4 0l-3-3a1 1 0 1 1 1.4-1.4L9 11.6l6.3-6.3a1 1 0 0 1 1.4 0Z" clip-rule="evenodd"/></svg>`;

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function workingRows(items) {
  return items.map((item) => `        <div class="flex items-start gap-3 p-4">
          ${CHECK_SVG}
          <div>
            <p class="text-sm font-semibold text-zinc-100">${item.title}</p>
            <p class="text-sm text-zinc-400">${item.text}</p>
          </div>
        </div>`).join('\n');
}

/**
 * public/index.html for a starter. The hero, the "What's already working"
 * card and the example all sit inside the usernode-starter-notice@1
 * sentinel pair, so the coding agent removes the starter wholesale on the
 * first real feature. `intro` is the one line about this starter; `example`
 * is the markup of the "Try the example" card's body; `script` runs inside
 * the page's own `<script>`, after the shared token preamble.
 */
function page({ appName, intro, working, example, script, style = '' }) {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${DEV_CONSOLE_FORWARDER}
  <title>${escapeHtml(appName)}</title>
  ${FAVICON_LINK}
  <link rel="stylesheet" href="/tailwind.css">${style ? `
  <style>${style}</style>` : ''}
  <script src="/usernode-bridge/v1/bridge.js"></script>
</head>
<body class="bg-zinc-950 text-zinc-100 min-h-screen">
  <main class="max-w-md mx-auto px-4 py-10 flex flex-col gap-6">

    <!-- usernode-starter-notice@1 — starter-template messaging. When building
         the user's real app, replace this whole screen and delete this block,
         both sentinel comments included. -->
    <section class="rounded-2xl border border-violet-500/30 bg-gradient-to-b from-violet-600/20 to-transparent p-6 text-center flex flex-col items-center gap-3">
      <span class="inline-block rounded-full bg-violet-600/20 text-violet-300 text-xs font-semibold uppercase tracking-wide px-3 py-1">Starter template</span>
      <h1 class="text-2xl font-bold">${escapeHtml(appName)}</h1>
      <p class="text-sm text-zinc-300 leading-relaxed">${intro}</p>
      <p class="text-sm text-zinc-300 leading-relaxed">Tap the <strong class="text-violet-300 font-semibold">Homeroom icon</strong> in the header and choose <strong class="text-violet-300 font-semibold">Start a new change</strong> to start building your app. Describe what you'd like in plain English, and it will be turned into your real app.</p>
    </section>

    <section>
      <h2 class="text-sm font-medium text-zinc-500 mb-2 px-1">What's already working</h2>
      <div class="rounded-xl border border-zinc-800 bg-zinc-900/60 divide-y divide-zinc-800">
${workingRows(working)}
      </div>
    </section>

    <section class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 flex flex-col gap-4">
      <div class="w-full flex items-baseline justify-between gap-2">
        <h2 class="text-sm font-medium text-zinc-500">Try the example</h2>
        <span class="text-xs text-zinc-600">This example will be replaced</span>
      </div>
${example}
    </section>
    <!-- /usernode-starter-notice@1 -->

    <p class="text-center text-xs text-zinc-600">Built on Homeroom — this starter screen disappears once you build your real app.</p>
  </main>

  <script>
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const headers = token ? { 'x-usernode-token': token } : {};
    function esc(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
${script}
  </script>
</body>
</html>
`;
}

/**
 * server.js for a starter: the platform security model verbatim, with the
 * starter's own table bootstrap and routes plugged in. `bootstrap` is SQL
 * run at start; `routes` is Express route code using the shared `app` and
 * `pool`.
 */
function server({ slug, bootstrap, routes }) {
  return `const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\\\n/g, '\\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Paths that stay open without authentication. Add a path here (and add it
// with \`app.get\`/\`app.post\` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// \`node server.js\`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\\/+$/, '');

app.get(/^\\/usernode-(?:bridge|native|tailwind)\\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds \`?token=…\`
// on load; the frontend script forwards the token via \`x-usernode-token\`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without \`algorithms\` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // \`pur\` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

${routes}

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores \`path\`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\\/[A-Za-z0-9\\-._~!$&()*+,;=:@\\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/${slug}/full' + deepPath);
    }
    return res.status(401).send(\`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="\${PLATFORM_ORIGIN}/app/${slug}/full\${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>\`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await pool.query(\`
${bootstrap}
  \`);
  const server = app.listen(port, () => console.log('Listening on :' + port));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

start().catch(err => { console.error(err); process.exit(1); });
`;
}

module.exports = { DEV_CONSOLE_FORWARDER, escapeHtml, page, server, workingRows };
