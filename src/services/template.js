const fs = require('fs');
const path = require('path');
const nodeAppPackage = require('../templates/node-app/package.json');
const nodeAppLock = require('../templates/node-app/package-lock.json');

// Forwarder snippet injected into every scaffolded app's public/index.html.
// Captures console.log/info/warn/error/debug + uncaught errors +
// unhandled promise rejections and posts them to `window.parent` via
// postMessage. The Homeroom platform shell listens for these to power
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

// Resolved at module-load: which Homeroom platform domain do we
// inject into scaffolded apps? Apps need to point users back to the
// platform that hosts them (the "Open in Homeroom" landing page) and
// reference its `/claude.md` URL. Driven by USERNODE_DOMAIN env so a
// fork running at a different domain templates the right URL into its
// child apps. The fallback is deliberately not a real host (the same
// placeholder src/config.js uses): falling back to the canonical deploy's
// domain is how scaffolds kept naming the platform's retired domain after
// the platform had left it (#2322). Only the CLAUDE.md documentation
// link uses this now — generated code reads the injected origin.
const PLATFORM_DOMAIN = process.env.USERNODE_DOMAIN || 'apps.example.invalid';
const PLATFORM_BASE_URL = `https://${PLATFORM_DOMAIN}`;

// The hosted connector's canonical name and the read-only allow rules built
// from it, taken from the one place that defines them so a scaffolded repo
// can never drift from the server that answers those calls. See #1218 and
// the long note in services/mcp-connect-constants.js.
const {
  SERVER_NAME: CONNECTOR_SERVER_NAME,
  READ_ONLY_ALLOW_RULES: CONNECTOR_ALLOW_RULES,
  ALLOW_RULE_SERVER_NAMES: CONNECTOR_NAME_SPELLINGS,
} = require('./mcp-connect-constants');

// The spellings the shipped rules cover, rendered from the constant so a
// name added or retired there cannot leave the scaffolded README naming a
// different set than the settings file beside it.
const CONNECTOR_SPELLING_LIST = CONNECTOR_NAME_SPELLINGS
  .map((name) => `\`${name}\``)
  .join(', ');

// The checkout freshness check every scaffolded repo runs at Claude Code
// session start: the app-side counterpart of the platform repository's
// .agents/hooks/upstream-drift.js (#3102). POSIX sh rather than Node, because
// an imported app need not be a Node app; it lives as a real file so it can be
// run and tested as itself rather than as a string with its `$`s escaped.
const FRESHNESS_HOOK_PATH = '.claude/hooks/homeroom-freshness.sh';
const FRESHNESS_HOOK_SCRIPT = fs.readFileSync(
  path.join(__dirname, '..', 'templates', 'app-scaffold', 'homeroom-freshness.sh'),
  'utf8'
);

// The one-line file naming the app's canonical repository, which the hook
// above compares HEAD against. Platform-written rather than part of the
// shared scaffold: a create and an import write the app's own URL, and a fork
// ALWAYS rewrites it, since the copy it inherits names the parent.
const CANONICAL_REPO_PATH = '.claude/homeroom-canonical-repo';

// https://github.com/<owner>/<repo>, or null for anything else (no GitHub,
// a local build). The hook reads this file as data, so only this one shape
// is ever written.
function canonicalRepoUrl(repoUrl) {
  const match = String(repoUrl || '').trim()
    .match(/^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/);
  return match ? `https://github.com/${match[1]}/${match[2]}` : null;
}

function getCanonicalRepoFile(repoUrl) {
  const url = canonicalRepoUrl(repoUrl);
  return url ? { path: CANONICAL_REPO_PATH, content: `${url}\n` } : null;
}

// Project settings the scaffold commits. Read-only connector grants, plus the
// one advisory hook above; nothing that acts. JSON has no comments, so the
// reasoning for both lives in .claude/README.md.
const SCAFFOLD_SETTINGS = {
  permissions: { allow: CONNECTOR_ALLOW_RULES },
  hooks: {
    SessionStart: [{
      hooks: [{
        type: 'command',
        command: `sh "$CLAUDE_PROJECT_DIR/${FRESHNESS_HOOK_PATH}"`,
        timeout: 10,
      }],
    }],
  },
};

// The `.claude/` scaffold, on its own so every path that creates a repo can
// place it — not just the one that writes the whole template.
//
// A fresh create gets these through getTemplateFiles() below. An IMPORT of an
// existing repo and a FORK of another app never called getTemplateFiles() at
// all, so before #1218's follow-up neither ended up with the allow rules, and
// their users kept getting a prompt per read forever. Both now call this.
//
// It is the single source of the two entries: getTemplateFiles() spreads the
// result rather than repeating it, so a create, an import and a fork cannot
// scaffold three different `.claude/` directories.
function getConnectorScaffoldFiles() {
  return [
    {
      // Project-level Claude Code settings. #1218: every hosted-connector
      // call used to raise its own permission prompt, read-only ones
      // included, and in a Claude Code WEB session the grant does not
      // survive the container — so the same prompts came back next
      // session, for every user, and the calls that genuinely deserve a
      // confirmation drowned in the noise.
      //
      // An MCP server cannot reduce its own prompting, and should not be
      // able to. Prompt reduction is client-side, via `permissions.allow`
      // rules — so the platform ships them where every user of every app
      // picks them up with no setup: the repo it scaffolds.
      //
      // Narrow entries, NOT `mcp__${CONNECTOR_SERVER_NAME}__*`, and the
      // reason is the scaffold rather than the tools: this file is committed
      // into every app repo, and "every call this connector can make" is not
      // something a repo should grant on a stranger's machine on their
      // behalf. Reads are reviewable in the trust dialog; the rest is the
      // user's own call, on their own account.
      //
      // JSON has no comments, so the reasoning lives in .claude/README.md
      // next to it.
      //
      // The one hook it carries is the freshness check (SCAFFOLD_SETTINGS).
      // That was a deliberate exception to "grants capability and nothing
      // more": the script only reads git state and prints, and the trust
      // dialog lists it for review like the rules above.
      path: '.claude/settings.json',
      content: `${JSON.stringify(SCAFFOLD_SETTINGS, null, 2)}\n`,
    },
    {
      path: FRESHNESS_HOOK_PATH,
      content: FRESHNESS_HOOK_SCRIPT,
    },
    {
      path: '.claude/README.md',
      content: `# \`.claude/\` — Claude Code settings for this repo

## Why \`settings.json\` is here

This app is built on **Homeroom**, and Homeroom has a hosted MCP connector
that Claude and ChatGPT can talk to. Without an allow rule, Claude Code asks
permission on **every** connector call — including read-only ones like
\`whoami\`, \`get_proposal\` and \`list_requests\`. In a Claude Code web session
that grant does not persist, so the prompts come back next session. The
calls that genuinely deserve a confirmation — \`submit_work\` puts a change to
a group vote — end up buried in that noise and approved by reflex.

\`settings.json\` allows the read-only connector calls and **nothing else**:

\`\`\`json
${JSON.stringify({ permissions: { allow: CONNECTOR_ALLOW_RULES } }, null, 2)}
\`\`\`

Deliberately not \`mcp__${CONNECTOR_SERVER_NAME}__*\`. This file is committed
into the repo, so it grants on behalf of everyone who opens it — and "every
call this connector can make" is not something one repo should decide for a
stranger's machine. These entries can only ever match reads, and they repeat
because a permission rule names its server literally: the same short list,
once per spelling the connector may be registered under.

If you want the acting calls (\`submit_work\`, \`create_request\`,
\`prepare_work\`, \`start_platform_build\`, \`submit_platform_build\`) allowed
too, grant that on your own account rather than here — set the connector to
allow-always in Claude's connector settings, or add the rules to your own
\`~/.claude/settings.json\`, where the decision covers your machine only.

## You will still see one trust dialog

\`permissions.allow\` rules in a project's \`.claude/settings.json\` grant
capability, so Claude Code applies them only after you accept the
**workspace trust dialog** for this workspace. Until then it reads the rules
but does not apply them. The dialog lists the rules, so you can review them
before accepting. One reviewable consent instead of dozens of per-call
prompts is the whole trade — and a repo silently granting a connector
permission on your behalf is exactly what that check exists to prevent.

## If you are still being prompted

The server segment of a permission rule is a **literal** — \`mcp__*__get_*\`
is not a thing — so these rules only match a connector named exactly one of
the spellings the shipped list covers:

${CONNECTOR_SPELLING_LIST}

The last two are what this connector was called before it was renamed, kept
so a connector added earlier keeps working. Claude.ai's "Add custom
connector" dialog takes whatever **name you type**, and a rule aimed at a
different one fails silently: no error, you just keep getting prompted.

**Read the name off your own tool list rather than trusting this file.** The
tool names you actually see are either \`mcp__<server>__whoami\` or
\`mcp__claude_ai_<server>__whoami\` — the prefix differs by surface. Copy the
\`<server>\` segment you see and edit the rules to match, or reconnect
the connector naming it \`${CONNECTOR_SERVER_NAME}\` exactly.

## The session-start freshness check

\`settings.json\` also runs one hook when a Claude Code session starts:
\`${FRESHNESS_HOOK_PATH}\`. Coding agents are often opened on a fork of this
app whose \`main\` is behind the app's canonical repository, and nothing in
the checkout says so, so an agent can answer questions or build changes from
old code. The script asks the canonical repository, which Homeroom names in
\`${CANONICAL_REPO_PATH}\`, where \`main\` is. When \`HEAD\` does not contain
that commit, it prints a short notice for the agent; otherwise it prints
nothing.

It only reads: \`git rev-parse\`, \`git ls-remote\` and \`git merge-base\`. It is
silent offline, always exits 0, and never blocks a session. The workspace
trust dialog lists it alongside the rules above. To turn it off on your
machine, set \`SOCIAL_VIBECODING_DRIFT_CHECK=off\` in your environment
(Homeroom's hosted workers do, because the platform fixes their base commit),
or delete the \`hooks\` entry from \`settings.json\`.

Homeroom writes \`${CANONICAL_REPO_PATH}\` when it creates or imports the app,
and rewrites it when the app is forked, so a fork points at itself rather
than at its parent. Leave it as Homeroom wrote it.

## Adding your own rules

This file is yours — add project rules alongside the connector ones. Just
keep the connector entries narrow: never widen them to a whole-server
wildcard, for the version reason above.

To stop the prompts in **every** repo at once rather than one at a time, put
the same rules under \`permissions.allow\` in your personal
\`~/.claude/settings.json\`. Homeroom's Settings → Connectors page has the
exact block, a copy button, and a field that rewrites the rules for a
connector registered under some other name.
`,
    },
  ];
}

// ── The starting templates (#3521) ─────────────────────────────────────
//
// The create dialog's last question now offers a template. Every template
// shares one scaffold — CLAUDE.md, the .claude/ connector scaffold, the
// Dockerfile, the Tailwind config, dapp.json, the server's auth core —
// produced once below, and differs only in the example the new app opens
// on: the "Try the example" section of public/index.html and its inline
// script, the demo route handlers registered after the same auth
// middleware, and the demo table's CREATE TABLE IF NOT EXISTS bootstrap in
// start(). The registry keys are services/create-options.js's TEMPLATES,
// which POST /api/apps validates; anything else still resolves to `empty`,
// the starter demo every new project has always had, byte for byte.
//
// The games are catch-and-collect demos with a high-score table (a
// ranking); nothing fights and nothing is wagered. The multimedia demo's
// pictures are six gradient tiles the template draws itself, so nothing is
// uploaded and nothing is loaded from another site. All demo copy is
// original placeholder text.
const DEMOS = {
  empty: {
    routes: `// Button press
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
});`,
    table: `  await pool.query(\`
    CREATE TABLE IF NOT EXISTS presses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  \`);`,
    section: `    <section class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 flex flex-col items-center gap-5">
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
    </section>`,
    script: `  <script>
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
  </script>`,
    claudeExample: `the Press! example (the demo markup in
\`public/index.html\`, the \`/api/press\` and \`/api/leaderboard\` routes, and
the \`presses\` table bootstrap in \`server.js\`)`,
    claudeTable: '`presses`',
    readme: `- **Database** — the app has its own private Postgres database; the
  demo stores button presses in a \`presses\` table.
- **Live API** — two example routes (\`/api/press\`,
  \`/api/leaderboard\`) read and write through a real Express server.`,
  },

  social: {
    routes: `// Shared task list (the starter example)
app.get('/api/tasks', async (_req, res) => {
  try {
    const { rows } = await pool.query(\`
      SELECT id, username, text, done
      FROM tasks
      ORDER BY id DESC
      LIMIT 100
    \`);
    res.json({ tasks: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks', async (req, res) => {
  const text = (req.body && typeof req.body.text === 'string' ? req.body.text : '').trim();
  if (!text || text.length > 200) {
    return res.status(400).json({ error: 'A task needs a line of text, 200 characters or fewer.' });
  }
  try {
    const { rows } = await pool.query(\`
      INSERT INTO tasks (user_id, username, text) VALUES ($1, $2, $3)
      RETURNING id, username, text, done
    \`, [req.user.id, req.user.username, text]);
    res.status(201).json({ task: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks/:id/toggle', async (req, res) => {
  try {
    const { rows } = await pool.query(\`
      UPDATE tasks SET done = NOT done WHERE id = $1
      RETURNING id, username, text, done
    \`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'No such task' });
    res.json({ task: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});`,
    table: `  await pool.query(\`
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      text VARCHAR(200) NOT NULL,
      done BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  \`);`,
    section: `    <section class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 flex flex-col gap-4">
      <div class="w-full flex items-baseline justify-between gap-2">
        <h2 class="text-sm font-medium text-zinc-500">Try the example</h2>
        <span class="text-xs text-zinc-600">This example will be replaced</span>
      </div>

      <form id="task-form" class="flex gap-2">
        <input id="task-input" type="text" maxlength="200" placeholder="Add a task, like Water the plants"
               class="flex-1 min-w-0 rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-violet-500" />
        <button type="submit" class="rounded-lg bg-violet-600 hover:bg-violet-500 transition-colors text-white text-sm font-semibold px-4">Add</button>
      </form>

      <div id="tasks" class="space-y-1"></div>
    </section>`,
    script: `  <script>
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const headers = token ? { 'x-usernode-token': token } : {};

    function esc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    async function loadTasks() {
      const res = await fetch('/api/tasks', { headers });
      if (!res.ok) return;
      const { tasks } = await res.json();
      const el = document.getElementById('tasks');
      if (!tasks.length) {
        el.innerHTML = '<p class="text-center text-zinc-600 text-sm">No tasks yet. Add the first one above.</p>';
        return;
      }
      el.innerHTML = tasks.map((t) =>
        '<div class="flex items-center gap-3 px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800">' +
        '<button type="button" data-toggle="' + t.id + '" aria-pressed="' + t.done + '" aria-label="' + (t.done ? 'Mark not done' : 'Mark done') + '" class="w-6 h-6 shrink-0 rounded-full border text-xs leading-none ' + (t.done ? 'bg-violet-600 border-violet-600 text-white' : 'border-zinc-600 text-transparent') + '">✓</button>' +
        '<span class="flex-1 min-w-0 break-words text-sm ' + (t.done ? 'text-zinc-600 line-through' : 'text-zinc-200') + '">' + esc(t.text) + '</span>' +
        '<span class="shrink-0 text-xs text-zinc-500">' + esc(t.username) + '</span>' +
        '</div>'
      ).join('');
      el.querySelectorAll('[data-toggle]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            const res = await fetch('/api/tasks/' + btn.getAttribute('data-toggle') + '/toggle', { method: 'POST', headers });
            if (res.ok) loadTasks();
            else if (res.status === 401) el.innerHTML = '<p class="text-center text-zinc-600 text-sm">Sign in to tick tasks off.</p>';
          } catch {}
        });
      });
    }

    document.getElementById('task-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('task-input');
      const text = input.value.trim();
      if (!text) return;
      try {
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ text: text }),
        });
        if (res.ok) { input.value = ''; loadTasks(); }
        else if (res.status === 401) document.getElementById('tasks').innerHTML =
          '<p class="text-center text-zinc-600 text-sm">Sign in to add tasks.</p>';
      } catch {}
    });

    loadTasks();
  </script>`,
    claudeExample: `the shared task-board example (the demo markup in
\`public/index.html\`, the \`/api/tasks\` routes, and the \`tasks\` table
bootstrap in \`server.js\`)`,
    claudeTable: '`tasks`',
    readme: `- **Database** — the app has its own private Postgres database; the
  demo stores tasks in a \`tasks\` table.
- **Live API** — three example routes (\`/api/tasks\` and
  \`/api/tasks/:id/toggle\`) read and write through a real Express server.`,
  },

  media: {
    routes: `// Picture posts (the starter example)
const POST_ART = new Set(['sunset', 'ocean', 'meadow', 'orchid', 'ember', 'slate']);

app.get('/api/posts', async (_req, res) => {
  try {
    const { rows } = await pool.query(\`
      SELECT id, username, caption, art, hearts
      FROM posts
      ORDER BY id DESC
      LIMIT 50
    \`);
    res.json({ posts: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/posts', async (req, res) => {
  const caption = (req.body && typeof req.body.caption === 'string' ? req.body.caption : '').trim();
  const art = req.body ? req.body.art : null;
  if (!caption || caption.length > 140) {
    return res.status(400).json({ error: 'A post needs a caption of 140 characters or fewer.' });
  }
  if (!POST_ART.has(art)) {
    return res.status(400).json({ error: 'Pick one of the six picture tiles.' });
  }
  try {
    const { rows } = await pool.query(\`
      INSERT INTO posts (user_id, username, caption, art) VALUES ($1, $2, $3, $4)
      RETURNING id, username, caption, art, hearts
    \`, [req.user.id, req.user.username, caption, art]);
    res.status(201).json({ post: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/posts/:id/heart', async (req, res) => {
  try {
    const { rows } = await pool.query(\`
      UPDATE posts SET hearts = hearts + 1 WHERE id = $1
      RETURNING id, username, caption, art, hearts
    \`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'No such post' });
    res.json({ post: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});`,
    table: `  await pool.query(\`
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      caption VARCHAR(140) NOT NULL,
      art VARCHAR(16) NOT NULL,
      hearts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  \`);`,
    section: `    <section class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 flex flex-col gap-4">
      <div class="w-full flex items-baseline justify-between gap-2">
        <h2 class="text-sm font-medium text-zinc-500">Try the example</h2>
        <span class="text-xs text-zinc-600">This example will be replaced</span>
      </div>

      <form id="post-form" class="flex flex-col gap-2">
        <div id="art-picker" class="grid grid-cols-6 gap-2" role="radiogroup" aria-label="Pick a picture tile"></div>
        <input id="post-caption" type="text" maxlength="140" placeholder="Write a caption"
               class="rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-violet-500" />
        <button type="submit" class="rounded-lg bg-violet-600 hover:bg-violet-500 transition-colors text-white text-sm font-semibold px-4 py-2">Post</button>
      </form>

      <div id="posts" class="flex flex-col gap-3"></div>
    </section>`,
    script: `  <script>
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const headers = token ? { 'x-usernode-token': token } : {};

    function esc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Six gradient tiles the template draws itself: nothing to upload and
    // nothing loaded from another site. The class names are whole literals
    // so the Tailwind compile keeps them.
    const TILES = {
      sunset: 'Sunset|bg-gradient-to-br from-rose-500 via-orange-400 to-amber-300',
      ocean: 'Ocean|bg-gradient-to-br from-sky-500 via-cyan-400 to-teal-300',
      meadow: 'Meadow|bg-gradient-to-br from-emerald-500 via-green-400 to-lime-300',
      orchid: 'Orchid|bg-gradient-to-br from-fuchsia-500 via-purple-400 to-violet-300',
      ember: 'Ember|bg-gradient-to-br from-orange-600 via-red-400 to-rose-300',
      slate: 'Slate|bg-gradient-to-br from-slate-400 via-zinc-400 to-zinc-300',
    };
    let pickedArt = null;

    function tileClass(art) {
      const tile = TILES[art] || '';
      return tile.slice(tile.indexOf('|') + 1);
    }

    const picker = document.getElementById('art-picker');
    Object.keys(TILES).forEach((art) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-art', art);
      btn.setAttribute('aria-pressed', 'false');
      btn.setAttribute('aria-label', TILES[art].slice(0, TILES[art].indexOf('|')) + ' tile');
      btn.className = 'h-10 rounded-lg ring-offset-2 ring-offset-zinc-900 ' + tileClass(art);
      btn.addEventListener('click', () => {
        pickedArt = art;
        picker.querySelectorAll('[data-art]').forEach((b) =>
          b.setAttribute('aria-pressed', String(b.getAttribute('data-art') === art)));
      });
      picker.appendChild(btn);
    });

    function renderPosts(posts) {
      const el = document.getElementById('posts');
      if (!posts.length) {
        el.innerHTML = '<p class="text-center text-zinc-600 text-sm">No posts yet. Pick a tile and write the first caption.</p>';
        return;
      }
      el.innerHTML = posts.map((p) =>
        '<div class="rounded-lg bg-zinc-950 border border-zinc-800 overflow-hidden">' +
        '<div class="h-28 ' + tileClass(p.art) + '"></div>' +
        '<div class="flex items-center gap-3 px-3 py-2">' +
        '<span class="flex-1 min-w-0 break-words text-sm text-zinc-200">' + esc(p.caption) + '</span>' +
        '<button type="button" data-heart="' + p.id + '" aria-label="Heart this post" class="shrink-0 text-sm text-violet-300">♥ ' + p.hearts + '</button>' +
        '</div>' +
        '<p class="px-3 pb-2 text-xs text-zinc-500">' + esc(p.username) + '</p>' +
        '</div>'
      ).join('');
      el.querySelectorAll('[data-heart]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            const res = await fetch('/api/posts/' + btn.getAttribute('data-heart') + '/heart', { method: 'POST', headers });
            if (res.ok) loadPosts();
          } catch {}
        });
      });
    }

    async function loadPosts() {
      const res = await fetch('/api/posts', { headers });
      if (!res.ok) return;
      const { posts } = await res.json();
      renderPosts(posts);
    }

    document.getElementById('post-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('post-caption');
      const caption = input.value.trim();
      if (!pickedArt || !caption) { input.focus(); return; }
      try {
        const res = await fetch('/api/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ caption: caption, art: pickedArt }),
        });
        if (res.ok) { input.value = ''; loadPosts(); }
        else if (res.status === 401) document.getElementById('posts').innerHTML =
          '<p class="text-center text-zinc-600 text-sm">Sign in to post.</p>';
      } catch {}
    });

    loadPosts();
  </script>`,
    claudeExample: `the picture-post feed (the demo markup in
\`public/index.html\`, the \`/api/posts\` routes, and the \`posts\` table
bootstrap in \`server.js\`)`,
    claudeTable: '`posts`',
    readme: `- **Database** — the app has its own private Postgres database; the
  demo stores picture posts in a \`posts\` table.
- **Live API** — three example routes (\`/api/posts\` and
  \`/api/posts/:id/heart\`) read and write through a real Express server.`,
  },

  game2d: {
    routes: `// High scores (the starter example)
app.get('/api/scores', async (_req, res) => {
  try {
    const { rows } = await pool.query(\`
      SELECT username, score
      FROM scores
      ORDER BY score DESC, created_at ASC
      LIMIT 10
    \`);
    res.json({ scores: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scores', async (req, res) => {
  const score = Math.round(Number(req.body && req.body.score));
  if (!Number.isInteger(score) || score < 0 || score > 100000) {
    return res.status(400).json({ error: 'A score is a whole number between 0 and 100000.' });
  }
  try {
    await pool.query(\`
      INSERT INTO scores (user_id, username, score) VALUES ($1, $2, $3)
    \`, [req.user.id, req.user.username, score]);
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});`,
    table: `  await pool.query(\`
    CREATE TABLE IF NOT EXISTS scores (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      score INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  \`);`,
    section: `    <section class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 flex flex-col items-center gap-4">
      <div class="w-full flex items-baseline justify-between gap-2">
        <h2 class="text-sm font-medium text-zinc-500">Try the example</h2>
        <span class="text-xs text-zinc-600">This example will be replaced</span>
      </div>

      <canvas id="game-canvas" width="320" height="240" class="w-full rounded-lg bg-zinc-950 border border-zinc-800" aria-label="Catch the falling stars with the basket. Move with the arrow keys or by dragging on the canvas."></canvas>
      <p class="text-sm text-zinc-500">Move the basket with the arrow keys, or drag on the canvas. Catch the falling stars.</p>
      <p id="score" class="text-lg text-zinc-400">Score 0</p>

      <div class="w-full max-w-sm">
        <h3 class="text-sm font-medium text-zinc-500 mb-2 text-center">High scores</h3>
        <div id="scores" class="space-y-1"></div>
      </div>
    </section>`,
    script: `  <script>
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const headers = token ? { 'x-usernode-token': token } : {};

    function esc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    const canvas = document.getElementById('game-canvas');
    const ctx = canvas.getContext('2d');
    const scoreEl = document.getElementById('score');
    const ROUND_SECONDS = 30;

    const basket = { x: canvas.width / 2 - 30, y: canvas.height - 18, w: 60, h: 12 };
    const stars = [];
    const keys = {};
    let score = 0;
    let over = false;
    let scoreSent = false;
    let secondsLeft = ROUND_SECONDS;
    let last = null;

    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.preventDefault();
      keys[e.key] = true;
    });
    document.addEventListener('keyup', (e) => { keys[e.key] = false; });
    // A drag on the canvas moves the basket, so touch screens do not scroll
    // the page instead.
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointermove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) * canvas.width / rect.width;
      basket.x = Math.max(0, Math.min(canvas.width - basket.w, x - basket.w / 2));
    });

    async function loadScores() {
      const res = await fetch('/api/scores', { headers });
      if (!res.ok) return;
      const { scores } = await res.json();
      const el = document.getElementById('scores');
      el.innerHTML = scores.length
        ? scores.map((s, i) =>
            '<div class="flex justify-between px-3 py-1 rounded ' + (i === 0 ? 'bg-violet-600/20 text-violet-300' : 'text-zinc-400') + '">' +
            '<span>' + (i + 1) + '. ' + esc(s.username) + '</span>' +
            '<span class="font-mono">' + s.score + '</span></div>'
          ).join('')
        : '<p class="text-center text-zinc-600 text-sm">No scores yet</p>';
    }

    async function submitScore() {
      if (scoreSent) return;
      scoreSent = true;
      try {
        const res = await fetch('/api/scores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ score: score }),
        });
        if (res.ok) loadScores();
        else if (res.status === 401) scoreEl.textContent = 'Sign in to record your score';
      } catch {}
    }

    function tick(ts) {
      if (last == null) last = ts;
      const dt = Math.min((ts - last) / 1000, 0.1);
      last = ts;

      if (!over) {
        secondsLeft -= dt;
        if (secondsLeft <= 0) { secondsLeft = 0; over = true; submitScore(); }
        if (keys.ArrowLeft) basket.x = Math.max(0, basket.x - 180 * dt);
        if (keys.ArrowRight) basket.x = Math.min(canvas.width - basket.w, basket.x + 180 * dt);
        if (Math.random() < dt * 2.5) {
          stars.push({ x: 6 + Math.random() * (canvas.width - 12), y: -8, v: 60 + Math.random() * 60 });
        }
        for (const s of stars) {
          s.y += s.v * dt;
          if (!s.caught && s.y > basket.y - 6 && s.y < basket.y + basket.h && s.x > basket.x - 4 && s.x < basket.x + basket.w + 4) {
            s.caught = true;
            score += 1;
          }
        }
        for (let i = stars.length - 1; i >= 0; i--) {
          if (stars[i].caught || stars[i].y > canvas.height + 8) stars.splice(i, 1);
        }
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fbbf24';
      for (const s of stars) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#8b5cf6';
      ctx.fillRect(basket.x, basket.y, basket.w, basket.h);

      scoreEl.textContent = over
        ? 'Game over — score ' + score
        : 'Score ' + score + ' · ' + Math.ceil(secondsLeft) + 's left';
      requestAnimationFrame(tick);
    }

    loadScores();
    requestAnimationFrame(tick);
  </script>`,
    claudeExample: `the star-catching game (the demo markup in
\`public/index.html\`, the \`/api/scores\` routes, and the \`scores\` table
bootstrap in \`server.js\`)`,
    claudeTable: '`scores`',
    readme: `- **Database** — the app has its own private Postgres database; the
  demo stores game scores in a \`scores\` table.
- **Live API** — two example routes (the \`/api/scores\` GET and POST)
  read and write through a real Express server.`,
  },

  game3d: {
    routes: `// High scores (the starter example)
app.get('/api/scores', async (_req, res) => {
  try {
    const { rows } = await pool.query(\`
      SELECT username, score
      FROM scores
      ORDER BY score DESC, created_at ASC
      LIMIT 10
    \`);
    res.json({ scores: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scores', async (req, res) => {
  const score = Math.round(Number(req.body && req.body.score));
  if (!Number.isInteger(score) || score < 0 || score > 100000) {
    return res.status(400).json({ error: 'A score is a whole number between 0 and 100000.' });
  }
  try {
    await pool.query(\`
      INSERT INTO scores (user_id, username, score) VALUES ($1, $2, $3)
    \`, [req.user.id, req.user.username, score]);
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The 3D example's library, served out of this app's own node_modules so
// nothing loads from another site. The file carries no data, so it is
// served the way the static assets below are: always, with no token. Only
// the two file names the library ships are ever sent — the fixed set is
// what keeps this from becoming a path into the dependency tree. (The
// module build imports ./three.core.js internally, hence the second name.)
app.get(/^\\/vendor\\/three(\\.core)?(\\.module)?\\.js$/, (req, res) => {
  const name = req.path.includes('.core') ? 'three.core.js' : 'three.module.js';
  res.type('application/javascript');
  res.sendFile(path.join(path.dirname(require.resolve('three')), name));
});`,
    table: `  await pool.query(\`
    CREATE TABLE IF NOT EXISTS scores (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      score INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  \`);`,
    section: `    <section class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 flex flex-col items-center gap-4">
      <div class="w-full flex items-baseline justify-between gap-2">
        <h2 class="text-sm font-medium text-zinc-500">Try the example</h2>
        <span class="text-xs text-zinc-600">This example will be replaced</span>
      </div>

      <canvas id="game-canvas" width="480" height="320" class="w-full rounded-lg bg-zinc-950 border border-zinc-800" aria-label="Roll the ball with the arrow keys or W A S D and collect the gems."></canvas>
      <p class="text-sm text-zinc-500">Roll the ball with the arrow keys or W A S D. Collect the gems.</p>
      <p id="score" class="text-lg text-zinc-400">Score 0</p>

      <div class="w-full max-w-sm">
        <h3 class="text-sm font-medium text-zinc-500 mb-2 text-center">High scores</h3>
        <div id="scores" class="space-y-1"></div>
      </div>
    </section>`,
    script: `  <script type="module">
    import * as THREE from '/vendor/three.module.js';

    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const headers = token ? { 'x-usernode-token': token } : {};

    function esc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    const canvas = document.getElementById('game-canvas');
    const scoreEl = document.getElementById('score');
    const ROUND_SECONDS = 30;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x09090b);
    const camera = new THREE.PerspectiveCamera(60, canvas.width / canvas.height, 0.1, 100);
    const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    renderer.setSize(canvas.width, canvas.height, false);

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(4, 8, 2);
    scene.add(sun);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 20),
      new THREE.MeshLambertMaterial({ color: 0x27272a })
    );
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.4, 24, 16),
      new THREE.MeshLambertMaterial({ color: 0x8b5cf6 })
    );
    ball.position.set(0, 0.4, 0);
    scene.add(ball);

    // Eight gems, far enough apart that a round takes most of the timer.
    const SPOTS = [[-3, -3], [3, 3], [-3, 3], [3, -3], [0, -4], [4, 0], [-4, 0], [0, 4]];
    const gems = SPOTS.map(([x, z]) => {
      const gem = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.35),
        new THREE.MeshLambertMaterial({ color: 0xfbbf24 })
      );
      gem.position.set(x, 0.8, z);
      scene.add(gem);
      return gem;
    });

    const keys = {};
    document.addEventListener('keydown', (e) => {
      if (e.code.startsWith('Arrow')) e.preventDefault();
      keys[e.code] = true;
    });
    document.addEventListener('keyup', (e) => { keys[e.code] = false; });

    let score = 0;
    let over = false;
    let scoreSent = false;
    let secondsLeft = ROUND_SECONDS;

    async function loadScores() {
      const res = await fetch('/api/scores', { headers });
      if (!res.ok) return;
      const { scores } = await res.json();
      const el = document.getElementById('scores');
      el.innerHTML = scores.length
        ? scores.map((s, i) =>
            '<div class="flex justify-between px-3 py-1 rounded ' + (i === 0 ? 'bg-violet-600/20 text-violet-300' : 'text-zinc-400') + '">' +
            '<span>' + (i + 1) + '. ' + esc(s.username) + '</span>' +
            '<span class="font-mono">' + s.score + '</span></div>'
          ).join('')
        : '<p class="text-center text-zinc-600 text-sm">No scores yet</p>';
    }

    async function submitScore() {
      if (scoreSent) return;
      scoreSent = true;
      try {
        const res = await fetch('/api/scores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ score: score }),
        });
        if (res.ok) loadScores();
        else if (res.status === 401) scoreEl.textContent = 'Sign in to record your score';
      } catch {}
    }

    const clock = new THREE.Clock();

    function tick() {
      const dt = Math.min(clock.getDelta(), 0.1);
      if (!over) {
        secondsLeft -= dt;
        if (secondsLeft <= 0) { secondsLeft = 0; over = true; submitScore(); }
        const dir = new THREE.Vector3(
          (keys.ArrowRight || keys.KeyD ? 1 : 0) - (keys.ArrowLeft || keys.KeyA ? 1 : 0),
          0,
          (keys.ArrowDown || keys.KeyS ? 1 : 0) - (keys.ArrowUp || keys.KeyW ? 1 : 0)
        );
        if (dir.lengthSq() > 0) {
          dir.normalize();
          ball.position.addScaledVector(dir, 4 * dt);
          ball.position.x = Math.max(-9.5, Math.min(9.5, ball.position.x));
          ball.position.z = Math.max(-9.5, Math.min(9.5, ball.position.z));
        }
        gems.forEach((gem, i) => {
          if (!gem.visible) return;
          gem.rotation.y += dt * 2;
          gem.position.y = 0.8 + Math.sin(clock.elapsedTime * 2 + i) * 0.15;
          if (gem.position.distanceTo(ball.position) < 0.8) {
            gem.visible = false;
            score += 1;
          }
        });
      }
      camera.position.set(ball.position.x, 4.5, ball.position.z + 6);
      camera.lookAt(ball.position);
      renderer.render(scene, camera);
      scoreEl.textContent = over
        ? 'Game over — score ' + score
        : 'Score ' + score + ' · ' + Math.ceil(secondsLeft) + 's left';
      requestAnimationFrame(tick);
    }

    loadScores();
    requestAnimationFrame(tick);
  </script>`,
    claudeExample: `the gem-collecting 3D game (the demo markup in
\`public/index.html\`, the \`/api/scores\` routes, and the \`scores\` table
bootstrap in \`server.js\`)`,
    claudeTable: '`scores`',
    readme: `- **Database** — the app has its own private Postgres database; the
  demo stores game scores in a \`scores\` table.
- **Live API** — two example routes (the \`/api/scores\` GET and POST)
  read and write through a real Express server.`,
  },
};

// repoUrl is the app's canonical GitHub repository; with it the scaffold
// includes the pointer file the freshness check reads. A local build with no
// GitHub has none, and gets no pointer.
//
// `template` is the create dialog's "Start from a template" choice
// (services/create-options.js's TEMPLATES): which example the new app opens
// on. It only swaps the demo — the registry above — never the shared
// scaffold, so a create cannot drift between templates. Absent or unknown,
// it is `empty`, the starter demo every new project got before the choice
// existed.
//
// `governance` is the approval rule chosen on the create screen
// ({ approverPolicy, approvalsRequired }, the apps row's two columns). A
// non-default rule is written into dapp.json's `governance` block, the
// rule's source of truth, so the repository says what the row says from its
// first commit. The default rule writes nothing: dapp.json stays
// `{ "secrets": [] }`.
//
// `description` is the create screen's optional "What is it?" line. It
// becomes dapp.json's top-level `description` (what the join screen,
// Discover and the project's page show) and the first sentence of
// CLAUDE.md's About section, so the coding agent starts from the same
// intent. Absent, both stay as they were.
function getTemplateFiles(appName, slug, dbUrl, repoUrl = null, { template = 'empty', governance = null, description = null } = {}) {
  const demo = DEMOS[template] || DEMOS.empty;
  const canonicalRepoFile = getCanonicalRepoFile(repoUrl);
  const governanceBlock = require('./create-options').governanceBlock(governance);
  const about = typeof description === 'string' && description.trim() ? description.trim() : null;
  return [
    {
      path: 'CLAUDE.md',
      content: `# ${appName} — notes for Claude Code

This app runs on **Homeroom**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
${PLATFORM_BASE_URL}/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, \`USERNODE_ENV\`,
public/private tables, "don't \`git push\`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Homeroom's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

## Connector permission prompts

This repo ships \`.claude/settings.json\`, which allows the **read-only**
Homeroom connector calls (\`mcp__${CONNECTOR_SERVER_NAME}__get_*\`,
\`…__list_*\`, \`…__whoami\`) so they stop prompting one at a time. Everything
that acts — filing a request, opening or advancing a proposal — still asks.
Claude Code applies those rules only after you accept the
workspace trust dialog, which lists them for review. See \`.claude/README.md\`
for the whole story, including what to do if you are still being prompted
(usually: your connector is registered under a different name than the rules
assume).

## Check that this checkout is current

You may be working in a fork of this app whose \`main\` is behind the app's
canonical repository, and nothing in the checkout says so: \`git fetch origin\`
compares the fork with itself. This matters before you **read** code to answer
a question about how the app behaves now, not only before you edit it.

The canonical repository is named in \`${CANONICAL_REPO_PATH}\`. Check against
it, not against \`origin\`:

\`\`\`sh
git fetch "$(cat ${CANONICAL_REPO_PATH})" main
git merge-base --is-ancestor FETCH_HEAD HEAD && echo current || echo behind
\`\`\`

\`behind\` means this checkout does not contain the canonical \`main\`. To answer
a question, read the canonical code instead (\`git show FETCH_HEAD:<path>\`,
\`git grep <pattern> FETCH_HEAD\`). To change code, start from the exact base
commit your Homeroom work order gives, and never merge or rebase onto the
canonical \`main\` yourself: which commit a change is diffed against decides
what the group votes on. With the Homeroom connector, \`get_checkout_status\`
answers the same question.

A session-start hook (\`${FRESHNESS_HOOK_PATH}\`, see \`.claude/README.md\`) runs
this check for you and tells you when you are behind. It is silent offline, so
its silence is not proof the checkout is current. Inside Homeroom's dev-chat
the platform fixes the base commit, and none of this applies.

## Starter template

The screen this app currently ships — the hero, the "What's already
working" card, and ${demo.claudeExample} — is placeholder content
from the Homeroom starter template, not product intent.

When the user asks for their first real feature, REPLACE the template
screen rather than building alongside it:

- remove the \`usernode-starter-notice@1\` block in \`public/index.html\`
  (both sentinel comments and everything between them),
- remove or repurpose the "Try the example" card, its demo endpoints and
  the ${demo.claudeTable} table as appropriate,
- rewrite \`README.md\` to describe the actual app.

Keep the \`usernode-dev-console@1\` forwarder \`<script>\` when rewriting the
HTML — that block is platform infrastructure, not template content.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About ${appName}

${about ? `${about}\n\n_(add a sentence or two more of product context here so Claude Code has a\nshared understanding of what this app is for)_` : `_(add a sentence or two of product context here so Claude Code has a
shared understanding of what this app is for)_`}

## App-specific conventions

_(optional — e.g. "all currency values stored as integer cents, not
floats"; "the \`posts\` table is append-only"; "avoid adding new
dependencies"; etc.)_
`,
    },
    // "Replacing the template" and the starter page's hero (public/index.html
    // below) say the same thing: where a new app's creator starts building.
    // That was "tap Improve in the header" until #2718 retired the Improve
    // pill; since #3573 it names what is there now, the Homeroom mark's menu
    // and its "Start a new change" row (frontend/src/features/app-context/
    // app-context-sheet.tsx). "Homeroom icon" is what the mark looks like (the
    // platform's own copy calls its menu "the Homeroom menu", its
    // aria-label), and one starter serves every new app, so it says "your
    // app". Only new repositories get this: an existing app keeps the copy it
    // was scaffolded with until its own agent rewrites the screen.
    {
      path: 'README.md',
      content: `# ${appName}

> **Starter template** — this repo was scaffolded by Homeroom Social
> Vibecoding. Everything in it is placeholder example code until the
> app's first real feature is built.

The scaffold is a small working demo that proves the plumbing works:

- **Sign-in** — the server verifies the platform-issued user token
  (an RS256 JWT) on every request, so the app already knows who is
  using it. No accounts to build.
${demo.readme}
- **Styling** — Tailwind CSS, precompiled by \`npm run build\` during
  image creation with either Kubernetes/Paketo or standalone Docker.

## Replacing the template

Open the app on Homeroom, tap the Homeroom icon in the header, choose
**Start a new change**, and describe the app you want in plain English.
The template will be replaced with your real app. You can also run
Claude Code against this repo directly; start with \`CLAUDE.md\`, which
carries the app-specific notes and points at the platform rules.

Once the real app exists, rewrite this README to describe it.
`,
    },
    {
      path: 'package.json',
      content: JSON.stringify({
        ...nodeAppPackage,
        name: slug,
        description: appName,
      }, null, 2),
    },
    {
      path: 'package-lock.json',
      content: JSON.stringify({
        ...nodeAppLock,
        name: slug,
        packages: {
          ...nodeAppLock.packages,
          '': { ...nodeAppLock.packages[''], name: slug },
        },
      }, null, 2),
    },
    {
      path: 'Dockerfile',
      content: `# Stage 1 — compile this app's Tailwind stylesheet.
#
# Runs on every image build (production deploys AND staging previews), so
# public/tailwind.css is always generated from the markup in THIS commit.
# That is why there is no committed CSS artifact to keep in sync and no
# rebuild step for you to remember: add a class, push, it is in the next
# build. tailwindcss lives only in this stage, so the runtime image below
# stays exactly as small as it was.
FROM node:22-alpine AS css
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tailwind.config.js ./
COPY styles ./styles
COPY public ./public
RUN npm run build

# Stage 2 — the app itself (unchanged apart from the one COPY at the end).
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=1000:1000 . .
# After the source copy so the compiled stylesheet is not overwritten by the
# source tree (which deliberately does not contain one).
COPY --chown=1000:1000 --from=css /build/public/tailwind.css ./public/tailwind.css
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \\
  CMD wget -qO- http://localhost:3000/health || exit 1
# Kubernetes enforces runAsNonRoot without supplying a UID. Keep this numeric:
# unlike a symbolic USER, it lets the kubelet verify the image before startup.
USER 1000:1000
CMD ["node", "server.js"]
`,
    },
    {
      path: 'tailwind.config.js',
      content: `// Tailwind config for this app's precompiled stylesheet.
//
// npm run build (Docker or Paketo) runs the Tailwind CLI over the globs below
// and writes public/tailwind.css, which public/index.html links as
// /tailwind.css. Nothing is committed — every image build regenerates it.
//
// To build it locally (optional; the image build does this for you):
//   npm ci --include=dev
//   npm run build
module.exports = {
  // Every file that can contain a class name. Tailwind's extractor is a
  // regex over source text, so it finds class names written as whole
  // literals — including ones inside JS strings in these files.
  content: [
    './public/**/*.html',
    './public/**/*.js',
  ],

  // Classes this app builds dynamically (if it ever does) go here, since the
  // extractor cannot see them. Prefer whole literals in the markup instead.
  safelist: [],

  // Matches the <html class="dark"> in public/index.html: dark: variants key
  // off that class rather than the OS colour-scheme preference.
  darkMode: 'class',

  // Stops hover: styles sticking after a tap on touch screens. Required by
  // the usernode-native UI kit and harmless without it.
  future: { hoverOnlyWhenSupported: true },

  theme: { extend: {} },
  plugins: [],
};
`,
    },
    {
      path: 'styles/tailwind-input.css',
      content: `/* Input stylesheet for this app's Tailwind build.
 *
 * Deliberately OUTSIDE public/ so it is never served — the @tailwind lines
 * are build-time directives and mean nothing to a browser. npm run build
 * compiles this to public/tailwind.css with Docker or Paketo.
 *
 * "base" is the preflight layer (the cross-browser reset). Keep all three
 * layers, in this order; dropping base changes every heading, list and form
 * control.
 */
@tailwind base;
@tailwind components;
@tailwind utilities;
`,
    },
    {
      path: '.dockerignore',
      content: `.env
.env.*
.git
.claude
node_modules
public/tailwind.css
`,
    },
    {
      path: '.gitignore',
      content: `.env
.env.*
node_modules/
public/tailwind.css
.playwright-mcp/
test-results/
playwright-report/
`,
    },
    {
      path: 'project.toml',
      content: `[_]
schema-version = "0.2"

[io.buildpacks]
exclude = [
  "node_modules",
  "public/tailwind.css",
]

[[io.buildpacks.build.env]]
name = "BP_NODE_RUN_SCRIPTS"
value = "build"
`,
    },
    {
      // Per-app secrets manifest. Empty by default — apps that need
      // env vars beyond the platform-injected DATABASE_URL/
      // USERNODE_JWT_PUBLIC_KEY/USERNODE_APP_ID/PORT/USERNODE_ENV add
      // entries here. The Homeroom platform
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
      // Reserved keys (DATABASE_URL, USERNODE_JWT_PUBLIC_KEY,
      // USERNODE_APP_ID, JWT_SECRET, PORT, USERNODE_ENV,
      // USERNODE_MISSING_SECRETS) are managed by the platform and
      // can't appear in this list.
      path: 'dapp.json',
      content: JSON.stringify(
        {
          ...(about ? { description: about } : {}),
          secrets: [],
          ...(governanceBlock ? { governance: governanceBlock } : {}),
        },
        null,
        2,
      ),
    },
    // The `.claude/` entries come from the shared helper above, which an
    // import and a fork also call — see its note. The canonical-repo pointer
    // is per app, so it is added beside them rather than inside them.
    ...getConnectorScaffoldFiles(),
    ...(canonicalRepoFile ? [canonicalRepoFile] : []),
    {
      path: 'server.js',
      content: `const express = require('express');
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

${demo.routes}

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
${demo.table}
  const server = app.listen(port, () => console.log(\`Listening on :\${port}\`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
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

${demo.section}

    <p class="text-center text-xs text-zinc-600">Built on Homeroom — this template screen disappears once you build your real app.</p>
  </main>

${demo.script}
</body>
</html>
`,
    },
  ];
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = {
  getTemplateFiles,
  getConnectorScaffoldFiles,
  getCanonicalRepoFile,
  canonicalRepoUrl,
  CANONICAL_REPO_PATH,
  FRESHNESS_HOOK_PATH,
};
