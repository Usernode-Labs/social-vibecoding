# Usernode Social Vibecoding

> where the users are the developers are the users are the developers...

A social platform where every signed-in user can propose changes to
any app — and to the platform itself — through a chat-driven
Mayor / Claude Code pipeline that produces real PRs.

## Design docs

- **[SPEC.md](./SPEC.md)** — overall architecture, auth model, app
  layout, URL conventions.
- **[EXTRACT-PLAN.md](./EXTRACT-PLAN.md)** — phased plan for moving
  this repo from a monorepo subdirectory to a standalone deploy.
- **[SELF-HOSTING.md](./SELF-HOSTING.md)** — operational reference
  for the shipped self-app: DB rename runbook, rollback procedure,
  flag-flip recipes, why each phase exists. The phase numbers here
  are cited from comments throughout the codebase.
- **[src/prompts/app-conventions.md](./src/prompts/app-conventions.md)**
  — authoritative platform conventions injected into Mayor and
  Claude Code prompts. Also served live at `/claude.md` on every
  running instance (see `server.js`).

## Deployment paths

This code ships in two shapes:

1. **Standalone** (this repo's `docker-compose.yml` + GitHub Actions
   workflow) — a self-contained three-service stack (Caddy + usernode
   + Postgres) that runs on a dedicated VPS. This is the intended
   long-term home and the target of Phase 3 of `EXTRACT-PLAN.md`.
2. **Legacy, in the `evanshapi.ro` monorepo** — consumed as a git
   submodule by the `evanshapi.ro` orchestrator, which generates a
   combined compose file covering all its projects and a shared Caddy.
   Keeps running for backwards compatibility while the standalone
   deploy matures.

Both paths run the same image. The `USERNODE_DOMAIN` env var is what
keeps them straight — scaffolded-app URLs, Caddy vhosts, and the
`/claude.md` link in child-app CLAUDE files are all driven from it.

## Standalone deployment

### One-time server setup

On a fresh Ubuntu VPS (Hetzner, DigitalOcean, whatever), run
`scripts/server-bootstrap.sh` as root:

```bash
# Generate a dedicated SSH keypair for GitHub Actions first:
ssh-keygen -t ed25519 -f usernode-deploy -C 'actions@usernode' -N ''

# Then on the VPS, as root:
sudo DEPLOY_SSH_PUBLIC_KEY="$(cat usernode-deploy.pub)" bash server-bootstrap.sh
```

This installs Docker, creates a `deploy` user, opens ports 22/80/443,
and authorizes the SSH key.

### DNS

Point two A records at the VPS IP:

- `<USERNODE_DOMAIN>` — the apex
- `*.<USERNODE_DOMAIN>` — wildcard, for per-app subdomains
  (`myapp.<USERNODE_DOMAIN>` + staging URLs)

Caddy will auto-issue Let's Encrypt certs on first request for each
hostname — no cert provisioning needed from you.

### GitHub secrets & variables

In the repo's Settings → Secrets and variables → Actions:

**Secrets:**
- `DEPLOY_HOST` — VPS IP or hostname
- `DEPLOY_SSH_KEY` — the *private* half of the keypair above
- `USERNODE_ADMIN_USERNAME`, `USERNODE_ADMIN_PASSWORD`
- `USERNODE_SESSION_SECRET`, `USERNODE_JWT_SECRET`
- `USERNODE_DB_PASSWORD`
- `USERNODE_GITHUB_APP_ID`, `USERNODE_GITHUB_PRIVATE_KEY`
  (single line with literal `\n`), `USERNODE_GITHUB_BOT_TOKEN`
- `USERNODE_ANTHROPIC_API_KEY` (optional — BYOK covers the rest)

**Variables:**
- `USERNODE_DOMAIN` — the domain DNS now points at

### First deploy

Actions tab → **Deploy** → Run workflow. The workflow rsyncs code to
`/opt/usernode` on the VPS, writes `.env` from the secrets above, and
runs `docker compose up -d --build`. Caddy auto-issues TLS on the
first HTTPS request.

Once the first run is green end-to-end, uncomment the `push`-on-main
trigger in `.github/workflows/deploy.yml` to enable auto-deploy.

### Recovery (rollback to a known-good SHA)

If a deploy lands a broken commit and the platform UI is down or
misbehaving, the kill-switch is `/opt/usernode-tools/rollback.sh`
on the VPS. It deliberately lives outside `/opt/usernode/` so a
broken deploy can't clobber it, and it re-clones the repo from
GitHub at the target SHA — so it works even when local state is
corrupted.

Find a known-good SHA at
`https://github.com/Usernode-Labs/social-vibecoding/commits/main`,
then SSH in and run:

```bash
ssh deploy@<DEPLOY_HOST>
# Optional sanity checks first:
grep ^GIT_SHA= /opt/usernode/.env       # what's running now
docker logs usernode --tail 50          # what's broken

/opt/usernode-tools/rollback.sh <sha>
```

The script clones the target SHA into `/tmp`, rsyncs over
`/opt/usernode/` (preserving `.env`, `runtime/`, `data/`), updates
`GIT_SHA` in `.env`, and runs `docker compose up -d --build`.
Named volumes (Postgres data, Caddy state, sidecar archive)
persist across rollback.

The script is auto-deployed by the Deploy workflow — every deploy
copies the latest version of `scripts/rollback.sh` into
`/opt/usernode-tools/`. So the script itself stays current with
the repo, but the directory it lives in survives `rsync --delete`.

**Rehearse it once before you need it.** Push a no-op commit (a
README typo fix is fine), wait for the deploy to finish, then run
`rollback.sh <prev_sha>` — confirm the harness comes back on the
previous SHA, the version pill in the UI shows it, and child apps
are unaffected. Schema migrations are forward-only, so don't
rehearse across a migration boundary.

### Migrating the platform DB to its `app_`-prefixed name (Phase 2d)

The platform's data lives in `app_usernode_2d5619` (per the
`app_<slug>` convention every child app follows). The Deploy
workflow handles the one-time rename automatically — the first
push that lands the `DATABASE_URL` change in `docker-compose.yml`
triggers an idempotent migration block in `.github/workflows/deploy.yml`
that:

1. Skips if `app_usernode_2d5619` already exists and is healthy
   (sanity-checks `users` is non-empty).
2. Otherwise stops the harness, `pg_dump`s `usernode`, creates
   `app_usernode_2d5619`, restores the dump, and verifies row
   counts match. Any failure drops the partial target DB and aborts.
3. Brings everything back up pointed at the new DB.

Maintenance window is ~2–5 min of platform downtime, exactly the
duration of the dump-and-restore. Child apps and the sidecar stay
up — `docker compose stop usernode` only stops the harness
service. Watch the deploy run logs; the migration block is clearly
labeled (`==> One-time migration: usernode -> app_usernode_2d5619`).

**Post-cutover:** the original `usernode` database stays in place
as a rollback target *and* as the bookkeeping DB `db-manager.js`
connects to when issuing `CREATE DATABASE` for new child apps —
do not drop it. (Postgres requires connecting to *some* database
to spawn another one; `usernode` is that meta-DB.) Rolling back
during the confidence window means flipping
`docker-compose.yml`'s `DATABASE_URL` back to `…/usernode` and
redeploying.

#### Manual fallback (only if the auto-migration is unable to run)

If you need to run the migration by hand (e.g. the auto-migration
hit a corner case and you want to do the steps yourself, or the
deploy workflow itself is down), here's the equivalent runbook:

```bash
ssh deploy@<DEPLOY_HOST>
cd /opt/usernode

# Pre-flight: note current counts.
docker exec usernode-db psql -U usernode -d usernode -c \
  "SELECT count(*) AS users FROM users; \
   SELECT count(*) AS apps  FROM apps;  \
   SELECT count(*) AS chat_messages FROM chat_messages;"

# Stop the harness; postgres/sidecar/caddy stay up.
docker compose stop usernode

# Dump → create → restore.
TS=$(date -u +%Y%m%dT%H%M%SZ)
docker exec -i usernode-db pg_dump -U usernode usernode \
  > /tmp/usernode-pre-rename-$TS.sql
docker exec -u postgres usernode-db createdb \
  -U usernode -O usernode app_usernode_2d5619
docker exec -i usernode-db psql -U usernode -d app_usernode_2d5619 \
  -v ON_ERROR_STOP=1 < /tmp/usernode-pre-rename-$TS.sql

# Verify counts match exactly.
docker exec usernode-db psql -U usernode -d app_usernode_2d5619 -c \
  "SELECT count(*) AS users FROM users; \
   SELECT count(*) AS apps  FROM apps;  \
   SELECT count(*) AS chat_messages FROM chat_messages;"

# Bring everything back up against the new DB.
docker compose up -d --build
```

If the restore fails partway through, drop the partial DB and
retry: `docker exec -u postgres usernode-db dropdb -U usernode app_usernode_2d5619`.

## Running locally

Fill in `.env.example` → `.env`, set `USERNODE_LOCAL_DEV=1` in your
local `.env` (so app/staging URLs fall back to `http://localhost:<port>`
since Caddy can't issue real certs against `localhost`).

The local stack is two pieces because Docker Desktop on Mac can't run
the `usernode-node` sidecar (its WebRTC P2P doesn't survive the VM's
network stack), so the node runs natively on the host and the platform
container talks to it via `host.docker.internal:3001`.

Prereq: `make node-full` fetches a fresh archive snapshot via SSH from
`testnet-seed1` so the node boots in full-ledger mode (without it,
runtime `tracked_owner/add` calls trip the wallet-seed shortcut into
partial-overlay mode and the platform's `/__node-status` panel shows
the "Partial ledger mode" warning — see
`PARTIAL_LEDGER_RECENT_TX_SOURCE_BUG`). Add a `~/.ssh/config` entry for
`testnet-seed1` with the right `IdentityFile` (the same one used by
`usernode-dapp-starter`'s `make node-full`).

Two terminals:

```bash
# Terminal 1 — native node on :3001 (one-time:
#   cd ../usernode && cargo build --release -p usernode-cli)
make node-full              # fetch fresh archive, then boot in full mode
# make node-full-no-fetch   # offline iteration: reuse ~/.usernode/archive

# Terminal 2 — platform + Postgres
make up           # docker compose -f docker-compose.dev.yml up -d --build
make logs         # tail
make down         # stop
```

Then visit `http://localhost:3000`.

A few things won't work locally:

- **GitHub App actions** (creating branches/PRs for user edits) need a
  real App installed against a real org — no great way to fake it
  for local-dev yet. The import-existing flow specifically needs
  `GITHUB_BOT_TOKEN` set in `.env` to do anything more than return
  the `no_token` error.
- **Let's Encrypt TLS** — Caddy can't issue certs against `localhost`;
  expect self-signed / browser warnings.
- **Wildcard DNS** — child-app subdomains won't resolve against
  localhost; you can add entries to `/etc/hosts` for any specific
  slugs you're testing.

For early platform-internal work (group chat, dev-chat, settings,
notifications, etc.) none of that matters; the stack comes up fine.

## Status

Active development. See `TODO` for the current short-list.

<!-- touch: no-op commit to nudge branch state -->
