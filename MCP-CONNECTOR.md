# The Usernode connector in Claude and ChatGPT

Usernode hosts an MCP connector at `https://<your-usernode-host>/mcp`. Connect
it from Claude.ai or ChatGPT and you can browse apps, file requests and turn
finished work into proposals from the chat you already have open, with the
coding done by Claude Code or Codex on your own subscription.

This document is about **permission prompts**: why every call used to raise
one, what Usernode ships to stop that, and what you have to check on your own
side for it to actually take effect. The authentication and transport design
lives in [CLI-MCP-AUTH-SPEC.md](CLI-MCP-AUTH-SPEC.md).

---

## The short version

1. Name the connector **`usernode`** when you add it. The permission rules
   Usernode ships hardcode that name and there is no wildcard for it.
2. New app repos are scaffolded with a `.claude/settings.json` that allows the
   read-only connector calls. Accept the workspace trust dialog once and the
   per-call prompts for reads stop.
3. The tools that change something still prompt, every time, and Usernode marks
   them so that stays true even in permissive modes.

---

## 1. The connector's name, and why it is load-bearing

A Claude Code permission rule names the server it applies to:

```
mcp__usernode__get_*
```

The server segment is a **literal**. Glob syntax is accepted only *after* the
`mcp__<server>__` prefix, so the rule names one specific server you configured.
There is no `mcp__*__get_*` fallback.

That has a sharp consequence: **a rule aimed at a connector under a different
name fails silently.** No error, no warning — you keep getting prompted and
conclude the instructions were wrong.

### Where the name comes from

Two different things could supply it, and they behave differently:

- **The server's own `serverInfo.name`.** Usernode reports `usernode` — the
  constant is `SERVER_NAME` in `src/services/mcp-connect-constants.js`, and it
  has always been spelled correctly.
- **What you typed.** Claude.ai's *Settings → Connectors → Add custom
  connector* dialog has a **Name** field, and the client builds tool names from
  the string you put in it.

Issue #1218 reported an account whose tools arrived as `mcp__Uesrnode__whoami`.
That string appears nowhere in Usernode's source. It was typed at connect time,
which makes it a **name you can fix on your side in ten seconds** rather than a
platform bug — and it is why the Settings → Connectors panel now tells you the
canonical name up front instead of leaving the field to chance.

### Why `usernode` (lowercase) is the canonical spelling

Because it is exactly what `serverInfo.name` reports. A client that derives the
name from the server and a client where a human typed it then agree, and one
set of rules works for both. Any other spelling makes those two paths disagree.

### Read the name off your own tool list

Do not trust a copy-pasted snippet — including the one in this file. The
prefix Usernode's tools arrive under **differs by surface**:

| Surface | What the tools are called |
|---|---|
| Claude Code (cloud/web session, this one) | `mcp__usernode__whoami` |
| Claude connector plumbing that namespaces by client | `mcp__claude_ai_usernode__whoami` |

Guidance that names only one form is wrong for the other half of users, so:
**look at the tool names you actually see, take the segment between the first
and last `__`, and use that as the server segment of your rules.** If it is not
`usernode`, either edit the rules or reconnect the connector under the
canonical name.

---

## 2. Tools that act always prompt

Usernode marks its acting tools with the `anthropic/requiresUserInteraction`
metadata Claude Code reads off a tool definition:

```json
{ "name": "submit_work", "_meta": { "anthropic/requiresUserInteraction": true } }
```

For a tool marked this way, Claude Code shows the permission prompt on **every**
call — in `acceptEdits`, `auto` and `bypassPermissions` alike — offers no "don't
ask again", and skips it for no allow rule. On Remote Control and mobile it also
withholds one-tap approval, so the confirmation comes from somebody reading the
prompt rather than from a tap.

Five tools carry it:

| Tool | Why it deserves a person |
|---|---|
| `submit_work` | Opens or advances a proposal — starts a group vote |
| `create_request` | Files publicly, on the app's board and as a GitHub issue |
| `prepare_work` | Spends an hourly allowance; mints a task that dangles if unused |
| `start_platform_build` | Spends the user's daily Usernode credits |
| `submit_platform_build` | Puts that build to a group vote |

Everything else keeps normal behaviour. `answer_questions` is a write but is
deliberately unmarked: it only feeds text to a build the user already started,
and an unskippable prompt inside a poll loop buys no decision they have not
already made.

**This is defence in depth, not a control to lean on.** It requires Claude Code
**2.1.199 or later**; earlier versions ignore the metadata and apply the
standard permission flow. That version gate is the whole reason for the shape of
the next section.

---

## 3. The allowlist Usernode ships

Every app repo Usernode scaffolds gets a `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__usernode__get_*",
      "mcp__usernode__list_*",
      "mcp__usernode__whoami"
    ]
  }
}
```

Project settings load from the repo's `.claude/` directory, so every user of
every app picks this up with no setup, and a `.claude/README.md` beside it
carries the reasoning (JSON has no comments).

### Why not `mcp__usernode__*`

Because the marking in section 2 is version-gated. A whole-server rule would
auto-approve `submit_work` for anyone on a client older than 2.1.199 — a change
reaching a group vote with nobody having confirmed it. Two globs and one literal
can only ever match reads, on every version. **Never widen these to a
wildcard.**

### The naming contract that keeps those globs honest

The globs are durable only because tool naming is treated as a **contract**, not
a description:

- A read-only tool is named `get_*` or `list_*`.
- A tool that acts is **never** named `get_*` or `list_*`.

`whoami` is the single grandfathered exception, which is why it gets its own
literal entry. The contract is enforced by `tests/mcp-tools.test.js` against the
registered tool surface, so a new acting tool named `get_something` fails the
suite rather than quietly becoming allowed in every scaffolded repo. Add a read
and it is allowed everywhere with no migration; add an action and give it any
other name.

### One workspace trust dialog

`permissions.allow` rules in a project's `.claude/settings.json` grant
capability, so Claude Code applies them **only after you accept the workspace
trust dialog** for that workspace. Until then it reads the rules and does not
apply them. The dialog lists the allow rules, so you can review these three
before accepting.

That is the right trade. A repo silently granting a connector permission on your
behalf is exactly what the trust check exists to prevent, and one reviewable
consent beats dozens of per-call prompts.

> **Open question — does workspace trust persist across
> ephemeral web containers?**
>
> A Claude Code **web** session clones the repo fresh each time. If trust state
> lives in the container rather than in the account, web users trade per-call
> prompts for a per-session trust dialog. That is still a large improvement —
> one dialog instead of thirty — but it is not silent, and it should not be
> announced as if it were.
>
> **This has not been settled.** It cannot be answered from this repository: it
> needs a fresh Claude Code web session, on a scaffolded app, checked for
> whether the trust dialog reappears on the second session. Nothing in the
> implementation depends on the answer — the file, the rules and the marking are
> correct either way — so it is recorded here rather than blocking. If you run
> that session, replace this box with what you saw.

---

## 4. Existing apps

The scaffold covers **new** app repos. An existing app needs the file added,
which on this platform means a proposal and a vote per app — unless the platform
writes it into app repos directly, the way it already manages their branches.
That rollout is not part of #1218.

Until then, a user can add the same three rules themselves, at any of the levels
Claude Code reads settings from — the repo's `.claude/settings.json`, their
personal `~/.claude/settings.json`, or `.claude/settings.local.json` if they do
not want it committed. Personal settings apply to every repo at once, which is
often what someone working across several Usernode apps actually wants.

---

## Troubleshooting

**Still prompted on every read.**
Check the server segment first — it is the usual cause. Run a read-only tool and
look at the name in the prompt: if it is not `mcp__usernode__…`, your connector
is registered under a different name and the rules do not match it. Fix the rules
or reconnect under `usernode`. Then check you accepted the workspace trust dialog
for this workspace.

**Prompted on `submit_work` even though I allowed it.**
Working as intended. The `requiresUserInteraction` marking outranks allow rules,
by design — that call starts a group vote.

**I am on an old Claude Code and want the strong guarantee.**
Upgrade to 2.1.199 or later. Below that the marking is ignored and only the
narrowness of the allowlist protects the acting tools — which is why the shipped
rules enumerate the reads instead of allowing the server.
