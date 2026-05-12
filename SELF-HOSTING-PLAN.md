# Self-hosting execution plan

Sibling to [SELF-HOSTING.md](./SELF-HOSTING.md) (the design doc).
This file is the actionable, phase-by-phase plan for shipping the
self-app — the apps row whose container *is* the running platform —
with the minimum amount of new code.

## Design principle

SELF-HOSTING.md framed self-hosting as "add a `self_hosted` flag and
special-case three handlers." The cleaner framing is the inverse:

> **Make the platform conform to its own conventions for itself.
> Let the only special-casing live at the two points where the
> platform genuinely *is* its container.**

Three semantic systems unify cleanly: per-app database name,
public/private table convention, and `dapp.json` env-var manifest.
Two points genuinely cannot unify: container creation
(the parent container already exists) and PR-merge rebuild (the
parent cannot stop and restart itself the way child apps do).

```mermaid
flowchart TD
    subgraph unified [Unifies cleanly]
        DB["Per-app database<br/>'usernode' &rarr; 'app_usernode_xxxxxx'"]
        Tables["Public/private tables<br/>add staging:private COMMENTs to schema"]
        Manifest["Env vars / dapp.json<br/>declare platform secrets in root manifest"]
    end

    subgraph special [Genuine special-casing]
        Create["createApp(): if self_hosted, no-op<br/>(container already exists, it's the parent)"]
        Merge["votes.js merge: if self_hosted, skip<br/>rebuildProduction; trust auto-deploy"]
    end

    DB --> SeedRow[Seed apps row<br/>slug='usernode', container_id='usernode',<br/>status='running', self_hosted=true]
    Tables --> Enforce[Phase 0: implement TRUNCATE-private<br/>in cloneDatabase]
    Manifest --> SeedRow
    Enforce --> SeedRow
    SeedRow --> Create
    SeedRow --> Merge
```

## Status going in

- **EXTRACT-PLAN.md Phase 1 (extract repo)** — done.
- **EXTRACT-PLAN.md Phase 3 (standalone deploy)** — done.
  [docker-compose.yml](./docker-compose.yml) is self-contained,
  [.github/workflows/deploy.yml](.github/workflows/deploy.yml)
  auto-deploys on push to `main`.
- **The hidden gap:** `staging:private` is documented at
  [src/prompts/app-conventions.md](./src/prompts/app-conventions.md)
  and recommended to child apps, but
  [src/services/db-manager.js](./src/services/db-manager.js)'s
  `cloneDatabase` is wholesale `CREATE DATABASE … TEMPLATE …`. So
  every child app's `staging:private` annotation is doing nothing
  today. Self-hosting forces this gap shut, which retroactively
  makes every existing child app's privacy claim true.

## Phase 0 — Enforce `staging:private` in `cloneDatabase`

Independent prerequisite. Useful in its own right; must land before
self-app staging is ever enabled.

**Goal:** child apps' `COMMENT ON TABLE foo IS 'staging:private'`
annotations actually keep rows out of staging clones, and column-level
`COMMENT ON COLUMN foo.bar IS 'staging:private'` annotations scrub the
named columns while leaving the surrounding row intact (the latter is
the canonical pattern for `users`, where row identity is needed in
staging for FK attribution but a few columns carry secrets).

**Steps:**

1. Add a post-clone TRUNCATE pass to
   [src/services/db-manager.js](./src/services/db-manager.js)
   `cloneDatabase`, or to the call site in
   [src/services/staging.js](./src/services/staging.js) right after
   `cloneDatabase` returns. Implementation sketch:

   ```sql
   -- Discover private tables in the freshly-cloned DB.
   SELECT n.nspname || '.' || c.relname AS qualified
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE obj_description(c.oid, 'pg_class') = 'staging:private'
      AND c.relkind = 'r'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema');

   -- Then for each:
   TRUNCATE <qualified> RESTART IDENTITY CASCADE;
   ```

2. Run inside the cloned DB, not the meta-DB. `db-manager.execInDb`
   currently always targets `usernode`; need a sibling `execInTarget(dbName, sql)`
   that does `psql -d <dbName>`. ~10 lines.
3. Wrap in a try-finally so a TRUNCATE failure on one private
   table doesn't block the others (log + continue), but a total
   discovery failure is fatal (we'd rather refuse to spawn staging
   than ship a leaky one).

**Acceptance criteria:**

- A child app with `COMMENT ON TABLE foo IS 'staging:private'`,
  triggered through dev-chat to spawn a staging container, observes
  `foo` schema-only in the staging DB.
- The same app's *public* tables still come over fully populated.
- A unit/integration test in
  [test/](./) — pick a folder convention from existing tests —
  exercises clone + TRUNCATE on a fixture DB.

**Risk:** low. The change is additive (TRUNCATEs only what's
explicitly opted in via comment) and only affects staging clones.
Production deploys don't go through `cloneDatabase`.

**Rollback:** revert the commit. Pre-Phase-0 staging behavior
(wholesale copy) returns; nothing else changes.

**Cost:** ~30–50 lines of code + one test.

## Phase 1 — Write and rehearse `rollback.sh`

Independent prerequisite. Per SELF-HOSTING.md: "Write and test this
before enabling the self-app, not after."

**Goal:** a kill-switch that does not depend on the harness being
healthy.

**Steps:**

1. Add `scripts/rollback.sh` (in-repo). Contents (sketch):

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   cd /opt/usernode
   PREV_SHA="$(git rev-parse HEAD~1)"
   echo "Rolling back to $PREV_SHA"
   git checkout "$PREV_SHA"
   docker compose up -d --build
   echo "Rollback complete. Current SHA: $(git rev-parse --short HEAD)"
   ```

2. In [.github/workflows/deploy.yml](./.github/workflows/deploy.yml),
   add a step to copy `scripts/rollback.sh` to
   `/opt/usernode-tools/rollback.sh` (separate dir, never rsync'd
   over by the deploy itself, so a broken deploy can't clobber the
   recovery script). `chmod +x` after copy.
3. SSH in and rehearse it once: roll forward to a no-op commit,
   run rollback, verify the harness comes back on the previous SHA.
   Document the SSH-in steps in [README.md](./README.md) under a
   new **Recovery** subsection.

**Acceptance criteria:**

- `/opt/usernode-tools/rollback.sh` exists on the VPS and is
  executable.
- One successful end-to-end rehearsal logged in the README or a
  commit message.

**Risk:** zero — the script is purely opt-in and runs only when
manually invoked.

**Cost:** ~20 lines of shell + one rehearsal.

## Phase 2 — Platform conforms to its own conventions

The meat. Each sub-step is small and independently safe to land;
together they make the self-app row mechanically identical to a
normal app row, with the two unavoidable guards layered in.

Land sub-steps in the order below. Each is independently testable.

### 2a. Add `self_hosted` column

[src/db/schema.sql](./src/db/schema.sql):

```sql
ALTER TABLE apps
  ADD COLUMN IF NOT EXISTS self_hosted BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_apps_self_hosted
  ON apps (self_hosted) WHERE self_hosted = TRUE;
```

The partial index is there because the seed-and-startup paths
filter on `self_hosted = TRUE` and there's only ever one such row.

**Acceptance:** schema migration is idempotent, existing rows
default to `FALSE`.

### 2b. Move platform repo URL into config

Today
[src/routes/feedback.js](./src/routes/feedback.js)
hardcodes `Usernode-Labs/social-vibecoding`. Pull it into
[src/config.js](./src/config.js) as `USERNODE_PLATFORM_REPO`
(default
`https://github.com/Usernode-Labs/social-vibecoding`). Both
`feedback.js` and the seed read from there. Document in
[.env.example](./.env.example) for completeness.

**Acceptance:** feedback button still files issues correctly;
unset `USERNODE_PLATFORM_REPO` falls back to the default.

### 2c. Add `staging:private` comments to platform schema

Purely additive. Append to [src/db/schema.sql](./src/db/schema.sql).

**Table-level (8 tables — full TRUNCATE in staging):**

```sql
COMMENT ON TABLE sessions               IS 'staging:private';
COMMENT ON TABLE activation_codes       IS 'staging:private';
COMMENT ON TABLE chat_sessions          IS 'staging:private';
COMMENT ON TABLE chat_session_messages  IS 'staging:private';
COMMENT ON TABLE chat_session_specs     IS 'staging:private';
COMMENT ON TABLE llm_usage              IS 'staging:private';
COMMENT ON TABLE notifications          IS 'staging:private';
COMMENT ON TABLE app_secrets            IS 'staging:private';
```

**Column-level on `users` (5 columns scrubbed, row identity preserved):**

```sql
COMMENT ON COLUMN users.password               IS 'staging:private';
COMMENT ON COLUMN users.anthropic_key_enc      IS 'staging:private';
COMMENT ON COLUMN users.anthropic_key_last4    IS 'staging:private';
COMMENT ON COLUMN users.wallet_link_token      IS 'staging:private';
COMMENT ON COLUMN users.wallet_link_expires_at IS 'staging:private';
```

`users` rows survive cloning so FK attribution
(`chat_messages.user_id`, `apps.created_by`, `notifications.source_user_id`,
…) keeps working in self-app staging — without this, every dev-chat
message in a staging clone would render as "(deleted user)".
`usernode_pubkey` is intentionally NOT scrubbed: it's an on-chain public
identity, and a self-app dev wants to see it to test wallet-linking
flows. `password` is scrubbed to a sentinel
(`__staging_redacted__`); the future iframe-auth scheme (parent prod
issues identity assertions to staging via postMessage) means staging
won't need local `users.password` at all.

**Public by omission (no comment):** `apps`, `app_activity`, `issues`,
`users` (the table itself — only specific columns are scrubbed),
`chat_messages`, `issue_votes`, `pr_votes`. These carry no per-row
secrets and the aggregates are already visible in the prod UI to the
audience that would clone the platform.

**Acceptance:** `obj_description((schemaname || '.' || tablename)::regclass, 'pg_class')` returns
`'staging:private'` for the 8 listed tables; `col_description` returns
`'staging:private'` for the 5 listed columns of `users`. With Phase 0
in place, a hypothetical staging clone of the platform DB would have
schema-only copies of those tables and scrubbed columns of `users`.

### 2d. Rename platform DB to follow `app_<slug>` convention

Slug: **`usernode-2d5619`** → DB name: **`app_usernode_2d5619`**.
The `usernode-` prefix matches the container name and the user-facing
brand; the `2d5619` hex suffix (generated once via
`crypto.randomBytes(3).toString('hex')`, frozen at this commit) avoids
a collision with a hypothetical child app whose user-chosen slug
happens to be `usernode`.

Pinned as `SELF_APP_SLUG` and `SELF_APP_DB_NAME` constants in
[src/config.js](./src/config.js). Never read from env, never
overridable — the hex is now part of the platform's identity.

**One-time migration is automated by the deploy workflow.**

[.github/workflows/deploy.yml](./.github/workflows/deploy.yml)
contains an idempotent migration block that runs on every deploy:

1. Skip if `app_usernode_2d5619` already exists and is healthy
   (sanity-checks `users` is non-empty).
2. Otherwise: stop the harness, `pg_dump usernode`, `createdb`
   the new DB, restore the dump with `ON_ERROR_STOP=1`, verify
   row counts match for `users` / `apps` / `chat_messages`, and
   then proceed to `docker compose up -d --build`. Any failure
   drops the partial target DB so the next attempt starts clean.

Code-side, only one place flips:

- [docker-compose.yml](./docker-compose.yml) — change
  `DATABASE_URL: postgres://usernode:${USERNODE_DB_PASSWORD}@usernode-db:5432/usernode`
  to `…/app_usernode_2d5619`.

`deploy.yml` doesn't write `DATABASE_URL` into the runtime `.env`;
the inline `environment:` block in `docker-compose.yml` is the
source of truth, with `${USERNODE_DB_PASSWORD}` substituted from
`.env`. The workflow change is the migration block, which becomes
a 1-line "already exists" no-op once the migration has run.

The bare `usernode` database **stays around** as the
postgres-bookkeeping target that
[src/services/db-manager.js](./src/services/db-manager.js)
`psql -d usernode` issues `CREATE DATABASE` from. Its purpose
is now genuinely just "the meta DB," not "the platform's data."

**Order of operations** (do once, off-hours):

1. Land the docker-compose + deploy.yml changes in `main`.
2. The deploy run executes the migration block. ~2–5 min of
   platform downtime during the dump/restore; child apps and the
   sidecar are unaffected.
3. Watch the deploy logs for `==> Migration complete; counts match`.
4. Verify `/health` and the app UI come up.
5. Leave the original `usernode` DB in place permanently — it's
   the meta-DB target `db-manager.js` connects to. (And during the
   first ~1 week it doubles as a rollback target — flip the
   `DATABASE_URL` back to `…/usernode` and redeploy.)

See [README.md](./README.md) §"Migrating the platform DB to its
app_-prefixed name (Phase 2d)" for the manual fallback runbook,
in case the auto-migration ever needs to be done by hand.

**Acceptance:** platform comes back, `\l` shows both `usernode`
and `app_usernode_2d5619` databases, and all app-creator /
votes / dev-chat flows still work.

**Risk:** moderate. This is the most invasive single step. A
botched dump/restore loses recent data. Mitigations: the auto-
migration aborts on any failure (drops the partial target DB so
the next attempt starts clean); the harness only restarts after
the row-count check passes; the original `usernode` DB stays
around as a rollback target; rehearse once against a local-dev
clone first by setting up `usernode` with sample data and
re-running the workflow's migration block by hand.

**Rollback:** flip `DATABASE_URL` back to `usernode`,
`docker compose up -d`. Any writes that landed in
`app_usernode_2d5619` after the cutover are not in the old DB
and would need re-replay — usually you'd just take the loss for
the cutover-to-rollback window.

### 2e. Add `dapp.json` at the repo root

Per [src/services/app-manifest.js](./src/services/app-manifest.js):

```json
{
  "secrets": [
    {
      "key": "GITHUB_APP_ID",
      "required": true,
      "description": "GitHub App ID for the bot account that owns app repos"
    },
    {
      "key": "GITHUB_PRIVATE_KEY",
      "required": true,
      "sensitive": true,
      "description": "PEM private key for the GitHub App"
    },
    {
      "key": "GITHUB_BOT_TOKEN",
      "required": true,
      "sensitive": true,
      "description": "Classic PAT for repo creation, branch pushes, PR creation"
    },
    {
      "key": "ANTHROPIC_API_KEY",
      "required": false,
      "sensitive": true,
      "description": "Platform-wide fallback Claude key; users can BYOK"
    },
    {
      "key": "ADMIN_USERNAME",
      "required": true,
      "description": "Bootstrap admin username"
    },
    {
      "key": "ADMIN_PASSWORD",
      "required": true,
      "sensitive": true,
      "description": "Bootstrap admin password"
    }
  ]
}
```

Note: `JWT_SECRET`, `DATABASE_URL`, `PORT`, `USERNODE_ENV` are
on the manifest's reserved list (see
[src/services/app-manifest.js#L41-L47](./src/services/app-manifest.js))
and don't go in here. `JWT_SECRET` is genuinely the platform's
own and not a manifest secret either way; it's set via the
deploy workflow.

**Acceptance:** the file parses through `appManifest.read()`,
all listed keys appear in the Settings → Secrets UI for the
self-app row once it exists.

### 2f. Boot-time seed for the self-app row

Add a function `seedSelfApp(pool, config)` invoked from
[server.js](./server.js) after `migrate()` (or wherever the
boot sequence lives). Idempotent:

```js
async function seedSelfApp(pool, config) {
  const { rows } = await pool.query(
    'SELECT id FROM apps WHERE self_hosted = TRUE LIMIT 1'
  );
  if (rows.length) return;
  await pool.query(`
    INSERT INTO apps
      (name, slug, repo_url, container_id, status, self_hosted,
       main_sha, last_deploy_at)
    VALUES
      ('Usernode', $1, $2, 'usernode', 'running', TRUE, $3, NOW())
  `, [
    config.selfAppSlug,         // 'usernode-2d5619'
    config.platformRepoUrl,     // USERNODE_PLATFORM_REPO
    process.env.GIT_SHA || null,
  ]);
}
```

`GIT_SHA` is already plumbed through the build via
[docker-compose.yml#L52-L53](./docker-compose.yml) (`args:
GIT_SHA: ${GIT_SHA:-dev}`). The boot seed reads it directly so
the self-app row's "live on" pill is correct from first boot.

The seed should also write into the manifest snapshot column
([src/db/schema.sql#L71](./src/db/schema.sql)
`manifest_snapshot`) by reading the local `dapp.json` from
`__dirname/..` — saves a clone-and-snapshot roundtrip the
self-app would never need.

**Acceptance:** fresh DB, server boots, `apps` table has
exactly one row with `self_hosted = TRUE`,
`container_id = 'usernode'`, `status = 'running'`, and a
non-null `main_sha` matching the build's `GIT_SHA`.

### 2g. Container-ownership guards (the only genuine special cases)

Two `if (app.self_hosted)` guards. Total ~10 lines.

**Guard A** — top of
[src/services/app-creator.js](./src/services/app-creator.js)
`createApp`:

```js
async function createApp(config, appRow) {
  if (appRow.self_hosted) {
    log.info('app-creator', 'Skipping create for self-hosted app',
             { appId: appRow.id, slug: appRow.slug });
    return;
  }
  // …existing body
}
```

**Guard B** — in
[src/routes/votes.js#L290-L327](./src/routes/votes.js)' merge
handler, wrap the `rebuildProduction` block:

```js
if (!app.self_hosted) {
  const { containerId, sha } = await staging.rebuildProduction(
    config, app
  );
  // …existing UPDATE apps SET container_id, main_sha, …
} else {
  log.info('votes', 'Self-app PR merged; auto-deploy will roll',
           { appId: app.id, prNumber: session.pr_number });
  // app.main_sha is updated post-deploy by the seed re-running
  // on next boot. Or, if you want it sooner: leave the existing
  // app_version_changed broadcast firing; clients call
  // /api/version which re-derives from GIT_SHA on next boot.
}
```

The `app_version_changed` broadcast at
[votes.js#L320-L325](./src/routes/votes.js) keeps firing in
both branches; that's the hook the banner in Phase 3 reads.

**Acceptance:**

- Calling `createApp(config, selfAppRow)` is a no-op log line.
- A merged PR against the self-app does not call
  `staging.rebuildProduction`.
- A merged PR against any normal app behaves identically to
  before.

### 2h. Self-app secrets UI: read-only

Per
[the assessment](.cursor/plans/self-hosting_assessment_c649755e.plan.md):
saving a new value via the Settings → Secrets UI for the
self-app row would persist into `app_secrets` (encrypted with
`JWT_SECRET`), but the platform's own process env is loaded from
`.env` written by GitHub Actions — it doesn't read `app_secrets`.
A "Save" click would be a silent no-op.

Solution: in the secrets UI route (look in
[src/routes/admin.js](./src/routes/admin.js) or wherever the
`POST /api/apps/:slug/secrets` handler lives), branch on
`app.self_hosted` and return 403 with a body explaining
"Edit via GitHub Actions secrets — saving here would not be
effective for the platform itself." The client-side UI shows the
fields but disables the Save button with a tooltip pointing at
the GitHub Actions secrets page.

**Acceptance:** GETs return the manifest-merged view with
`hasValue` reflecting the GitHub-Actions-configured reality;
POST/PUT/DELETE return 403 with the explanatory message.

### 2i. Mayor refuse-list paragraph (self-app-only)

[src/services/prompts.js](./src/services/prompts.js) is where
Mayor's system prompt is assembled. When the chat session's app
has `self_hosted = TRUE`, append a paragraph (after the existing
`getAppConventions()` block):

> **You are editing the Usernode platform itself.** Refuse to
> propose edits to any of the following without an explicit
> `allow_risky: true` confirmation from the user in the same
> message: `server.js` bootstrap path; `src/middleware/auth.js`;
> any code that reads or writes `JWT_SECRET` or anything in
> `src/services/secrets.js`; `src/db/migrate.js` for anything
> beyond append-only DDL; files configuring
> `/var/run/docker.sock` mounting; `docker-compose.yml`;
> `.github/workflows/deploy.yml`. If the user asks you to touch
> these, surface the risk first and require explicit
> confirmation; do not silently include such edits in a broader
> change.

The list combines the doc's globs plus two added by the
assessment: `docker-compose.yml` (sidecar-volume hazard) and
`.github/workflows/deploy.yml` (`JWT_SECRET` rotation hazard).

**Acceptance:** dev-chat against the self-app, with Mayor asked
to "edit `JWT_SECRET` to a new value," produces a refusal +
explanation; with `allow_risky: true`, produces the proposed
change. Other apps' Mayor planning is unchanged.

### 2j. Admin-only filter on `/api/apps`

Filter the listing in
[src/routes/apps.js](./src/routes/apps.js) so non-admins don't
see the self-app row:

```js
const { rows } = await pool.query(`
  SELECT * FROM apps
   WHERE NOT self_hosted OR $1::boolean
   ORDER BY …
`, [!!req.user?.isAdmin]);
```

Same filter applies to the `GET /api/apps/:slug` handler:
return 404 for non-admins requesting the self-app slug.

**Acceptance:** non-admin users see no `self_hosted` rows in
the home screen or via direct slug access; admins see them.

### 2k. Block self-repo URL in the import flow

[src/routes/apps.js#L206-L228](./src/routes/apps.js) — in the
`POST /api/apps` pre-flight, after parsing the URL, refuse if it
points at `USERNODE_PLATFORM_REPO`:

```js
if (repoUrlNormalized &&
    repoUrlNormalized.toLowerCase() ===
    config.platformRepoUrl.toLowerCase()) {
  return res.status(409).json({
    error: 'This is the platform repo. The self-app already exists; ' +
           'importing it as a child would create a sibling instance.'
  });
}
```

Same guard on the `verify-access` route at
[apps.js#L191-L204](./src/routes/apps.js), so the modal's
"Check" button surfaces the error before submit.

**Acceptance:** pasting `Usernode-Labs/social-vibecoding` (any
case) into the import modal produces the explanatory error in
both the Check and Submit paths.

## Phase 3 — Platform-updating banner (optional; observe first)

After Phase 2 lands and one or two real self-app deploys have
happened, decide whether the no-banner UX is actually painful.
Probably is. If yes:

**Goal:** clients display "Platform updating…" during a
self-app rolling restart instead of seeing dropped WebSockets and
a blank screen.

**Wrinkle:** during a self-app rolling restart, the WebSocket
*itself* drops because the server is restarting. The post-merge
`app_version_changed` may never reach the original tab — the new
server raises it but the tab has reconnected past it.

**Implementation:** client persists "expecting platform restart"
in `sessionStorage` when it sees the *pre-merge*
`vote_update { merging: true }` event ([votes.js#L286](./src/routes/votes.js))
for the self-app. Drops the banner only after `/api/version`
returns a different SHA than it last saw.

`/api/version` already exists (see
[src/services/app-version.js](./src/services/app-version.js))
and reads from `apps.main_sha`. The seed in 2f keeps that in
sync with the running build.

**Acceptance:** during a self-app deploy, all open tabs render
a banner from the moment the merge completes through the moment
`/api/version` reports the new SHA, with input fields disabled
in between.

**Cost:** ~50 lines client-side, no server changes.

## Phase 4 — In-app vote-to-merge for the self-app (deferred)

Out of scope for shadow-mode MVP. Today, admin manually merges
the self-app PR on GitHub.

When ready: lift the admin-merge requirement, allow the existing
PR voting UI on the self-app row. This requires a real
permission model (the SELF-HOSTING.md doc's "open-source-by-
live-dev-chat (future)" gate). Defer until shadow mode has run
for a few weeks without incident.

## Sequencing summary

```mermaid
flowchart LR
    P0[Phase 0: staging:private<br/>enforcement]
    P1[Phase 1: rollback.sh<br/>+ rehearsal]
    P2a[2a: self_hosted column]
    P2b[2b: USERNODE_PLATFORM_REPO]
    P2c[2c: schema comments]
    P2d[2d: DB rename]
    P2e[2e: dapp.json]
    P2f[2f: boot-time seed]
    P2g[2g: ownership guards]
    P2h[2h: secrets UI read-only]
    P2i[2i: Mayor refuse-list]
    P2j[2j: admin-only filter]
    P2k[2k: import-flow guard]
    P3[Phase 3: banner<br/>if needed]
    P4[Phase 4: in-app merge<br/>deferred]

    P0 --> P2c
    P1 --> P2f
    P2a --> P2c
    P2a --> P2f
    P2b --> P2f
    P2b --> P2k
    P2c --> P2d
    P2d --> P2f
    P2e --> P2f
    P2f --> P2g
    P2f --> P2h
    P2f --> P2i
    P2f --> P2j
    P2f --> P2k
    P2g --> P3
    P3 --> P4
```

Phase 0 and Phase 1 are independent and can land in either order.
Both must precede Phase 2. Within Phase 2, sub-steps land in the
order listed (each is a small commit). Phase 3 ships only after
observation; Phase 4 is deferred indefinitely.

## Risks and mitigations

| Risk | Phase | Mitigation |
|------|-------|------------|
| Botched DB rename loses data | 2d | Keep original `usernode` DB for ~1 week; rehearse on local-dev first. |
| Phase 0 TRUNCATE kills production data accidentally | 0 | TRUNCATE runs on the cloned DB only, never on the source; staging.js call site is the only invocation. |
| Self-app PR breaks prompts.js, removing the refuse-list | 2i | rollback.sh restores the previous SHA. The refuse-list is built into the prompt at runtime, so it can't fail-open silently — a bug that breaks prompts.js takes the whole platform down loudly. |
| `JWT_SECRET` rotation via deploy.yml edit | 2i | Refuse-list explicitly covers `.github/workflows/deploy.yml`. |
| Sidecar `usernode-node` archive cache lost in rolling restart | 2i | Refuse-list covers `docker-compose.yml`; archive volume is named and persistent so even an accidental recreate-recovers ([docker-compose.yml#L153-L166](./docker-compose.yml)). |
| Admin accidentally merges a hostile self-app PR | All | Manual review in shadow mode; rollback.sh as backstop. |

## Open questions

- **Who's an "admin" for self-app dev-chat?** `users.is_admin`
  exists; the bar is "set by the bootstrap admin user." Fine for
  shadow mode (1–2 people) but the doc's "open-source-by-live-
  dev-chat (future)" gate needs a real permission model before
  Phase 4.
- **Self-app slug in URLs.** `usernode-2d5619` is the frozen
  pick, and it'll appear in URLs as `usernode-2d5619--<user>--<sha>.<USERNODE_DOMAIN>`
  if/when staging is enabled. Mildly ugly. Acceptable.
- **`main_sha` updates on self-app deploy.** The seed reads
  `GIT_SHA` at boot. After a self-app PR merges and the workflow
  rolls the harness, the new container's seed runs again and
  updates `main_sha`. Between merge and successful boot, the row
  shows the old SHA — that's fine; the banner in Phase 3 is what
  surfaces the in-flight state.
- **Should `app_secrets` for the self-app row be hidden entirely,
  or just read-only?** The plan above goes with read-only (so
  admins can audit what the platform is configured with). If
  audit visibility is undesired, hide them entirely with another
  branch on `app.self_hosted`.

## Cross-references

- [SELF-HOSTING.md](./SELF-HOSTING.md) — original design notes;
  this plan supersedes its "MVP scope" section while keeping the
  staging-mode matrix and safety-rails sections intact for when
  Phase 4 lands.
- [EXTRACT-PLAN.md](./EXTRACT-PLAN.md) — the standalone-deploy
  prerequisite, now done.
- [src/prompts/app-conventions.md](./src/prompts/app-conventions.md)
  — defines `staging:private` and `dapp.json`; Phase 0 and 2c/2e
  bring the platform into compliance with rules it already
  prescribes for child apps.
