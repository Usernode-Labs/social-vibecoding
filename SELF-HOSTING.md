# Self-hosting Usernode inside itself

Design notes for registering Usernode as an app *inside itself*, so
users (admin-gated initially) can propose and merge edits to the
harness via the harness's own dev-chat / Mayor / Claude Code flow.

This depends on `EXTRACT-PLAN.md` being executed first — at minimum
Phase 1–2. "Edit this app" means "edit a GitHub repo," and the repo
needs to be Usernode-only before Usernode can meaningfully point at
itself.

## Why this is worth doing

- **Dogfooding of the most aggressive kind** — every sharp edge of the
  platform gets felt immediately.
- **Tight feedback loop** — user hits the feedback button (issue filed
  in the Usernode repo) → opens the Usernode app inside Usernode →
  "@mayor pick up #42" → PR → merge → harness rolls → the UI they're
  looking at now has their fix.
- **Validates the platform by construction** — if Usernode can safely
  edit itself, it's probably coherent.
- **`/claude.md` stays live by construction** — editing
  `app-conventions.md` through the self-app and merging makes the new
  conventions immediately served at the hosted URL.

## Basic shape

In the `apps` table, each row has: name, repo, main_sha, container,
owner. The self-app is just one more row with a `self_hosted: true`
flag, whose repo is `Usernode-Labs/social-vibecoding` and whose
"container" is *this process*.

Dev-chat works identically: Mayor plans, Claude Code checks out the
repo in a sibling Docker container, produces a PR. What diverges is
what happens when the PR merges.

- **Normal app:** merge → rebuild that app's container → swap in.
- **Self-app:** merge → the harness itself has to roll.

## Deploy path

Two levels of ambition:

### MVP (recommended first)

Short downtime. PR merge triggers the standalone deploy workflow;
`docker-compose pull && up -d` restarts the harness; 20–60s of 503s.
A "platform rolling — reconnecting…" banner in the UI + SSE
auto-reconnect makes this feel acceptable.

Reuse the existing `app_version_changed` WebSocket event (already
shipped for issue #21) to drive the banner. Client polls
`/api/version`, re-opens SSE when the new SHA is live.

### Eventually: blue-green

Two harness containers behind Caddy; new image starts healthy before
old drains; active SSE streams reconnect. Substantial engineering
project; ship only once MVP downtime actually annoys someone.

## Staging for the self-app

Two hard questions specific to this app: (1) how do public/private
tables work for the harness's own DB? (2) how does the staging
harness manage *its own* Docker containers without stomping on prod?

### DB: private/public tagging for harness tables

Same `staging:private` comment mechanism every other app uses. In
practice the harness's tables are overwhelmingly private:

| Table             | Default    | Why                                         |
| ----------------- | ---------- | ------------------------------------------- |
| `users`           | private    | password hashes, encrypted API keys         |
| `chat_messages`   | private    | verbatim user messages                      |
| `notifications`   | private    | who-said-what-to-whom                       |
| `llm_usage`       | private    | per-user spend history                      |
| `feedback`        | private    | can contain private gripes                  |
| `votes`           | private    | links to user_id                            |
| `apps`            | public     | names + repos + main_sha already visible    |
| `issues` (if any) | public     | mirrors GitHub                              |

Wrinkle: `apps.creating_user_id` FKs to `users.id`. Options:

- **Don't copy `apps` either** — seed 1–2 test apps at boot. Cleanest.
- Copy `apps` but remap `creating_user_id` to a seeded test-user id.

Recommendation: don't copy. Staging being empty is a feature — you're
testing platform behavior, not production data, and an empty platform
stresses first-time UX better anyway.

**Seeded fake users required.** On boot in `USERNODE_ENV=staging`,
run a seed script:

```
admin-staging / admin  (admin role)
test-user-1   / test
test-user-2   / test
```

Documented in a login banner on staging. No real user data, no real
secrets, still usable.

This is also the strongest *proof that the convention works for the
worst case* — the harness is the most privacy-sensitive app on the
platform, and the same rules fit it without modification.

### Docker isolation: staging must not share a daemon with prod

Prod harness mounts `/var/run/docker.sock` and uses the host daemon.
If the staging harness does the same on the same host:

- Staging and prod see each other's containers.
- A bad `docker rm` in staging can nuke prod app containers.
- Container name collisions are possible.

**The rule: staging never shares a Docker daemon with prod.** Three
realistic isolation strategies, cheapest to most faithful:

**A. Mock Docker in staging.** Replace the `docker` service with a
stub that logs intended calls (`would run: docker run ...`) and
returns plausible success values. Nothing gets spawned.

- Cheap, fast, perfectly safe.
- Tests dev-chat flow, Mayor planning, CC *dispatch UI*, DB writes,
  WebSockets, UI.
- Can't verify "CC actually ran and produced a commit" end-to-end.
- Right choice for ~80% of self-app PRs (UI, prompts, chat-system,
  schema changes).

**B. Docker-in-Docker (DinD) sidecar per staging instance.** The
staging harness gets a dedicated DinD container next to it; its
socket is mounted from the sidecar, not the host. Containers it
spawns live inside that DinD daemon, invisible to prod.

- ~1 GB extra RAM per staging instance, requires `--privileged`.
- Full fidelity — spawned CC workers and app containers really run.
- Safe from prod: even
  `docker rm $(docker ps -q)` only kills things inside its DinD
  universe.
- Opt-in and time-boxed: admin clicks "preview with DinD" on a PR,
  lives 2 hours, auto-destroyed. One active at a time initially.

**C. Real host daemon with strict namespace prefixing.** All staging
containers named `staging-<sha>-*`, every `docker ps` / `docker stop`
filtered. **Rejected** — leaks to prod the moment a bug slips the
prefix discipline, and the whole point of staging is that the code
might be wrong.

### Staging-mode matrix

| Staging mode                   | DB               | Docker   | Use case                                  |
| ------------------------------ | ---------------- | -------- | ----------------------------------------- |
| Default auto-preview every PR  | empty + seeded   | mock (A) | UI, prompt, chat-system, schema changes   |
| Deep-preview (admin opt-in)    | empty + seeded   | DinD (B) | Mayor/CC interaction, container template  |

### Staging env wiring

The staging harness boots with:

- `USERNODE_ENV=staging`
- `DATABASE_URL` pointing at a fresh ephemeral Postgres
- A seed script run at startup
- `GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` **unset** (any CC dispatch
  fails cleanly with "feature disabled in staging") or pointing at a
  test-only GitHub App with access only to a sandbox repo
- `ANTHROPIC_API_KEY` = admin BYOK or a billing-capped test key
- Docker socket: **not mounted** (mock mode) or **from DinD sidecar**
  (deep-preview)
- Lifetime capped at 2 hours, visible in a preview-URL banner
- Caddy routes `usernode-preview-<sha>.evanshapiro.dev` to the
  staging harness port

### Clever twist for CC-integration testing

Even with DinD, staging shouldn't push to *real* repos — its GitHub
App key should be blank or sandbox. But if we want end-to-end
verification that a CC dispatch produces a coherent commit under the
new harness code, point staging at a designated **test repo**
(`es92/usernode-test-sandbox`). The staging harness has commit access
there and nowhere else. A CC run writes real commits to this test
repo; we inspect them; no real user apps are touched.

Full-fidelity end-to-end testing for the high-risk category
(Mayor/CC changes) without any possibility of damaging production.

## Safety rails

**Manual review gate on self-app PRs.** Claude Code produces the
branch and opens the PR, but does **not** auto-merge for the self-app.
Admin clicks merge.

**Kill-switch / rollback path that doesn't go through the harness.**
A small shell script on the VPS — `/opt/usernode/rollback.sh` — that
does `git checkout <prev_sha> && docker compose up -d`. Ssh in and
run it if the harness is on fire. **Write and test this before
enabling the self-app**, not after.

**Admin-only gate** on the self-app's dev-chat. Every registered
user can file issues against the self-app (via the feedback button),
but initially only admins can initiate dev-chat turns against it.
Permission model can relax later.

**Mayor refuse-list for high-risk paths.** Bake into the self-app's
injected Mayor system prompt: refuse to plan edits to certain file
globs without an explicit `allow_risky: true` confirmation. Candidates:

- `server.js` bootstrap path
- `src/middleware/auth.js`
- Anything touching `JWT_SECRET` or `secrets.js`
- `src/db/migrate.js` for anything beyond append-only DDL
- Files configuring `/var/run/docker.sock` mounting

**State hazards to document explicitly:**

- Changing `JWT_SECRET` invalidates all sessions AND renders every
  stored BYOK key undecryptable.
- Schema migrations run against the live shared DB at boot. Append-
  only DDL is fine; anything that rewrites user data is dangerous.
- The harness DB is *entirely private* in the public/private sense;
  staging always starts empty.

## Edit-type risk bucketing

| Edit type                              | Risk       | Gating                                         |
| -------------------------------------- | ---------- | ---------------------------------------------- |
| UI of main app                         | Low        | Staging preview nice-to-have, else merge       |
| Group chat system                      | Low–med    | Staging preview; PR review required            |
| New features in app-container template | Low        | Staging preview; PR review required            |
| Mayor/CC interaction                   | Medium     | Deep-preview (DinD) mandatory; admin-only      |
| Auth / JWT / encryption / migrations   | High       | Refuse-list; explicit `allow_risky` flag       |
| `server.js` bootstrap, docker socket   | Very high  | Require `ALLOW_BOOT_EDITS=1` just to propose   |

The Mayor's system prompt for the self-app grows one extra paragraph
listing refuse-list globs.

## UX details that matter

**"Platform updating…" banner during rolling restart.** When a
self-app PR merges, the client knows via WebSocket
`app_version_changed`. Show a banner, disable the send button, poll
`/api/version`, reconnect SSE when the new SHA is live.

**"You're editing the platform" marker** in the self-app view so
users understand why the UI may shift under them during deploy. A
purple pill or the word "meta" near the header is enough.

**Budget accounting is unchanged.** Self-app edits consume Anthropic
tokens like any dev-chat turn. BYOK works identically. No special-
casing needed.

## MVP scope — one week of work after extraction is done

1. **Seed the `apps` table** with a `usernode` row, `self_hosted:
   true`, admin-only visibility.
2. **Special-case PR-merge** in `routes/sessions.js`: if
   `self_hosted`, call a different deploy handler that triggers the
   standalone workflow (or an SSH command) instead of rebuilding an
   app container. Don't auto-merge — open the PR in draft, notify
   admins.
3. **Write `rollback.sh`** on the VPS, test it once, leave it there.
4. **Inject self-app safety rules** into Mayor's system prompt
   (refuse-list globs; staging-preview requirement).
5. **Add the "platform updating" banner** using the existing
   `app_version_changed` event.
6. **Ship in shadow first** — self-app visible to admins only, no
   staging yet, just to dogfood the happy path.

Add per-PR staging previews (mock mode) once we've seen the shape of
real self-app edits. Add DinD deep-preview once we actually need to
verify a CC run through the new code.

## What this unlocks

- **Self-hosting feedback loop:** feedback button → issue → Mayor
  picks up → PR → merge → rolling restart. Zero external tooling for
  platform evolution.
- **The platform's evolution is legible to users** — its commit log
  is visible, its proposed changes land as PRs anyone can read.
- **`/claude.md` stays synced by construction** — editing
  `app-conventions.md` through the self-app updates the hosted URL
  on next deploy.
- **Open-source-by-live-dev-chat (future)** — drop the admin-only
  gate, let any user propose changes, admins approve merges. A
  genuinely novel collaboration model.
