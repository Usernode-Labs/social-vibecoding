// Forwarder snippet injected into every scaffolded app's public/index.html.
// Captures console.log/info/warn/error/debug + uncaught errors +
// unhandled promise rejections and posts them to `window.parent` via
// postMessage. The Usernode platform shell listens for these to power
// the in-app developer console (header icon + log panel).
//
// Existing apps (created before this feature) won't have this block. The
// easiest fix is to paste this `<script>` near the top of `<body>` in
// public/index.html — or ask the coding agent in dev chat.
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

// Resolved at module-load: which Usernode platform domain do we
// inject into scaffolded apps? Apps need to point users back to the
// platform that hosts them (the "Open in Usernode" landing page) and
// reference its `/claude.md` URL. Driven by USERNODE_DOMAIN env so a
// fork running at e.g. social-vibecoding.usernodelabs.org templates
// the right URL into its child apps. Fallback covers the historical
// monorepo deploy.
const PLATFORM_DOMAIN = process.env.USERNODE_DOMAIN || 'usernode.evanshapiro.dev';
const PLATFORM_BASE_URL = `https://${PLATFORM_DOMAIN}`;

function getTemplateFiles(appName, slug, dbUrl, jwtSecret) {
  return [
    {
      path: 'CLAUDE.md',
      content: `# ${appName} — notes for Claude Code

This app runs on **Usernode Social Vibecoding**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
${PLATFORM_BASE_URL}/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, \`USERNODE_ENV\`,
public/private tables, "don't \`git push\`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Usernode's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About ${appName}

_(add a sentence or two of product context here so Claude Code has a
shared understanding of what this app is for)_

## App-specific conventions

_(optional — e.g. "all currency values stored as integer cents, not
floats"; "the \`posts\` table is append-only"; "avoid adding new
dependencies"; etc.)_
`,
    },
    {
      path: 'package.json',
      content: JSON.stringify({
        name: slug,
        version: '1.0.0',
        private: true,
        description: appName,
        main: 'server.js',
        scripts: { start: 'node server.js' },
        dependencies: {
          express: '^4.21.0',
          pg: '^8.13.0',
          jsonwebtoken: '^9.0.2',
        },
      }, null, 2),
    },
    {
      path: 'Dockerfile',
      content: `FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \\
  CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "server.js"]
`,
    },
    {
      path: '.dockerignore',
      content: `.env
.env.*
.git
node_modules
`,
    },
    {
      // Per-app secrets manifest. Empty by default — apps that need
      // env vars beyond the platform-injected DATABASE_URL/JWT_SECRET/
      // PORT/USERNODE_ENV add entries here. The Usernode platform
      // reads this on every deploy and refuses to start the container
      // if a required key has no stored value (see
      // src/services/app-secrets.js + app-manifest.js in the platform).
      //
      // Schema:
      //   {
      //     "secrets": [
      //       {
      //         "key": "MY_API_KEY",
      //         "description": "Human help text shown in the Secrets UI",
      //         "required": true,
      //         "private": true,   // encrypted at rest, redacted from
      //                            // API, and not propagated into
      //                            // staging (`sensitive: true` is
      //                            // accepted as a BC alias)
      //         "default": "..."   // applied if no stored value
      //       }
      //     ]
      //   }
      // Reserved keys (DATABASE_URL, JWT_SECRET, PORT, USERNODE_ENV,
      // USERNODE_MISSING_SECRETS) are managed by the platform and
      // can't appear in this list.
      path: 'dapp.json',
      content: JSON.stringify({ secrets: [] }, null, 2),
    },
    {
      path: 'server.js',
      content: `const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;

// Paths that stay open without authentication. Add a path here (and add it
// with \`app.get\`/\`app.post\` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds \`?token=…\`
// on load; the frontend script forwards the token via \`x-usernode-token\`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
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

// HTML shell: serve the app if authenticated, otherwise an "open in Usernode"
// landing page so stray visits to the staging URL don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user) {
    return res.status(401).send(\`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_BASE_URL}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Go to Usernode</a>
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
  app.listen(port, () => console.log(\`Listening on :\${port}\`));
}

start().catch(err => { console.error(err); process.exit(1); });
`,
    },
    {
      path: 'public/index.html',
      content: `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${DEV_CONSOLE_FORWARDER}
  <title>${escapeHtml(appName)}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>tailwind.config = { darkMode: 'class' }</script>
</head>
<body class="bg-zinc-950 text-zinc-100 min-h-screen flex flex-col items-center justify-center gap-8 p-4">
  <h1 class="text-2xl font-bold">${escapeHtml(appName)}</h1>

  <button id="press-btn" class="w-32 h-32 rounded-full bg-violet-600 hover:bg-violet-500 active:scale-95 transition-all text-white text-xl font-bold shadow-lg shadow-violet-600/30">
    Press!
  </button>

  <div id="count" class="text-lg text-zinc-400">0 total presses</div>

  <div class="w-full max-w-sm">
    <h2 class="text-sm font-medium text-zinc-500 mb-2 text-center">Leaderboard</h2>
    <div id="leaderboard" class="space-y-1"></div>
  </div>

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
`,
    },
  ];
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { getTemplateFiles };
