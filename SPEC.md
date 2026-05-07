---
name: Usernode Social Vibecoding
subtitle: "where the users are the developers are the users are the developers..."
---

# Usernode Social Vibecoding

> where the users are the developers are the users are the developers...

## Auth

- Access-code-gated registration (same model as recipe-bot)
- Every registered user is a member of every app — there are no per-app groups

## Architecture

- **Platform**: single Node.js/Express app that orchestrates everything, deployed on the same Hetzner box as other projects
- **Child apps**: each app is an isolated Docker container on the same box
- **Database**: shared Postgres instance with per-app databases (e.g. `app_myapp`, `app_myapp_staging_alice_abc123`); staging versions get a `pg_dump`/`pg_restore` copy
- Apps are rendered inside **iframes** within the platform UI — the platform passes auth context to child apps via a **signed JWT** in the iframe `src` query param, so the child app knows which user is interacting. All child apps share the same JWT signing secret (set once in the template).
- Every app is a Node.js/Express server with HTML/JS/Tailwind CDN frontend, backed by Postgres (stripped-down recipe-bot pattern) — apps can have multiple JS files, server routes, etc.

### URLs

- Production apps: `appname.<USERNODE_DOMAIN>`
- Staging: `appname--username--abc123.<USERNODE_DOMAIN>` (first 6 chars of commit hash)

where `USERNODE_DOMAIN` is the hostname this instance is deployed at
(set via env var; see `.env.example` and README). Wildcard DNS for
`*.<USERNODE_DOMAIN>` is required so Caddy can issue per-app certs.

### Container Limits

- Each user can have up to **3 staging containers** at a time (across all apps)
- Global max: **25 staging containers** across all users
- Child app containers run with **Docker resource limits** (`--memory`, `--cpus`) to prevent any single app from starving the box

## Home Screen

- Lists all apps, sorted by **activity** (chat messages + time users spend in the app)
- Time-in-app tracked by the platform via iframe focus/visibility events reported back through `postMessage`
- **+** button in the top right to create a new app
- Apps are **permanent** — no shutdown/archive mechanism for now

## App View

When you tap into an app, you see 3 tabs along the bottom:

1. **App** — the live app itself, rendered in an iframe
2. **Group Chat** — real-time WebSocket group chat
3. **Individual Chat** — private AI-assisted chat for making changes

## Creating an App

- User provides a **name**, that's it — the app is immediately communal
- A **GitHub bot account** (we create this) creates a new **public repo** under the bot's account (e.g. `github.com/usernode-bot/my-app`)
- The repo is auto-populated from a template (see below) and wired with secrets for auto-deploy
- App creation is **async** — the home screen shows a "spinning up..." state while the repo and container are being set up

### Default Template

The template is a stripped-down recipe-bot: Node.js/Express + single HTML page + Postgres pool + health check + auto-deploy script. Auth-aware out of the box — the template includes JWT verification middleware so the app knows the current user from the platform. The default app is:

- A screen with a **button**
- A **leaderboard** showing which users have pushed the button the most (by username)

## Group Chat

- **One group chat per app**, real-time via **WebSockets**, messages **persisted to the platform DB** and loaded on reconnect
- At the top of the chat view: a panel showing all **current issues** and **staged PRs**, with inline vote buttons
- When you cast a vote, it shows up as a message in the main chat stream (e.g. "Alice voted yes on PR #3")

## Making Changes (Individual Chat)

1. Click **+** to start a new session — this creates a new **branch + PR** on the backend
2. Chat with an **LLM** (user chooses the model) to make changes to the app — the AI has access to the full repo contents and the conversation history from the current session. It can also see open GitHub Issues if the user asks about them.
3. Claude produces commit messages for each change; the platform commits and pushes to the PR branch
4. Each push to the PR branch builds and deploys a **staging container** (with a copy of the production DB)
5. The user previews their staging version via an **iframe swap** in the App tab
6. You can **promote** your staged PR — this marks the GitHub PR as "ready for review" and presents it to the group for voting in the Group Chat
7. PRs *are* staging versions — the staging container lives as long as the PR is open
8. When the PR merges, the staging container is **torn down** and the session is **archived** (read-only chat history)
9. A user can have **multiple open sessions** for the same app (up to their 3-container limit) and can return to any open session to keep iterating

## Issues & Voting

1. Anyone can **suggest issues** or **vote** on existing ones — each is reflected as a **GitHub Issue** on the repo
2. Anyone can **vote to merge** a promoted PR
3. **Merge threshold**: majority of **active users**. A user becomes _qualified_ once they've spent at least 1 minute on the App tab on a single day (sticky — once earned, stays earned). They're then counted as _active_ as long as they have at least one visit (any duration) within the last 10 days; 10 days with no visits drops them out of the count, but a return visit re-counts them. See `src/services/active-users.js` for the canonical query.
4. When the vote passes, the PR is merged into main and **auto-deployed** (deploy script runs migrations on startup)
5. Anyone can **propose a rename** (display name only; slug/container/URLs unchanged) from the group-chat panel; it behaves as a structured issue (`kind = 'rename'`). When a majority of active users up-vote it, the rename applies atomically and the new name is broadcast to all clients via a WebSocket `app_update` event.

### Merge Conflicts

- Merges are **first-past-the-post**: if two PRs conflict and both pass their vote, whichever passes first gets merged
- The second PR now has a merge conflict — the **bot uses Claude** to understand and resolve the conflict, pushing a fix commit to the PR branch
- Since the bot's only instruction is to fix the conflict (not change behavior), **no new vote is needed** for the conflict-resolution commit
- The conflicted PR's staging container rebuilds with the fix

## GitHub Bot Account

- Dedicated GitHub user account (e.g. `usernode-bot`) that owns all app repos
- A **GitHub App** ("Usernode Vibecoding") registered under the bot account, with permissions: repo admin, contents, issues, pull requests, secrets (all read/write), metadata (read)
- The App is installed on the bot account; the platform uses `@octokit/app` to get auto-rotating installation tokens
- Setup: create bot account, register GitHub App, generate private key (PEM), install App, store `GITHUB_APP_ID` + `GITHUB_PRIVATE_KEY` as platform secrets

## LLM Usage & Rate Limits

- User **chooses the model** (Claude, etc.) in the Individual Chat
- **$25/day per user** free allowance
- **$200/day global** platform cap
- The platform tracks token usage and costs per user per day; requests are rejected when either limit is hit

## Networking

- Wildcard DNS: `*.usernode` A record in Hetzner DNS → VPS IP
- **Caddy on-demand TLS**: certs are fetched automatically on first request to each new hostname (~2s delay on first hit); no wildcard cert or custom Caddy build needed
- Caddy reverse proxy routes requests to the appropriate container based on subdomain
- Dynamic route registration: platform writes to a Caddy config file and triggers reload (same pattern as pr-bot's `staging.conf`)

---

## Deploy Checklist

> **Two deploy paths.** The steps below describe the *original*
> `evanshapi.ro`-monorepo deploy, where Usernode is one of several
> projects orchestrated by a shared `orchestrate.sh` + shared Caddy.
> For the **standalone** deploy (dedicated VPS, self-contained
> `docker-compose.yml`, the long-term home) see
> [`README.md` → Standalone deployment](./README.md#standalone-deployment).
> Most of sections 2–6 below (GitHub App registration, activation
> codes, verification smoke test) apply to both paths.

### 1. DNS (either path)

Point an A record for `<USERNODE_DOMAIN>` and a wildcard A record for
`*.<USERNODE_DOMAIN>` at the VPS IP. For the monorepo path that's
`usernode` and `*.usernode` under `evanshapiro.dev` in [Hetzner
DNS](https://dns.hetzner.com); for standalone it's whatever domain
you've picked. Allow up to 10 minutes for propagation.

### 2. GitHub Bot Account

1. Create a new GitHub account (e.g. `usernode-bot`) with a dedicated email
2. Log in as the bot account

### 3. GitHub App Registration

From the bot account:

1. Go to **Settings > Developer settings > GitHub Apps > New GitHub App**
2. **Name**: `Usernode Vibecoding`
3. **Homepage URL**: `https://usernode.evanshapiro.dev`
4. **Webhook**: uncheck "Active" (we don't need webhooks yet)
5. **Permissions**:
   - Repository:
     - Administration: Read & Write
     - Contents: Read & Write
     - Issues: Read & Write
     - Pull requests: Read & Write
     - Metadata: Read-only
6. **Where can this GitHub App be installed?**: "Only on this account"
7. Click **Create GitHub App** — note the **App ID**
8. Scroll down to **Private keys** > **Generate a private key** — downloads a `.pem` file
9. Go to **Install App** (left sidebar) > **Install** on the bot account
10. Grant access to **All repositories**

### 4. GitHub Secrets

Add these secrets to the `evanshapi.ro` GitHub repo (**Settings > Secrets and variables > Actions > New repository secret**):

| Secret | Value |
|--------|-------|
| `USERNODE_DB_PASSWORD` | Generate: `openssl rand -hex 32` |
| `USERNODE_SESSION_SECRET` | Generate: `openssl rand -hex 32` |
| `USERNODE_JWT_SECRET` | Generate: `openssl rand -hex 32` |
| `USERNODE_ADMIN_USERNAME` | `admin` |
| `USERNODE_ADMIN_PASSWORD` | (choose a strong password) |
| `USERNODE_GITHUB_APP_ID` | (from step 3.7) |
| `USERNODE_GITHUB_PRIVATE_KEY` | Contents of the `.pem` file (replace newlines with `\n`) |
| `USERNODE_GITHUB_BOT_TOKEN` | Classic PAT on the bot account with `repo` + `workflow` scopes. Required for repo creation, branch pushes, PR creation, and session recovery (the GitHub App alone can't do these on user accounts). |
| `USERNODE_ANTHROPIC_API_KEY` | Your Anthropic API key |

### 5. Deploy Workflow

Add the `.env` write block to `.github/workflows/deploy.yml` in the SSH step that writes env files. Add after the existing project env blocks:

```bash
cat > /opt/infra/repo/projects/usernode-social-vibecoding/.env << 'ENVEOF'
ADMIN_USERNAME=${{ secrets.USERNODE_ADMIN_USERNAME }}
ADMIN_PASSWORD=${{ secrets.USERNODE_ADMIN_PASSWORD }}
SESSION_SECRET=${{ secrets.USERNODE_SESSION_SECRET }}
JWT_SECRET=${{ secrets.USERNODE_JWT_SECRET }}
DATABASE_URL=postgres://usernode:${{ secrets.USERNODE_DB_PASSWORD }}@project-usernode-db:5432/usernode
USERNODE_DB_PASSWORD=${{ secrets.USERNODE_DB_PASSWORD }}
GITHUB_APP_ID=${{ secrets.USERNODE_GITHUB_APP_ID }}
GITHUB_PRIVATE_KEY=${{ secrets.USERNODE_GITHUB_PRIVATE_KEY }}
GITHUB_BOT_TOKEN=${{ secrets.USERNODE_GITHUB_BOT_TOKEN }}
ANTHROPIC_API_KEY=${{ secrets.USERNODE_ANTHROPIC_API_KEY }}
LOG_LEVEL=INFO
ENVEOF
```

### 6. Create Activation Codes

After the first deploy, SSH into the server and create activation codes for your users:

```bash
docker exec project-usernode-db psql -U usernode -d usernode -c \
  "INSERT INTO activation_codes (code) VALUES ('your-code-here');"
```

### 7. Verify

1. Push to `main` — CI will run `orchestrate.sh` which picks up the new project
2. Visit `https://usernode.evanshapiro.dev` — should show the login page
3. Register with an activation code
4. Create an app — should show "Spinning up..." then transition to "running"
5. Click into the app — should see the button + leaderboard in the iframe
6. Switch to Group Chat — should connect via WebSocket
7. Switch to Dev Chat — should be able to create a session and chat with Claude

### Post-Deploy Notes

- **First app creation** will be slow (~2-3 min) as it clones, builds, and deploys for the first time
- **Caddy on-demand TLS** means the first visit to any new `*.usernode.evanshapiro.dev` hostname has a ~2s delay while the cert is provisioned
- Monitor Docker memory usage: `docker stats` — the 16GB box can handle roughly 10 production apps + 25 staging containers at 256MB each
- **Activation codes** are single-use — create as many as you need
- Check logs: `docker logs project-usernode -f`
