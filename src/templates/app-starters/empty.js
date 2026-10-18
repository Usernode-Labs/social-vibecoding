'use strict';

// The empty starter: today's Press! example, moved here unchanged. This is
// what "Start from scratch" creates and what every pre-template app already
// has, so its files are byte-for-byte the ones services/template.js used to
// write. tests/template-starter-notice.test.js, template-favicon.test.js,
// template-tailwind.test.js and scaffold-token-compat.test.js keep passing
// unchanged, which is the proof.

const { escapeHtml } = require('./base');

module.exports = {
  key: 'empty',
  name: 'Start from scratch',
  caption: 'An empty app. Describe what you want and build it with the group.',

  index({ appName }) {
    return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${require('./base').DEV_CONSOLE_FORWARDER}
  <title>${escapeHtml(appName)}</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='45' fill='%237c3aed'/><circle cx='50' cy='50' r='18' fill='white'/></svg>">
  <!-- Tailwind, PRECOMPILED for this app (was cdn.tailwindcss.com's
       in-browser engine plus an inline tailwind.config here). The config
       moved to tailwind.config.js in the repo root; npm run build compiles
       it to public/tailwind.css with Docker or Paketo on every image build, so the
       stylesheet is regenerated from THIS commit's markup every deploy and
       can never drift behind the code. ~7 KB of CSS instead of a ~400 KB
       engine, and no flash of unstyled content.
       Writing class names as whole literals is what keeps this working — a
       class assembled from fragments at runtime (e.g. "bg-" + tone + "-500")
       is invisible to the compiler. If you genuinely need runtime-generated
       classes, swap this link for the platform-hosted engine instead:
       <script src="/usernode-tailwind/v1/tailwind.js"></script> -->
  <link rel="stylesheet" href="/tailwind.css">
  <!-- The platform bridge, centrally hosted and loaded by RELATIVE path (the
       handler in server.js serves it under a plain "node server.js"; the
       platform's edge answers it everywhere else). Never vendor it and never
       write a hostname in front of it.
       It is NOT conditional on this app calling a bridge API: it is also how
       the app ANSWERS the shell, so a scaffold without it is invisible to
       anything that asks the frame a question. Offline launch is one of those.
       Another is the page's colour: the bridge reports this document's opaque
       ground to the shell (#1581), which is what makes the platform bar above
       the app take the app's tone instead of the viewer's theme (#1945). This
       scaffold paints a dark page (bg-zinc-950 on the body element), so
       without this tag a brand-new app sits under a light bar. -->
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
      <p class="text-sm text-zinc-300 leading-relaxed">Welcome to your new app! Everything on this screen is placeholder content that came with it.</p>
      <p class="text-sm text-zinc-300 leading-relaxed">Tap the <strong class="text-violet-300 font-semibold">Homeroom icon</strong> in the header and choose <strong class="text-violet-300 font-semibold">Start a new change</strong> to start building your app. Describe what you'd like in plain English, and it will be turned into your real app.</p>
    </section>

    <section>
      <h2 class="text-sm font-medium text-zinc-500 mb-2 px-1">What's already working</h2>
      <div class="rounded-xl border border-zinc-800 bg-zinc-900/60 divide-y divide-zinc-800">
        <div class="flex items-start gap-3 p-4">
          <svg class="w-5 h-5 text-violet-400 shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7 7a1 1 0 0 1-1.4 0l-3-3a1 1 0 1 1 1.4-1.4L9 11.6l6.3-6.3a1 1 0 0 1 1.4 0Z" clip-rule="evenodd"/></svg>
          <div>
            <p class="text-sm font-semibold text-zinc-100">Sign-in</p>
            <p class="text-sm text-zinc-400">You're signed in through Homeroom automatically — no accounts to build.</p>
          </div>
        </div>
        <div class="flex items-start gap-3 p-4">
          <svg class="w-5 h-5 text-violet-400 shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7 7a1 1 0 0 1-1.4 0l-3-3a1 1 0 1 1 1.4-1.4L9 11.6l6.3-6.3a1 1 0 0 1 1.4 0Z" clip-rule="evenodd"/></svg>
          <div>
            <p class="text-sm font-semibold text-zinc-100">Database</p>
            <p class="text-sm text-zinc-400">Your app has its own private database, ready to store things.</p>
          </div>
        </div>
        <div class="flex items-start gap-3 p-4">
          <svg class="w-5 h-5 text-violet-400 shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7 7a1 1 0 0 1-1.4 0l-3-3a1 1 0 1 1 1.4-1.4L9 11.6l6.3-6.3a1 1 0 0 1 1.4 0Z" clip-rule="evenodd"/></svg>
          <div>
            <p class="text-sm font-semibold text-zinc-100">Live API</p>
            <p class="text-sm text-zinc-400">The example below talks to a real server — try it.</p>
          </div>
        </div>
      </div>
    </section>
    <!-- /usernode-starter-notice@1 -->

    <section class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 flex flex-col items-center gap-5">
      <div class="w-full flex items-baseline justify-between gap-2">
        <h2 class="text-sm font-medium text-zinc-500">Try the example</h2>
        <span class="text-xs text-zinc-600">This example will be replaced</span>
      </div>

      <button id="press-btn" class="w-32 h-32 rounded-full bg-violet-600 hover:bg-violet-500 active:scale-95 transition-all text-white text-xl font-bold shadow-lg shadow-violet-600/30">
        Press!
      </button>

      <div id="count" class="text-lg text-zinc-400">0 total presses</div>

      <div class="w-full max-w-sm">
        <h3 class="text-sm font-medium text-zinc-500 mb-2 text-center">Leaderboard</h3>
        <div id="leaderboard" class="space-y-1"></div>
      </div>
    </section>

    <p class="text-center text-xs text-zinc-600">Built on Homeroom — this template screen disappears once you build your real app.</p>
  </main>

  <script>
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const headers = token ? { 'x-usernode-token': token } : {};

    async function loadLeaderboard() {
      const res = await fetch('/api/leaderboard', { headers });
      if (!res.ok) return;
      const { leaderboard } = await res.json();
      const el = document.getElementById('leaderboard');
      if (!leaderboard.length) {
        el.innerHTML = '<p class="text-center text-zinc-600 text-sm">No presses yet</p>';
        return;
      }
      el.innerHTML = leaderboard.map((r, i) =>
        '<div class="flex justify-between px-3 py-1 rounded ' + (i === 0 ? 'bg-violet-600/20 text-violet-300' : 'text-zinc-400') + '">' +
        '<span>' + (i + 1) + '. ' + r.username + '</span>' +
        '<span class="font-mono">' + r.presses + '</span></div>'
      ).join('');
      const total = leaderboard.reduce((s, r) => s + parseInt(r.presses), 0);
      document.getElementById('count').textContent = total + ' total presses';
    }

    document.getElementById('press-btn').addEventListener('click', async () => {
      try {
        const res = await fetch('/api/press', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
        });
        if (res.ok) loadLeaderboard();
        else if (res.status === 401) document.getElementById('count').textContent = 'Sign in to press!';
      } catch {}
    });

    loadLeaderboard();
  </script>
</body>
</html>
`;
  },

  server({ slug }) {
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
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local \`node server.js\`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
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

// Button press
app.post('/api/press', async (req, res) => {
  try {
    await pool.query(\`
      INSERT INTO presses (user_id, username) VALUES ($1, $2)
    \`, [req.user.id, req.user.username]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Leaderboard
app.get('/api/leaderboard', async (_req, res) => {
  try {
    const { rows } = await pool.query(\`
      SELECT username, COUNT(*) as presses
      FROM presses
      GROUP BY username
      ORDER BY presses DESC
      LIMIT 50
    \`);
    res.json({ leaderboard: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    CREATE TABLE IF NOT EXISTS presses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  \`);
  const server = app.listen(port, () => console.log(\`Listening on :\${port}\`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

start().catch(err => { console.error(err); process.exit(1); });
`;
  },

  claudeStarter: `## Starter template

The screen this app currently ships — the hero, the "What's already
working" card, and the Press! example (the demo markup in
\`public/index.html\`, the \`/api/press\` and \`/api/leaderboard\` routes, and
the \`presses\` table bootstrap in \`server.js\`) — is placeholder content
from the Homeroom starter template, not product intent.

When the user asks for their first real feature, REPLACE the template
screen rather than building alongside it:

- remove the \`usernode-starter-notice@1\` block in \`public/index.html\`
  (both sentinel comments and everything between them),
- remove or repurpose the "Try the example" card, its demo endpoints and
  the \`presses\` table as appropriate,
- rewrite \`README.md\` to describe the actual app.

Keep the \`usernode-dev-console@1\` forwarder \`<script>\` when rewriting the
HTML — that block is platform infrastructure, not template content.`,

  readmeDemo: `- **Sign-in** — the server verifies the platform-issued user token
  (an RS256 JWT) on every request, so the app already knows who is
  using it. No accounts to build.
- **Database** — the app has its own private Postgres database; the
  demo stores button presses in a \`presses\` table.
- **Live API** — two example routes (\`/api/press\`,
  \`/api/leaderboard\`) read and write through a real Express server.
- **Styling** — Tailwind CSS, precompiled by \`npm run build\` during
  image creation with either Kubernetes/Paketo or standalone Docker.`,
};
