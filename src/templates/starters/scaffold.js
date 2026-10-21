'use strict';

/**
 * Shared builders for the four starter templates (./social.js, ./media.js,
 * ./game2d.js, ./game3d.js).
 *
 * A starter replaces exactly two entries of the base scaffold that
 * src/services/template.js writes — `server.js` and `public/index.html` —
 * so every platform rule is inherited from the base rather than copied:
 * the RS256/issuer/audience/`pur` identity checks, the public-path set, the
 * hosted-asset proxy, the auth gate, the static mount and the unauthenticated
 * landing page all live here once. A starter module supplies only its API
 * routes, its `CREATE TABLE IF NOT EXISTS` block, its screen and its script.
 *
 * The dev-console forwarder comes from services/template.js, the single copy
 * the base scaffold injects, so a starter's document reports console errors
 * to the shell exactly as the empty template does. template.js requires this
 * registry lazily inside getTemplateFiles(), which is what keeps that
 * require from becoming a cycle.
 */

const { DEV_CONSOLE_FORWARDER } = require('../../services/template');

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The one line every starter screen carries: what it is and how to replace
 * it. The sentinel pair lets the project's own coding agent find and remove
 * the block, like the base scaffold's welcome block.
 */
function starterNotice(name) {
  return `    <!-- usernode-starter-notice@1 — starter-template messaging. When building
         the user's real app, replace this whole screen and delete this block,
         both sentinel comments included. -->
    <p class="text-xs leading-relaxed text-zinc-600">Starter template: ${name}. Replace this screen from the Homeroom icon's Start a new change row.</p>
    <!-- /usernode-starter-notice@1 -->`;
}

/**
 * The starter page: the same head, stylesheet and bridge as the base
 * scaffold, a dark ground, one centred column, and the starter's own script.
 * `body` is the column's content; `script` is the inline script's source.
 */
function starterDocument({ appName, starter, body, script }) {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${DEV_CONSOLE_FORWARDER}
  <title>${escapeHtml(appName)}</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='45' fill='%237c3aed'/><circle cx='50' cy='50' r='18' fill='white'/></svg>">
  <!-- Compiled from THIS document by the app's own image build; every class
       name is a whole literal so Tailwind's extractor can see it. -->
  <link rel="stylesheet" href="/tailwind.css">
  <!-- The platform bridge, loaded by relative path. It is also how the page
       answers the shell, and how "Share a photo" reaches platform storage. -->
  <script src="/usernode-bridge/v1/bridge.js"></script>
</head>
<body class="bg-zinc-950 text-zinc-100 min-h-screen">
  <main class="mx-auto flex max-w-md flex-col gap-5 px-4 py-10">
${body}
${starterNotice(starter)}
  </main>

  <script>
${script}
  </script>
</body>
</html>
`;
}

/**
 * The starter server: the base scaffold's server with only `api` (Express
 * routes) and `schema` (the SQL that runs in start()) changed. Everything
 * that authenticates a person or serves the platform assets is byte-for-byte
 * the base scaffold's, so the security surface cannot drift between
 * templates.
 */
function starterServer({ api, schema, slug }) {
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

// The platform's centrally hosted files are reachable at these paths on this
// app's OWN origin, so index.html loads them with a relative path and never
// names the platform's hostname.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\\/+$/, '');

app.get(/^\\/usernode-(?:bridge|native|tailwind)\\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds \`?token=…\` on
// load; the frontend script forwards the token via \`x-usernode-token\` on
// subsequent fetches.
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
  // shell are gated so direct hits to the staging/prod subdomain don't leak
  // app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG icon
// instead. Answer 204 here so anything that still probes /favicon.ico does
// not fall through to the auth-gated catch-all.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

${api}
app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser) are sent to the platform's
// chromeless view of this app, where the shell embeds it with a real token.
// Every other tokenless case (iframe loads with an expired token) gets the
// "open in Homeroom" landing page instead of a redirect.
app.get('*', (req, res) => {
  if (!req.user) {
    // Deep-link pass-through (platform #743): carry the visited path+query
    // into the chromeless view so share links land on the shared screen.
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
  await pool.query(\`${schema}\`);
  const server = app.listen(port, () => console.log(\`Listening on :\${port}\`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

start().catch(err => { console.error(err); process.exit(1); });
`;
}

module.exports = {
  escapeHtml,
  starterNotice,
  starterDocument,
  starterServer,
};
