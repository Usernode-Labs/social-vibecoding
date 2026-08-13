# Usernode connector setup

The hosted MCP connector lets a chat product (Claude.ai, ChatGPT) and a
coding agent (Claude Code, Codex) read the platform and act on your
behalf. This document covers two things that are easy to get wrong and
fail *quietly*:

1. **what to name the connector** — one canonical spelling, `Usernode`;
2. **how to stop the read-only tools prompting on every call**, without
   pre-approving the ones that act.

Everything below is served live: this file is published at
`https://<your-domain>/connector-setup.md`, and the connector's `whoami`
tool returns the same name, the same rules and the same JSON snippet, so
a running deployment never disagrees with its own docs.

## 1. Add the connector

In **Claude.ai → Settings → Connectors → Add custom connector**:

| Field | Value |
| --- | --- |
| **Name** | `Usernode` |
| **URL** | `https://<your-domain>/mcp` |

The platform's own **Settings → Connectors** screen shows both, each with
a copy button, filled from the server rather than typed into the page.
Copy them; don't retype them.

### Why the name matters more than it looks

The name is a free-text field. Whatever you type there becomes part of
the tool identifiers your client uses, so a connector added as
`Uesrnode` works perfectly — every tool call succeeds — but every
permission rule written for `Usernode` now matches nothing. There is no
warning, no error, no "unknown server" line in a log. The only symptom is
that you get prompted on every single call, which is exactly what the
rules were meant to stop, and it looks like the rules simply "don't
work".

The server advertises `Usernode` in two places a client may pre-fill
from — `serverInfo.name` in the `initialize` response, and `resource_name`
in the RFC 9728 protected-resource metadata at
`/.well-known/oauth-protected-resource` — and both are derived from a
single constant (`SERVER_NAME` in
`src/services/mcp-connect-constants.js`). Neither is authoritative for
your client's permission rules, because the name is yours to type. Type
it exactly.

## 2. Read-only tools vs acting tools

The connector's fourteen tools split cleanly, and the split is declared
in the tool definitions themselves via the `requiresUserInteraction`
annotation (alongside `readOnlyHint` / `destructiveHint` /
`openWorldHint`):

**Read-only — `requiresUserInteraction: false`.** These answer questions.
They change nothing, cost nothing and are safe to repeat; an agent
orienting itself may call several of them dozens of times in a session.

- `whoami` — who you are, which scopes the token carries, and the
  permission block described below
- `get_platform_conventions` — the platform's app-authoring rules
- `list_apps`, `get_app` — the app catalogue
- `list_requests` — open feature requests
- `get_proposal`, `list_my_proposals` — proposal state
- `get_platform_build` — status of a platform build you already started

**Acting — `requiresUserInteraction: true`.** These change something
under your name.

- `create_request` — files a feature request as you
- `prepare_work` — creates a work order and a fork
- `submit_work` — **opens a pull request and puts a change to a group
  vote**
- `start_platform_build`, `submit_platform_build`, `answer_questions` —
  spend your daily platform credits and drive a build to submission

That annotation is a **declaration, not a grant**. It tells a client
which calls the server itself thinks are worth stopping for; a client is
free to ignore it, and Claude Code's documented permission model does not
read MCP annotations at all. Which brings us to the part that does work.

## 3. Pre-approve the reads (client-side, in your own settings)

An MCP server cannot reduce its own prompting, and must not be able to —
a server that could pre-approve itself would defeat the permission system
outright. Prompt reduction lives entirely on the client side, in
`permissions.allow` rules **you** hold, in your own
`.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__Usernode__get_app",
      "mcp__Usernode__get_platform_build",
      "mcp__Usernode__get_platform_conventions",
      "mcp__Usernode__get_proposal",
      "mcp__Usernode__list_apps",
      "mcp__Usernode__list_my_proposals",
      "mcp__Usernode__list_requests",
      "mcp__Usernode__whoami"
    ]
  }
}
```

Every app created from the Usernode scaffold ships with exactly this
file, and so does the platform repository itself. If you need it for an
existing checkout, copy it from the Settings → Connectors screen, or ask
the assistant to call `whoami` — its `permissions.settingsJson` field is
this text, generated from the same source as the scaffold's copy.

**The six acting tools are deliberately absent, and their absence is the
point.** With this file in place, an orienting agent stops interrupting
you, and the next prompt you *do* see means something: it is `submit_work`
about to open a vote, or `create_request` about to file something in your
name. Adding them back is a decision to stop being asked before a change
goes out under your name.

### Rules for writing these rules

- **The server segment cannot be a glob.** A rule is
  `mcp__<server>__<tool>`; wildcards are only honoured *after* a literal,
  glob-free `mcp__Usernode__` prefix. There is no `mcp__*__get_*`
  fallback that would survive a misspelling — see §1.
- **One literal rule per tool, not `mcp__Usernode__get_*`.** A glob
  silently widens the moment a tool is added whose name happens to match
  it. This list is what stands between "approve reads once" and
  "approved something that opens a vote", so it is enumerated.
- **A rule naming a tool that doesn't exist is inert, not an error.** If
  you have hand-written rules and are still being prompted, compare your
  tool names against `whoami`'s `permissions.allow` before assuming the
  feature is broken.
- **Machine-local overrides go in `.claude/settings.local.json`**, which
  is gitignored. `.claude/settings.json` is committed, and is the shared
  baseline.

### What these rules do not do

They are **client-side convenience only**. They change how often *your*
client stops to ask you, and nothing else. They are not a scope, not a
credential, and they are not read by the server:

- the OAuth token still carries `usernode:apps:read` and/or
  `usernode:proposals:write`, and `scopeGuard()` still runs before any
  platform call, so a write attempted on a read-only token is refused
  regardless of what your settings file says;
- every per-user cap still applies (connector-opened proposals per 24h,
  `prepare_work` orders per hour, open work orders, platform-build runs)
  and every limiter fails closed;
- `submit_work` still requires the PR to be headed by your own verified
  fork, and still produces an ordinary proposal with staging checks and a
  group vote.

Deleting the allow list makes your session noisier. It does not make it
more secure, and adding to it does not grant anything the token didn't
already carry.

## 4. Troubleshooting

**"I'm prompted on every call anyway."** In order of likelihood: the
connector is named something other than `Usernode` (§1 — check the name
field in your client, not the URL); the rules are in a settings file the
client isn't reading; a tool name is misspelled. Ask the assistant to
call `whoami` and show you the `permissions` block — it returns
`toolPrefix`, the exact `allow` array, the `alwaysPrompts` array, and
`settingsPath`, all generated by the running server.

**"I'm prompted for `submit_work`."** Working as designed. See §3.

**"The connector won't connect."** That is an OAuth problem, not a
permissions one — see the *Chat connector operations* section of
`SELF-HOSTING.md`, particularly `MCP_CONNECTOR_REDIRECT_HOSTS`.

## Where this lives in the code

| Thing | File |
| --- | --- |
| `SERVER_NAME`, `PERMISSION_RULE_PREFIX` | `src/services/mcp-connect-constants.js` |
| Tool classification, annotations, generated settings | `src/services/mcp-tools.js` |
| `serverInfo.name`, `resource_name`, the `setup` block on `/api/me/connectors` | `src/routes/mcp-remote.js` |
| The scaffold's copy of `.claude/settings.json` | `src/services/template.js` |
| Settings → Connectors UI | `frontend/src/features/settings/sections/connectors.tsx` |
| Tests holding all of the above to one spelling | `tests/connector-permissions.test.js` |
