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
- **[SELF-HOSTING.md](./SELF-HOSTING.md)** — design for registering
  Usernode as an app inside itself, including the staging /
  Docker-isolation model.
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

## Running locally

Fill in `.env.example` → `.env`, set `USERNODE_LOCAL_DEV=1` in your
local `.env` (so app/staging URLs fall back to `http://localhost:<port>`
since Caddy can't issue real certs against `localhost`), then:

```bash
docker compose up -d --build
```

A few things won't work locally:

- **GitHub App actions** (creating branches/PRs for user edits) need a
  real App installed against a real org — no great way to fake it
  for local-dev yet.
- **Let's Encrypt TLS** — Caddy can't issue certs against `localhost`;
  expect self-signed / browser warnings.
- **Wildcard DNS** — child-app subdomains won't resolve against
  localhost; you can add entries to `/etc/hosts` for any specific
  slugs you're testing.

For early platform-internal work (group chat, dev-chat, settings,
notifications, etc.) none of that matters; the stack comes up fine.

## Status

Active development. See `TODO` for the current short-list.
