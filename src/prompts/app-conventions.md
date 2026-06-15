# Usernode platform conventions

This file is the authoritative spec for how apps on Usernode Social
Vibecoding work. It is injected into every Mayor and Claude Code
system prompt so both follow the same conventions when planning
features, generating code, or explaining things to the user.

When the Mayor / Claude Code is editing an app, it may also see a
`CLAUDE.md` at the root of the app's repo. That file contains
**app-specific** guidance that the owner has written. Rules of
precedence:

- **Platform conventions below are authoritative.** They describe the
  environment every app runs in and must not be overridden by a repo's
  `CLAUDE.md`.
- **Repo `CLAUDE.md` covers app-specific details**: product intent,
  domain terms, any opt-in policies (e.g. marking tables private),
  taste/style choices. Follow it for anything app-specific that this
  file doesn't dictate.
- If the two conflict on a platform matter, this file wins. If a repo
  `CLAUDE.md` contradicts a platform rule, note that to the user; do
  not silently follow the repo.

---

## Stack

Each app is a Node.js / Express server with an HTML + JS + Tailwind
frontend and its own PostgreSQL database. Containers are built from a
`Dockerfile` in the repo root and listen on port 3000.

Required env vars at runtime (provided by the harness):

- `DATABASE_URL` — Postgres connection string for this app's DB.
- `JWT_SECRET` — shared with the platform; used to verify iframe-issued
  session tokens.
- `PORT` — always `3000`.
- `USERNODE_ENV` — either `production` or `staging`. See "Staging vs
  production" below.

Apps that need additional env vars (third-party API keys, on-chain
addresses, etc.) declare them in `dapp.json` at the repo root —
see "Per-app secrets" below.

## Auth — iframe token injection

Apps run inside an iframe on the Usernode shell. The shell mints a
JWT for the logged-in Usernode user and injects it as a `?token=…`
query param on the initial iframe load. The app's own frontend
forwards that token on subsequent fetches via the
`x-usernode-token` request header.

Server-side the pattern (already present in the scaffold) is:

```js
const JWT_SECRET = process.env.JWT_SECRET;
const PUBLIC_API_PATHS = new Set(['/health']);
// Public path prefixes that bypass the JWT gate. `/explorer-api/*`
// is a transparent proxy to the public block explorer — gating it
// blocks the bridge's POST /<chain_id>/transactions polling from
// inside the iframe (which has no token to forward) and adds zero
// security since anyone can hit the upstream directly.
const PUBLIC_PREFIXES = ['/explorer-api/'];

app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});
```

Key properties:

- `req.user` contains at minimum `{ id, username, usernode_pubkey }` once authenticated.
  `usernode_pubkey` is the user's linked Usernode wallet address (`ut1...`) or `null` if not linked.
- All non-GET requests + all `/api/*` requests are **deny-by-default**.
- To intentionally expose an API route without auth, add its exact
  path to `PUBLIC_API_PATHS`. Do **not** remove the middleware.
- `/explorer-api/*` is intentionally public (see `PUBLIC_PREFIXES`).
  The bridge polls `POST /<chain_id>/transactions` after every send to
  wait for inclusion, and that request is issued from the iframe's JS
  with no platform token to forward.
- The HTML shell is also auth-gated so direct visits to the staging
  subdomain don't reveal the app.

When adding a new API route, assume `req.user` is present. If a brand
new endpoint **must** be public (e.g. a webhook), add its path to
`PUBLIC_API_PATHS` and mention this in the dev-chat reply.

## Database

- Each app gets its own Postgres DB. Schema is applied idempotently
  on boot — use `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD
  COLUMN IF NOT EXISTS` so repeated migrations are safe.
- Connect via a single `pg.Pool({ connectionString: process.env.DATABASE_URL })`.
- Record ownership with `user_id` / `username` from `req.user`.

## Staging vs production — `USERNODE_ENV`

Every PR spawns a fresh **staging** container at a unique subdomain.
When it merges, the branch is redeployed to the **production**
container.

Apps receive `USERNODE_ENV=staging` or `USERNODE_ENV=production`.
Use it to branch behavior where the environments must differ —
most commonly:

- Seeding fake data for tables whose content doesn't get copied into
  staging (see "Public vs private tables").
- Skipping side effects: don't send real emails, charge real cards,
  post to real webhooks, etc. while `USERNODE_ENV === 'staging'`.
- Displaying a "staging" indicator in the UI so testers know what
  they're looking at.

Canonical helper:

```js
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
```

## Staging mock data

Testing instructions for a staging preview are only useful if the data
they reference actually exists there. Staging starts from a copy of the
production database (see "Public vs private tables"), so three kinds of
data are MISSING and need seeding when a testing step depends on them:

1. **Tables newly created by this change** — they don't exist in prod
   yet, so the boot migration creates them empty in staging.
2. **`staging:private` tables** — copied schema-only, always empty.
3. **States hard to reach by clicking around** — a populated
   leaderboard, a multi-user interaction, a half-finished game.

Two sanctioned mechanisms, both guarded by the `IS_STAGING` helper
above:

- **Boot-time seed block**, run right after the idempotent migration:

  ```js
  if (IS_STAGING) {
    await pool.query(
      `INSERT INTO posts (id, username, title)
       VALUES (900001, 'staging-demo-user', 'Staging demo post #1')
       ON CONFLICT (id) DO NOTHING`
    );
  }
  ```

- **Request-time demo injection** behind
  `IS_STAGING && req.query.demo === '1'` — for read-only demo state
  that shouldn't persist in the DB. Point the testing block's `path:`
  at the `?demo=1` URL.

Seed rules:

- **Idempotent.** Staging containers rebuild on every push, so seeds
  re-run on each boot — use an existence check or
  `ON CONFLICT DO NOTHING`.
- **Obviously fake.** Give seeded rows a consistent "Staging demo …"
  prefix so they can't be mistaken for real user content.
- **Small.** A handful of rows — just enough for the testing steps.
- **Never reference real users.** Use fake usernames/IDs
  (e.g. `staging-demo-user`), never rows cloned from prod.
- **Strictly a no-op outside staging.** The whole block is gated on
  `USERNODE_ENV === 'staging'`; production data is never touched.

Tie-in with testing instructions: the testing steps you emit must
reference the seeded entities by name ("Open the thread 'Staging demo
thread' and …"), so a tester knows exactly what they should be seeing.

## Public vs private tables — **IMPORTANT**

Staging containers get a **copy of the production database** so PRs
can be tested against realistic data. This is safe for the vast
majority of tables — app state, counters, public posts, settings,
game scores, leaderboards, etc. — and is the default.

**Tables are PUBLIC by default.** A table is marked private only when
its rows contain content that another Usernode user must not see if
they open a staging preview of this app.

Mark a table private by adding a Postgres comment:

```sql
COMMENT ON TABLE direct_messages IS 'staging:private';
```

Private tables are copied **schema-only** to staging — structure
only, no rows. In staging, seed them yourself if you need test data:

```js
if (IS_STAGING) {
  await pool.query(`INSERT INTO direct_messages (sender_id, body) VALUES ($1, $2)`,
                   [1, 'Staging test message']);
}
```

### Decide by asking: "would a stranger seeing every row in this
table be a problem?"

Mark **private** when the table stores:

- Authentication material (password hashes, OAuth tokens, 2FA secrets).
- Direct messages, private chats, one-to-one content.
- Financial data (transactions, balances, card info).
- API keys or credentials the user entrusted the app with.
- Personal information beyond a public username (real names, emails,
  phone numbers, addresses, DOB).
- Anything the app's own UI gates behind "only the owner can see this".

Leave **public** (the default) for:

- App content that's already visible to other users in-app: posts,
  leaderboards, comments, public profiles, reactions.
- Configuration / state: feature flags, app-level counters, schemas.
- Reference data: categories, tags, lookup tables.
- Aggregates and analytics that don't reveal individual identity.

### Rules the migration linter enforces

- **A public table MUST NOT have a foreign key to a private table.**
  If you need this relation, either the parent is actually public
  (re-evaluate), or the child should be private too. This keeps
  staging DBs consistent (no dangling FKs).

### When the Mayor / Claude Code creates a new table

1. **Create it public by default** (no comment needed).
2. **Run the "would a stranger seeing every row be a problem?" test.**
3. If the answer is yes, add `COMMENT ON TABLE foo IS 'staging:private'`
   in the same migration, and generate an `IS_STAGING` seed block if
   the feature would otherwise break on an empty staging table.
4. Mention the choice briefly in the dev-chat reply so the user can
   correct it: "Marked `messages` private because it stores 1:1 chats —
   staging will have an empty table."

When the Mayor is planning a feature that clearly involves sensitive
data (DMs, accounts, payments), it should note out loud in its
plan that the relevant tables will be private and staging will seed
fake rows. This sets user expectations before CC runs.

## Per-app secrets — `dapp.json`

Apps that need env vars beyond the four platform-injected ones declare
them in a `dapp.json` manifest at the repo root. The
platform reads this file on every deploy (initial creation, staging
PR builds, production rebuilds) and:

- Injects stored values into the container's environment.
- **Blocks the deploy** if any `required: true` key has no stored
  value. New apps land in `awaiting_secrets` status; production
  rebuilds throw with a `missingSecrets` list and the version pill
  goes red until values are filled.
- Surfaces the manifest entries in the Secrets modal (header key icon
  in the app view) where admins set values directly and non-admins
  open a vote-based proposal.

Manifest shape:

```json
{
  "name": "My Cool App",
  "secrets": [
    {
      "key": "STRIPE_SECRET_KEY",
      "description": "Live Stripe secret for charging cards",
      "required": true,
      "private": true
    },
    {
      "key": "DEFAULT_LOCALE",
      "description": "Fallback locale when no Accept-Language header is set",
      "required": false,
      "default": "en-US"
    }
  ]
}
```

### Top-level `name` — the app's display name

`dapp.json` may carry an optional top-level `"name"` string (1–64
characters). It is the **source of truth for the app's display name**
and takes precedence over the platform-stored name. On every
production deploy the platform reads it and reconciles the app's
display name to it; when `name` is absent, the existing platform name
is left untouched (a clean no-op for legacy apps).

Because the name lives in the repo, **renaming an app is just a PR
that edits this field**. The platform's "Rename" button opens exactly
such a PR (creating `dapp.json` if the repo doesn't have one yet); the
rename takes effect when that PR is voted in, merged, and redeployed —
not before. Don't add code that mutates the display name through any
other channel; edit `dapp.json`'s `name` and let the deploy apply it.

### Top-level `visibility` — who can build / see & use the app

`dapp.json` may carry an optional top-level `visibility` block — the
**source of truth for the app's two visibility statuses**:

```json
{
  "visibility": {
    "build": "private",
    "view": "public"
  }
}
```

- `build` — who can participate in building the app (group chat, dev
  sessions, voting). `"public"` = anyone; `"private"` = invited
  collaborators only.
- `view` — who can see the app exists and use it (home list, the
  app's subdomain). `"public"` = anyone; `"private"` = collaborators
  only.

Rules, mirroring the top-level `name`:

- On every production deploy the platform reads the block and
  reconciles the app's stored statuses to it. An **absent block or
  absent key leaves the platform value untouched** — a clean no-op
  for apps that never declare it.
- Values other than `"public"` / `"private"` are ignored (treated as
  absent) with a warning.
- The combination `build: "public"` + `view: "private"` is invalid
  (an app anyone can build can't be hidden) — the platform skips the
  reconcile and keeps the current statuses.
- **Changing visibility is just a PR that edits this block.** The
  platform's Members & visibility panel opens exactly such a PR; the
  change takes effect when the PR is voted in, merged, and
  redeployed — not before. Don't mutate visibility through any other
  channel.
- Inviting individual users to a private app is a separate, in-app
  flow — it is NOT represented in `dapp.json`.

Per-field rules:

- `key` — `UPPER_SNAKE_CASE`. The literal name `process.env.<KEY>` will be.
- `description` — required for the UI. Be specific: name what the
  value is and where to obtain it.
- `required` — `true` if the app cannot run without it. Defaults to
  `false`. **Required-but-unset blocks deploys** — only mark a key
  required if that's truly the contract.
- `private` — `true` if the value must never be readable from any API
  *and* must not propagate from prod into staging. Stored AES-256-GCM
  at rest; the Secrets UI shows only "set" / "not set"; staging
  containers see only the manifest-committed `staging_default` /
  `default` fallback. Defaults to `false`. Mark API keys, signing
  keys, wallet seeds, OAuth client secrets, etc. as private; mark
  public addresses, URLs, feature flags as non-private. See "Public
  vs private secrets" below for the full decision tree.
- `sensitive` — **deprecated alias for `private`.** Existing
  `dapp.json` files using `sensitive: true` keep working unchanged —
  the platform reads either field and treats them as the same flag.
  New manifests should write `private: true` instead.
- `default` — applied at deploy time if no stored value exists (only
  meaningful when `required: false`). Use sparingly — it's documented
  as "the platform's default", not "this dapp's default". For
  platform-managed keys (see below) the manifest default is a
  fallback for *standalone* deploys; in-platform deploys use the
  platform's own env value instead.
- `staging_default` — manifest-committed value used in staging for
  `private: true` entries (see "Public vs private secrets"
  below). Wins over `default` in staging. If both are unset and the
  entry is `required + private`, the staging build fails with a
  clear error pointing at the remediation.

**Reserved keys** the platform owns and rejects from the manifest:
`DATABASE_URL`, `JWT_SECRET`, `PORT`, `USERNODE_ENV`,
`USERNODE_MISSING_SECRETS`. Don't list these.

**Platform-managed keys** the platform supplies a default for at
deploy time (overriding the manifest `default` but losing to a
stored value):

| Key | Source | Why |
|---|---|---|
| `NODE_RPC_URL` | platform's own `process.env.NODE_RPC_URL` | Points at `usernode-node` (in-network) in prod; `host.docker.internal:3001` in local-dev. Hardcoding either in the manifest breaks the other. |

You may still declare these in `dapp.json` with a `default` — that
becomes the fallback for standalone (non-platform) deploys. Just
know that inside the platform the manifest default will be replaced
with the platform's value automatically, unless a user explicitly
stored an override.

**When the Mayor / Claude Code adds a feature that needs a new env var**:

1. Add the entry to `dapp.json` (create the file if missing — the
   scaffold ships with `{ "secrets": [] }`).
2. In code, `process.env.MY_KEY` — if `required: true` you can rely
   on it being present (the deploy won't run otherwise).
3. **Never put real values in code or commit them**. The platform's
   Secrets UI is where users provide them, either directly (admins)
   or via a vote (non-admins).
4. Mention the new key in the dev-chat reply: "Added
   `STRIPE_SECRET_KEY` to the manifest — it's required, so set it in
   Settings → Secrets before this PR deploys."

When generating dapps from scratch, it's fine for the manifest to be
empty (`{ "secrets": [] }`) — only add entries when a feature actually
needs a value the platform should store.

## Public vs private secrets — **IMPORTANT**

Staging containers receive the prod secret store by default for
*non-private* entries — same `NODE_RPC_URL`, same public client IDs,
same feature flags as prod — because most config values are
infrastructure URLs or public identifiers that need to match across
environments for staging to be a useful preview.

**`private: true` controls TWO things at once:**

1. **At rest:** the value is encrypted in `app_secrets` and is never
   returned by the platform API. The Settings UI shows only "set" /
   "not set" with no `valueLast4`.
2. **In staging:** the prod stored value is *not* propagated. Staging
   resolves the value from manifest-committed fallbacks only — see
   the resolution order below.

The two behaviors are unified because they share a threat model: a
value worth encrypting at rest is also a value worth keeping out of a
PR's staging container, where any debug endpoint, error message, or
SSRF in unreviewed code is a public exposure. (Sibling pattern to the
SQL `staging:private` table marker.)

> **Backward compatibility:** existing `dapp.json` files written with
> `sensitive: true` keep working unchanged — the platform parses
> `sensitive` as an alias for `private` and applies the same dual
> behavior. New manifests should write `private: true`.

Mark a secret private by setting `"private": true`, and commit
the staging fallback alongside it:

```json
{
  "secrets": [
    {
      "key": "STRIPE_SECRET_KEY",
      "description": "Live Stripe secret for charging cards",
      "required": true,
      "private": true,
      "staging_default": "sk_test_publishable_dummy"
    }
  ]
}
```

In staging, private entries are resolved from manifest-committed
values only (in priority order):

1. `staging_default` — explicit, committed-to-source signal that
   "this is the value safe to use in staging." Use this for sandbox
   API keys (Stripe `sk_test_...`, sandbox OAuth `client_id`, etc.)
   or for randomly-generated dummies the app's staging code can
   detect and short-circuit on.
2. `default` — same fallback used by `required: false` secrets in
   prod. Reasonable when the dev intends the same default everywhere
   (typical for opt-in features that no-op when unset).
3. If both are unset on a `required: true` entry, the staging build
   fails with a `PrivateSecretMissingStagingDefaultError` listing
   the key and the remediation. This is intentional: silently passing
   an empty string would let bugs propagate into PR reviews.

Prod is unaffected — the staging filter only fires when
`forStaging: true` is passed to the deploy merge, which only the
staging path does. Prod resolves stored value → platform default →
`default` as always.

### Decide by asking: "would the staging container running this code with the prod value cause a real-world side effect, or could it leak from a debug endpoint?"

Mark **private** when the secret unlocks:

- Live payment processing (Stripe live keys, PayPal client_secret,
  bank API tokens).
- OAuth client secrets that mint *prod* user tokens (Google, GitHub,
  Slack OAuth `client_secret`).
- Signing keys used for prod user sessions (`JWT_SECRET`,
  `SESSION_SECRET`).
- Wallet / on-chain secret keys that hold real funds.
- Database superuser passwords.
- Push-notification keys (FCM, APNS) that fan out to real devices.
- Email / SMS sending credentials (SendGrid API key, Twilio auth
  token).
- Any HSM / KMS unwrap key.

Leave **non-private** (the default) for:

- Public API keys and `client_id`s (anything ending in `_PUBLISHABLE_`
  or marked "safe in client-side code" by the vendor).
- Infrastructure URLs (`NODE_RPC_URL`, sidecar hostnames, queue URLs).
- Feature flags, log levels, locale defaults.
- Read-only scoped tokens whose blast radius is genuinely contained.
- Public identifiers (account IDs, project slugs).

### Rules

- **`required + private` MUST commit a `staging_default` (or
  `default`).** Otherwise the staging build will fail. This is the
  only acceptable failure mode — empty-string-by-default would let
  bugs propagate silently into PR reviews.
- **A non-private secret MUST NOT be derived from a private one
  in code.** If your app reads `JWT_SECRET` (private) and uses it
  to compute `BUILD_FINGERPRINT` (non-private) which it then
  exposes, the fingerprint is now a side-channel for the secret.
  Either mark the derived value private too, or use a
  one-way-but-distinguishable derivation that doesn't leak.
- **Vendor-provided sandbox / test-mode keys are NOT a special case.**
  Stripe's `sk_test_...` is still a credential the vendor expects you
  to handle as one — mark it private *and* set
  `staging_default: "sk_test_..."` (committing the test key directly).
  Don't use this to share the prod key with staging.

### When the Mayor / Claude Code adds a new secret to `dapp.json`

1. **Default to `private: false`** for genuinely-public values
   (URLs, IDs, feature flags). This is most secrets.
2. **Run the "would the staging container running this code with the
   prod value cause a real-world side effect, or leak from a debug
   endpoint?" test.**
3. If the answer is yes, set `"private": true` and add a
   `"staging_default"` (a vendor-provided test-mode key or a dummy
   the app's staging code can short-circuit on).
4. Mention the choice briefly in the dev-chat reply: "Marked
   `STRIPE_SECRET_KEY` private (encrypted at rest, isolated from
   staging) — added `staging_default: 'sk_test_publishable_dummy'`
   so staging gets a no-op test key."

## App LLM access — the platform Claude proxy

Apps that want AI features call Claude **through the platform's
LLM proxy**, billed to the signed-in user's existing daily AI budget
under an explicit per-app, per-user permission grant. **Never ask
users for Anthropic API keys, and never store an API key as an app
secret** — the proxy exists precisely so apps don't handle keys.

Production containers receive two extra env vars (platform-injected;
both are reserved manifest keys you must not declare):

- `USERNODE_LLM_PROXY_URL` — base URL of the proxy
  (`http://usernode:3000/api/app-llm` in-network).
- `USERNODE_LLM_PROXY_TOKEN` — this app's opaque credential.

**Staging containers receive NEITHER** (unreviewed PR code must not be
able to spend users' budgets), and standalone deploys have no platform
to call. Always detect absence and degrade gracefully:

```js
const LLM_ENABLED = !!process.env.USERNODE_LLM_PROXY_TOKEN;
// When false: hide/disable AI features in the UI, or return a clear
// "AI features are unavailable in this environment" from the API.
```

### Calling the proxy (server-side)

The app's **server** calls the proxy, forwarding the user's iframe
token (the same `x-usernode-token` value the frontend already sends —
see "Auth"). Two endpoints are available, both POST, mirroring the
Anthropic Messages API:

- `POST ${USERNODE_LLM_PROXY_URL}/v1/messages`
- `POST ${USERNODE_LLM_PROXY_URL}/v1/messages/count_tokens`

```js
const resp = await fetch(`${process.env.USERNODE_LLM_PROXY_URL}/v1/messages`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-usernode-app-token': process.env.USERNODE_LLM_PROXY_TOKEN,
    'x-usernode-user-token': req.headers['x-usernode-token'],
  },
  body: JSON.stringify({ model, max_tokens, messages }),
});
```

The body/response are standard Anthropic Messages API shapes
(streaming SSE included). Error codes the app must handle:

- `403 { code: 'grant_required' }` — the user hasn't granted this app
  access (or revoked it). Surface this to the frontend, have it call
  `usernode.requestLlmAccess()` (below), then retry.
- `429 { code: 'app_cap_exceeded' }` — the user's per-app daily cap is
  spent. Show "daily AI cap for this app reached — resets at midnight
  UTC"; do not retry until tomorrow.
- `429 { code: 'budget_exceeded' }` — the user's overall daily budget
  is exhausted.

### Requesting consent (frontend, via the bridge)

The hosted bridge (see "Bridge") provides:

- `usernode.requestLlmAccess()` — asks the **platform shell** to show
  its consent dialog (app name, your declared purpose, an editable
  daily cap). Resolves `{ granted, dailyCapCents, allowByok }` or
  `{ granted: false, declined: true }`. The dialog is platform-owned;
  an app cannot approve itself.
- `usernode.getLlmAccess()` — read-only grant state, same shape.

Both reject when there's no platform shell (standalone/dev) — treat a
rejection like `LLM_ENABLED === false`.

Recommended pattern: call the proxy; on `grant_required`, have the
frontend `await usernode.requestLlmAccess()` and retry once granted.

### Declaring consent metadata in `dapp.json`

An optional top-level `llm` block shapes the consent dialog:

```json
{
  "llm": {
    "purpose": "Summarizes long threads for you",
    "suggested_daily_cap_cents": 300
  }
}
```

- `purpose` — one short line (≤140 chars) shown in the dialog so the
  user knows why the app wants AI. Always declare it for AI features.
- `suggested_daily_cap_cents` — pre-fills the dialog's editable cap
  field instead of the $1.00 default. Suggest a **modest** value that
  matches the feature's real cost; the user sees and can change the
  number, and the platform clamps it to the user's own daily limit.
  Omit it unless the default is genuinely too small.

Users manage grants (cap, revocation, BYOK spillover) in the
platform's Settings → "App AI permissions"; revocation is immediate,
so treat `grant_required` as a state that can appear at any time, not
just on first use.

## Don't `git push` yourself

The worker container runs with **zero GitHub credentials in env** —
no PAT, no credential helper, nothing. Any direct `git push` you try
will fail with an HTTPS auth error. Same for any direct GitHub REST
API calls: there's no token to authenticate them with.

What to do instead: just commit (`git add -A && git commit -m "…"`)
and stop. The harness handles the push for you by calling back into
the platform's internal API (`/api/internal/sessions/:id/push`),
which validates your session and runs the push from the platform
side with the canonical branch name pulled from the DB. You don't
choose what gets pushed — your session's branch does, every time.

If you're tempted to write a workaround that talks to GitHub
directly, stop. There's no path that works: the worker has no
credentials, and the only outbound calls back to the platform are
the push/PR proxy endpoints (which only accept the session's
canonical branch). Commit cleanly and let the harness finish the job.

## Bridge — centrally hosted (not vendored)

`usernode-bridge.js` is the one piece of cross-dapp infrastructure
that is **not vendored**. It is served as a single canonical copy
from the Usernode Social Vibecoding platform itself:

```
https://social-vibecoding.usernodelabs.org/usernode-bridge/v1/bridge.js
```

Canonical source: `social-vibecoding/public/usernode-bridge/v1/bridge.js`.

Every dapp's HTML shell loads this URL directly. Cross-origin
`<script>` tags are allowed by default; no CORS dance is needed:

```html
<script src="https://social-vibecoding.usernodelabs.org/usernode-bridge/v1/bridge.js"></script>
```

Rules:

- **Never vendor `usernode-bridge.js` per app.** Bridge fixes ship
  from a single SV redeploy and propagate fleet-wide on the next page
  load. SV serves the file with `Cache-Control: no-cache,
  must-revalidate`, so browsers revalidate every load (304s when
  unchanged).
- **Versioning policy.** `/v1/` is the current major. Backward-
  incompatible bridge API changes bump to `/v2/` at a new URL; dapps
  migrate rollingly, and `/v1/` stays live until the last consumer
  has moved off. Within a major, fixes and additive features ship in
  place. When in doubt, prefer "additive within v1" over a v2 bump —
  the version sprawl is the cost, the URL change is the win.
- **Rollback.** Revert the offending commit in `social-vibecoding/`,
  redeploy SV. All dapps recover on the next page load — no per-dapp
  redeploy needed. This is the single biggest payoff of centralization
  vs. the old vendored-fan-out model.
- **Local-dev tradeoff.** `npm run dev` for any dapp now requires SV
  reachable for bridge-touching paths. App-logic iteration still
  works offline; only paths that actually exercise the bridge
  (`getNodeAddress`, `sendTransaction`, etc.) depend on SV being up.
- **Self-hosting caveat.** All dapps in the production fleet
  hard-code the `social-vibecoding.usernodelabs.org` host. Forks
  running their own SV instance either accept that their dapps load
  the bridge from upstream prod, or fork the dapps and edit the URL.
  See [SELF-HOSTING.md](../../SELF-HOSTING.md) for details.

## Vendored shared files

Several other files are **vendored across the platform fleet**: one
canonical source lives in `usernode-dapp-starter`, and each consumer
dapp ships its own copy. Changes propagate by **re-vendoring** (copying
the file from canonical), not by editing the per-app copy. (The
bridge above is the exception — see that section for why it's
centrally hosted instead.)

Canonical sources (all in the `usernode-dapp-starter` repo):

| File | Path within repo |
|---|---|
| `usernode-usernames.js` | repo root |
| `usernode-loading.js` | repo root |
| `lib/dapp-server.js` | `examples/lib/dapp-server.js` |
| `lib/tx-match.js` | `examples/lib/tx-match.js` |

Consumers today include `usernode-echo-dapp`,
`usernode-last-one-wins-dapp`, `usernode-opinion-market-dapp`,
`usernode-falling-sands-dapp`, `usernode-feedback-hub`, and
`usernode-group-chat-dapp-test`. The list grows over time; each
consumer's own `CLAUDE.md` names what it vendors and from where.

Rules:

- **Never edit a vendored copy in place** to fix a cross-cutting bug.
  The next re-vendor overwrites it. Edit the canonical source in
  `usernode-dapp-starter`, then re-vendor into each consumer.
- **When designing a cross-cutting fix, count consumers up front.**
  A "one-line" change in canonical is N+1 commits in practice
  (canonical + every consumer). Don't propose a per-app call-site
  change as cheaper than a canonical fix without making that count
  explicit. The fan-out cost is invisible from inside a single
  consumer repo and is a common source of mis-pricing.
- **One-off fixes that apply only to a single dapp** belong in that
  dapp's own non-vendored code, not in a vendored copy. Sentinel: if
  the change makes sense in every other consumer too, it goes in
  canonical.

## Dev console forwarder

Every scaffolded `public/index.html` contains a `<script>` block
tagged `// usernode-dev-console@1`. It captures `console.*` output
and uncaught errors and forwards them via `postMessage` so the
platform's developer console can surface them. Don't remove or
modify that block when editing the HTML shell.

## Outputting file edits

When Claude Code outputs updated file contents, use the standard
fenced-code format with a `filepath:` prefix the harness parses:

````
```filepath:path/to/file.js
// complete file contents here
```
````

Always output the **full** file contents, not diffs or partial
snippets.
