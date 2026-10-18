const fs = require('fs');
const path = require('path');
const nodeAppPackage = require('../templates/node-app/package.json');
const nodeAppLock = require('../templates/node-app/package-lock.json');
const { getStarter, DEFAULT_TEMPLATE } = require('../templates/app-starters');

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

// repoUrl is the app's canonical GitHub repository; with it the scaffold
// includes the pointer file the freshness check reads. A local build with no
// GitHub has none, and gets no pointer.
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
function getTemplateFiles(appName, slug, dbUrl, repoUrl = null, { governance = null, description = null, template = DEFAULT_TEMPLATE } = {}) {
  const starter = getStarter(template);
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

${starter.claudeStarter}

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

${starter.readmeDemo}

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
      content: starter.server({ appName, slug, dbUrl }),
    },
    {
      path: 'public/index.html',
      content: starter.index({ appName }),
    },
  ];
}

module.exports = {
  getTemplateFiles,
  getConnectorScaffoldFiles,
  getCanonicalRepoFile,
  canonicalRepoUrl,
  CANONICAL_REPO_PATH,
  FRESHNESS_HOOK_PATH,
};
