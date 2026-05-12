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

## Don't `git push` yourself

The harness clones the repo, runs Claude Code, then commits and
pushes for you. Manual `git push` calls from the agent only add
noise (and can confuse the reviewer) — commit with `git add -A &&
git commit -m "…"` and stop there.

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
