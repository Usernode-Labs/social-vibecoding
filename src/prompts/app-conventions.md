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
The staging container exists so a tester approves **the exact app that
will ship**. That only holds if staging and production run the *same
code path* — `USERNODE_ENV` may swap the **data** behind that path and
suppress **real-world outbound side effects**, but it must never change
which features exist or how the core logic behaves.

Canonical helper:

```js
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
```

### Gate data and side effects — never features or logic

✅ **Legitimate uses of `IS_STAGING`:**

- **Seed mock data** for tables that aren't copied into staging
  (newly created tables, `staging:private` tables, hard-to-reach
  states). See "Staging mock data" below.
- **Suppress irreversible outbound side effects** — don't send real
  emails, charge real cards, post to real webhooks, or broadcast real
  on-chain transactions from staging. Point at a sandbox endpoint or
  no-op instead, but keep the surrounding code path identical (same
  validation, same DB writes, same response shape) so the path is
  actually exercised by the tester.
- **Show a "staging" indicator** in the UI so testers know what
  they're looking at.

🚫 **Never gate these on `USERNODE_ENV`:**

- **Feature availability.** No feature, screen, button, or endpoint
  may exist in one environment and be absent in the other. If a tester
  approves it, production must have it; if production lacks it, the
  tester must not see it.
- **Auth / permissions.** Don't auto-grant admin, bypass login, or
  seed yourself into a privileged table only in staging. Admin and
  permission flows must be reachable in production the same way.
  (If a feature needs an admin to operate, it's broken in production
  the moment its admin only exists in staging.)
- **The default core logic path.** A "testing mode" that swaps the
  real implementation for a fake one (mock wallets, fake balances,
  short-circuited game logic) is fine **as an explicit, opt-in tool
  available in both environments** — but it must NOT be the silent
  default a tester sees, and it must NOT be env-exclusive. If staging
  defaults to the mock path, the tester approves the mock — not the
  real feature — and ships a product nobody actually exercised. Keep
  the real path as the default everywhere; let mock mode be something
  you deliberately turn on (query param, settings flag, admin
  toggle).

Rule of thumb: if flipping `USERNODE_ENV` to `production` would make a
feature **stop working** (rather than just operate on real data /
real endpoints), you've gated the wrong thing. Move the difference to
**data** (seed it) or to a **single outbound boundary** (the email /
charge / chain call), and leave everything else identical.

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

### Testing `path:` for a hash-routed SPA (the self-app)

The before/after screenshots and the "Test this change" button visit the
testing block's `path:` joined onto the staging origin. Most apps are
path-routed, so a plain pathname (`/board`, `/settings?demo=1`) lands on
the right screen.

**The self-app (social-vibecoding) is a hash-routed single-page app**:
its internal screens are addressed by the URL **fragment**
(`#app/<slug>/dev/proposals/<id>`, `#leaderboard`,
`#app/<slug>/dev/sessions/<id>`, …), never by server pathname — a
pathname just loads `index.html`, which boots to the home feed. So when
your change is to a self-app screen, write the `path:` using the in-app
route segments exactly as they appear after the `#`, with a leading
slash:

- `path: /app/<self-slug>/dev/proposals/<id>`
- `path: /leaderboard`

The platform recognises these self-app routes and moves them into the
fragment when capturing and when previewing, so the shot shows the
changed screen instead of the homepage. Standalone server-rendered pages
(`/dashboard`, `/admin`, `/status`, `/node-status`) stay as plain
pathnames. **Always point a deep `path:` at the specific changed
self-app screen** — omitting it defaults to `/` (the home feed), which
no capture fix can rescue.

## Proposal tests — "CI for proposals"

Every proposal carries a **checks** status: after each staging build the
platform runs a set of automated headless-browser tests against the
proposal's staging preview and records a pass/fail result. **A proposal
whose checks are not passing — failing, still running, or couldn't run —
is BLOCKED from merging even with a winning vote** (admins can still
force-merge). This is the platform's safeguard against merges that break
the app.

A **test** navigates one staging route and asserts that the page loads
(HTTP < 400), throws no console errors / uncaught exceptions, and —
optionally — that an expected element or text is present. The
console-error check is the built-in baseline: every proposal gets a
"loads with no console errors" test on its routes for free, even with no
tests declared.

Declare tests in a top-level `tests` array in `dapp.json`. They live in
the repo and **accumulate across proposals** — once a proposal merges, its
tests run on every future proposal, exactly like CI tests in a GitHub
repo. Shape:

```json
{
  "tests": [
    { "name": "Board renders", "path": "/board?demo=1", "expectSelector": ".board" },
    { "name": "Settings opens", "path": "/settings", "expectText": "Preferences" }
  ]
}
```

Per-test fields:

- `path` — **required.** A relative route within the app (same rules as a
  testing-block `path:`: starts with a single `/`, no scheme/host). For
  the hash-routed self-app, use the in-app route segments (e.g.
  `/leaderboard`) — the platform normalises them into the fragment.
- `name` — short label shown in the checks detail. Defaults to the path.
- `expectSelector` — optional CSS selector that must be present after the
  page settles.
- `expectText` — optional text that must appear in the page body.
- `allowConsoleErrors` — set `true` only for a route that legitimately
  logs errors; it opts that one test out of the baseline no-console-errors
  rule.

When you add or change a user-visible screen, **add or extend a test for
it** in the same commit, pointing it at the same route(s) you put in the
TESTING block's `path:` lines. The test's route renders against a FRESH,
EMPTY staging database, so seed any data the route needs per "Staging mock
data" above (a blank page usually means missing seed data, not a bug). A
test that depends on missing seed data will fail and block your merge.
Because checks gate merge, verify your declared tests pass (use the in-loop
browser on a build turn) before you commit.

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

### Top-level `icon` — the app's homescreen icon

`dapp.json` may carry an optional top-level `icon` block — the
**source of truth for the app's homescreen tile icon**. Two forms:

```json
{ "icon": { "emoji": "🎮" } }
```

```json
{ "icon": { "image": "public/icon.png" } }
```

- `emoji` — a single emoji (trimmed, 1–16 UTF-16 code units, no
  whitespace). Rendered large on the tile's violet background.
- `image` — a **repo-relative path to an image file committed in the
  app's repo**. The platform reads the file at deploy time, validates
  it, and serves it so the image completely fills the rounded tile
  (cropped to fit). Constraints: ≤ 256 KB; PNG, JPEG, WebP, or GIF
  only (sniffed from the file's bytes — SVG is not accepted); the
  path must be relative, inside the repo, with no `..` segments.

Rules:

- On every production deploy the platform reads the block and
  reconciles the app's stored icon to it. Unlike `name`/`visibility`,
  the block is **fully authoritative: an absent block (or an invalid
  one) clears the icon**, restoring the default first-letter tile —
  so removing the declaration is how an icon is removed.
- If both `emoji` and `image` are declared, the image wins; the emoji
  is the fallback should the image file fail validation (missing,
  oversized, wrong format).
- **Changing the icon is just a PR that edits this block** (and, for
  an image, commits the file). The change takes effect when the PR is
  voted in, merged, and redeployed — not before. Don't mutate the
  icon through any other channel.

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

Declaring these in `dapp.json` is **optional** — the platform injects
its value into every deploy (production and staging) whether or not
the manifest mentions the key, so code may read
`process.env.NODE_RPC_URL` without a manifest entry. You may still
declare them with a `default` — that becomes the fallback for
standalone (non-platform) deploys. Just know that inside the platform
the manifest default will be replaced with the platform's value
automatically, unless a user explicitly stored an override.

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

Every response after successful auth (successful calls, upstream
errors, and the two 429s above) also carries a spend meter as
response headers — **read these instead of keeping your own
token-price table**:

- `x-usernode-llm-spent-cents` — the user's cumulative spend through
  this app today, in cents, as of the **start** of the call (the
  call's own cost settles after the response ends). May be fractional
  (e.g. `4.7914`) and can lag a few seconds; treat it as an
  approximately-real-time meter, not a settlement record. Resets at
  midnight UTC, same as the cap.
- `x-usernode-llm-cap-cents` — the grant's daily cap for this app
  (integer cents).

Together they let a server show "used $X of $Y today" with zero extra
requests, warn near the cap, or disable AI features gracefully before
hitting `app_cap_exceeded`.

### Requesting consent (frontend, via the bridge)

The hosted bridge (see "Bridge") provides:

- `usernode.requestLlmAccess()` — asks the **platform shell** to show
  its consent dialog (app name, your declared purpose, an editable
  daily cap). Resolves `{ granted, dailyCapCents, allowByok }` or
  `{ granted: false, declined: true }`. The dialog is platform-owned;
  an app cannot approve itself.
- `usernode.getLlmAccess()` — read-only grant state, same shape.
- `usernode.getLlmUsage()` — read-only usage meter for a frontend
  display: resolves `{ granted: true, spentCentsToday, dailyCapCents }`
  (today's spend through this app vs the user's cap — the same
  numbers the platform's Settings panel shows; `spentCentsToday` may
  be fractional cents) or `{ granted: false }` when the user hasn't
  granted access. Never opens the consent dialog.

All of these reject when there's no platform shell (standalone/dev) —
treat a rejection like `LLM_ENABLED === false` (for `getLlmUsage`,
"usage unavailable").

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

## Native-feel UI kit — centrally hosted (`usernode-native`)

An **opt-in** CSS + JS kit that makes an app's mobile UI feel native on
iOS and Android: platform-adaptive switches, native pressed states,
swipe-to-act list rows, drag-to-reorder lists, pull-to-refresh (inner
containers or the whole page), bottom sheets, centered modals, action
sheets, alert dialogs, toasts, blurred nav bars with collapsing large
titles, inset-grouped list styling, and animated push/pop screen
transitions — all in vanilla JS + CSS, no build step,
attaching to the app's existing DOM. It is **available and recommended for mobile-facing
UI**; adopting it is each app's choice (typically driven from dev chat),
not a requirement.

Like the bridge, it is centrally hosted — never vendor it:

```html
<link rel="stylesheet" href="https://social-vibecoding.usernodelabs.org/usernode-native/v1/native.css">
<script src="https://social-vibecoding.usernodelabs.org/usernode-native/v1/native.js"></script>
```

Canonical source: `social-vibecoding/public/usernode-native/v1/`. The
same rules as the bridge apply: fixes ship platform-side and propagate
on the next page load; `/v1/` is a frozen API surface (additive changes
in place, breaking changes bump to `/v2/`). A live demo of every
component is served beside the kit at `/usernode-native/v1/demo.html`
(`?un-platform=ios|android` forces a skin, `?un-tune=1` shows the
spring tuner).

### What the kit provides

Loading `native.js` sets `html.un-ios` / `html.un-android` /
`html.un-desktop` (platform skins hang off these) and exposes
`window.unNative`:

- **Touch polish (automatic).** `native.css` removes the grey tap
  highlight and gives every `button` / `[role="button"]` /
  `.un-pressable` an instant pressed state (scale + dim, engages with
  zero latency, springs back on release). `.un-touch-target` expands a
  small icon button's hit area to ≥44px without changing layout.
- **Switches.** Add class `un-switch` to an existing
  `<input type="checkbox">` — nothing else. iOS pill on iPhones,
  Material 3 track/thumb on Android, pure CSS.
- **Swipe-to-act rows.**
  `unNative.attachSwipeActions(rowEl, { actions: [{ label, destructive,
  handler, color? }] })`. Reveals action buttons on a left drag via a
  **ride-along tray** that translates in lockstep with the row — nothing
  is painted behind the row, so rounded rows, row margins, translucent
  backgrounds and inset-grouped cards all render cleanly. When the
  **last** action is `destructive: true`, a full swipe (or hard flick)
  commits it, with a haptic tick as the delete cue arms/disarms (where
  the device supports vibration). On a destructive commit the kit
  collapses and removes the row from the DOM, **then** calls
  `handler()` — do the API call / re-render there. Returns
  `{ close(), detach() }`.
- **Pull-to-refresh.**
  `unNative.attachPullToRefresh(scrollEl, onRefresh, opts?)` on a
  scrollable list container **or the window scroller** (pass `window`,
  `document`, or `document.scrollingElement` for pages that scroll as
  one document). In window mode the rubberband translate is applied to
  `opts.content` — default `document.body.firstElementChild` (the
  `#app`-style root); pass it explicitly if your `<body>` has several
  top-level children — and the spinner puck is fixed-positioned.
  `onRefresh()` returns a Promise and the spinner holds until it
  settles. For element containers, give them
  `overscroll-behavior-y: contain` (the kit also sets it defensively).
  No-op on desktop. Never throws: invalid input logs a console warning
  and returns a no-op `{ detach() }`.
- **Drag-to-reorder lists.**
  `unNative.attachReorder(listEl, { handle?, itemSelector?,
  longPressMs?, canDrop?, onReorder })`. Native-feel reordering: on
  touch a long-press (default 400ms) lifts the row, which then tracks
  the finger 1:1; on desktop, drag the `handle` (a CSS selector for a
  grabber inside each row — handles lift immediately on both inputs)
  or, with no handle, any vertical drag on the row. An accent-colored
  overlay bar marks the drop slot, the viewport/scroll-container
  auto-scrolls near its edges, and release springs the row into place —
  the kit then moves the element in the DOM and calls
  `onReorder(fromIndex, toIndex, itemEl)` (persist the order there).
  `itemSelector` defaults to `listEl`'s children minus
  `.un-group-header`; pass it explicitly for grouped/sectioned markup —
  indices span the whole matched list, so cross-section moves just
  work, and hovering a section header inserts at the top of that
  section. Composes with `attachSwipeActions` on the same rows (attach
  swipe actions first, then reorder on the container — the items are
  the `.un-swipe` wrappers) and with pull-to-refresh via the gesture
  arbiter. Returns `{ detach() }`; never throws on bad input.
- **Bottom sheet.** `unNative.presentSheet({ content | contentEl,
  onDismiss })` — grabber, spring presentation, 1:1 drag-to-dismiss
  with momentum commit (a touch mid-spring inherits position and
  velocity), backdrop tap dismisses. Keyboard avoidance is built in
  (see below) — sheets with text fields ride above the on-screen
  keyboard automatically. Returns `{ dismiss(), el }`.
- **Centered modal.** `unNative.presentModal({ content | contentEl,
  onDismiss?, dismissible? })` — arbitrary content in a centered card
  over the same dimmed backdrop as the sheet/alert, with the alert's
  fade + scale-settle motion. Backdrop tap and Escape dismiss (unless
  `dismissible: false`); taps on the card never dismiss; nothing is
  clickable during the fade-out; tall content scrolls inside the card.
  The natural surface for forms, share panels and editor dialogs —
  especially on desktop/tablet where a bottom sheet reads as a phone
  idiom. Keyboard avoidance is built in (see below): with the
  on-screen keyboard up, the card re-centers in the visible strip
  above it and shrinks to fit. Returns `{ dismiss(), el }`.
- **Action sheet.** `unNative.actionSheet({ title?, actions: [{ label,
  destructive?, handler? }], cancelLabel? })` — iOS-style stack with a
  red destructive action and a separate Cancel card; backdrop cancels.
  Resolves a Promise with the chosen action object, or `null`.
- **Alert dialog.** `unNative.alert({ title, message?, field?:
  { placeholder?, value? }, buttons?: [{ label, style?:
  'cancel'|'default'|'destructive', handler? }] })` — the compact
  270px centered iOS alert with optional inset text field. Resolves
  `{ button, value }` (always write it `unNative.alert(...)` — it does
  not replace `window.alert`). The field autofocuses, and keyboard
  avoidance is built in (see below): the alert re-centers above the
  on-screen keyboard.
- **Keyboard avoidance (automatic).** On mobile the kit tracks the
  on-screen keyboard via `visualViewport` and maintains
  `--un-kb-inset` (the keyboard's occlusion of the layout viewport,
  in px) plus class `un-kb` on `<html>` while it is non-zero. Sheets,
  action sheets, modals and alerts consume it automatically and ride
  above the keyboard — smoothly, without disturbing drag-to-dismiss.
  **Do not hand-roll `.un-sheet { bottom: … }` overrides or per-app
  visualViewport plumbing anymore** — delete them when adopting this;
  the kit owns the inset now. Apps may consume `var(--un-kb-inset,
  0px)` for their own fixed bottom bars. No-op on desktop or where
  `visualViewport` is absent.
- **Keyboard avoidance for fixed-shell content scrollers.**
  `unNative.attachKeyboardAvoidance(scrollEl, { topEl?, margin? = 8,
  fields? })` — the same keyboard physics for the APP's main content
  scroller. Built for the native-app **fixed-shell recipe**: `html,
  body { height: 100%; overflow: hidden }` plus one
  `position: fixed; inset: 0; overflow-y: auto` scroller, so the
  keyboard can never scroll or reflow the page frame — only content
  slides. The kit then owns everything subtle: keyboard clearance as
  content padding on the scroller (instant on open, eased on close —
  note it *replaces* the scroller's own bottom padding while the
  keyboard is up, the safe-area sits behind the keyboard anyway),
  single-motion focus reveals (taps on text-entry fields are
  intercepted so the browser's uncoordinatable native reveal never
  fires; the content slides ONCE, above the keyboard and below
  `topEl` — pass the same bar you give `attachNavBar`), instant
  reveals on field-to-field hops, a coalesced settled pin after the
  keyboard's viewport-event burst, and an iOS visual-viewport offset
  guard. Buttons, switches, selects, native pickers and the
  already-focused field keep fully native taps; fields inside kit
  sheets/modals/alerts keep the kit's built-in avoidance. `fields`
  optionally replaces the default text-entry allowlist with a CSS
  selector. Programmatic focuses in the app should use
  `el.focus({ preventScroll: true })` so the kit's reveal stays the
  single motion. Composes with `attachNavBar(scrollEl)` and
  element-mode `attachPullToRefresh`. **Fixed-shell apps must use
  this instead of hand-rolled visualViewport plumbing** — delete any
  app-side keyboard plumbing when adopting it. No-op on desktop or
  where `visualViewport` is absent; returns `{ detach() }`; never
  throws on bad input.
- **Toast / transient status.** `unNative.toast(message, { duration?,
  action?: { label, handler }, priority?, onClose? })` — fire-and-forget
  feedback ("Copied", "Saved", API errors): a bottom capsule HUD on
  iOS/desktop, a Material snackbar on Android, safe-area aware,
  auto-hiding (2.2s, 4s with an action). Singleton with
  last-writer-wins among ordinary toasts: a new call replaces a
  still-visible toast and resets its timer — no stacking. A
  `priority: true` toast is NOT displaced by ordinary toasts; those
  wait — at most one, latest wins — and show after it resolves (a newer
  priority toast still takes over). `onClose(reason)` fires exactly
  once per call — `'timeout'` | `'action'` (after the action handler) |
  `'dismiss'` | `'replaced'` — including for toasts replaced while
  still waiting. For undo flows, use a priority action toast with
  `onClose` and commit the pending operation on any reason except
  `'action'` — don't hand-roll an undo pill. It never steals taps from
  content underneath (`pointer-events` stay off except on the optional
  action button). Returns `{ dismiss(), el }`. Use it instead of
  hand-rolling a `#toast` div.
- **Nav bars.** Markup classes `un-navbar` (fixed, blurred, translucent),
  `un-navbar-title`, `un-navbar-back` (tinted back chevron), and
  `un-navbar-large` (large-title block in the page flow). Wire with
  `unNative.attachNavBar(barEl, { scrollEl?, largeTitleEl? })` — shows
  the hairline once scrolled and collapses the large title into the
  compact bar; `scrollEl` defaults to the window scroller. Returns
  `{ detach() }`.
- **Inset-grouped lists (pure CSS).** `un-group` (rounded card),
  `un-group-header` (uppercase inset section header), `un-group-row`
  (inset hairline separators drawn on the static container, so they
  hold still while a row swipes). The biggest "looks native" lever;
  composes with `attachSwipeActions`.
- **Gesture arbiter.** `unNative.gestures` — `{ claim(seq, token),
  owner(seq), release(seq) }`, the single intent lock the kit's own
  swipe and pull-to-refresh recognizers go through. App gestures
  (long-press drag, custom pans) should join it: at your own
  intent-lock moment (never before movement passes the lock threshold),
  `claim(seq, yourToken)` — for the primary touch the sequence is the
  string `'touch'`; for non-touch pointers, the `pointerId` — and back
  off if it returns `false`. Claims auto-clear when the finger lifts.
- **Screen transitions.** `unNative.transition(fn, { type: 'push' |
  'pop' | 'none' })` wraps your DOM mutation in a View Transition (iOS
  slide+parallax / Android shared-axis fade; instant cut where the API
  is missing). Use `'push'`/`'pop'` for real screen navigation ONLY;
  tab switches, menus and panel toggles must use `'none'` — repeated
  animation on high-frequency UI reads as lag, not polish. For
  tile/card → detail navigation there are also `type: 'zoom-in'` /
  `'zoom-out'` — the iOS-homescreen expand/collapse: the destination
  screen grows out of the tapped tile's on-screen rect, and Back
  shrinks it into the tile again. Pass `el` (the screen element that
  moves) and `fromEl` (the tile element — or a function returning it,
  resolved lazily; or a static `fromRect`), and split the mutation in
  two: `fn` reveals the incoming screen (leave the outgoing one
  visible — it shows beneath the moving card) and `after` conceals the
  outgoing one (the kit runs it exactly once on every path). The LIVE
  element is transform-animated as a pinned fixed overlay — no View
  Transition snapshot, so it's iframe-safe and content keeps loading
  mid-zoom — with an opaque `--un-zoom-bg` surface for the duration
  and an exact inline-style restore at the end. When the zoom can't
  run (tile off-screen, deep link, reduced motion) it falls back to
  `fallback` (`'push'`/`'pop'` by default, or `'none'`) with the
  combined mutation. Push/pop remain the default for plain screen
  navigation.
- **Safe areas.** Opt-in helpers `.un-safe-top` / `.un-safe-top-extend`
  / `.un-safe-bottom` / `.un-safe-bottom-extend` / `.un-safe-x` apply
  `env(safe-area-inset-*)` padding to fixed bars. They require
  `viewport-fit=cover` in the page's viewport meta.
- **Spring engine.** `unNative.spring(elOrCallback, { from, to,
  velocity, preset })` — the kit's own rAF damped-spring integrator,
  available for custom gestures so they match the kit's motion family.

### Fidelity rules (why the kit feels native — don't undo them)

The kit implements, and custom UI in an adopting app should follow:
**1:1 finger tracking** (during a drag the element is a pure function
of the finger; nothing animates 0→1 after a threshold), **interruptible
motion** (a touch mid-spring grabs the element at its current position
and velocity), **momentum commits** (release velocity is projected —
a short hard flick commits; drifting back past the line cancels),
**spring releases** (no fixed duration+bezier on gesture releases), 
**destructive actions fire only on gesture end**, and **no animation on
high-frequency interactions** (tabs, menus, panels). Don't wrap kit
gestures in your own CSS transitions and don't add entrance animations
to frequently-used controls.

### Theming — override `--un-*` variables, never fork the CSS

Every color and radius in the kit routes through CSS custom properties
with platform-violet defaults (and built-in `.dark` values). Re-theme
by overriding them on `:root` / `.dark` / any wrapper — never by
out-specificity-ing kit selectors or copying the stylesheet:

- `--un-accent`, `--un-accent-contrast` — active/on color and what's
  drawn on top of it
- `--un-switch-track-off`, `--un-switch-thumb`
- `--un-action-danger`, `--un-action-neutral`, `--un-action-text` —
  swipe-action buttons
- `--un-surface` — kit chrome (pull-to-refresh puck)
- `--un-hairline`, `--un-muted` — separators and secondary text
- `--un-group-bg`, `--un-sheet-bg`, `--un-navbar-bg`, `--un-backdrop`
  — grouped-list cards, sheet/modal/alert surfaces, nav-bar backing,
  overlay dim
- `--un-toast-bg`, `--un-toast-text`, `--un-toast-action` — the toast
  surface (dark in BOTH modes, the iOS HUD idiom) and its action label
- `--un-radius`, `--un-radius-full`, `--un-radius-card`

Physics, thresholds and gesture geometry are deliberately **not**
themeable — the native feel stays uniform across differently-branded
apps.

### Adoption steps (what "switch this app to the kit" means)

1. Add the two hosted tags above to the HTML shell's `<head>`.
2. Add `viewport-fit=cover` to the viewport meta; put `.un-safe-top` /
   `.un-safe-bottom` (or the `-extend` variants) on fixed headers /
   bottom bars.
3. Add `future: { hoverOnlyWhenSupported: true }` to the page's inline
   `tailwind.config` so `hover:` styles stop sticking after taps on
   touch screens.
4. Swap checkbox-style toggles to `class="un-switch"`.
5. Wire `attachSwipeActions` on list rows with row-level actions
   (delete / archive / mark read), `attachPullToRefresh` on
   refreshable lists, and `attachReorder` on user-orderable lists.
   If the app uses (or adopts) the fixed-shell layout with in-page
   text fields, wire `attachKeyboardAvoidance` on the content
   scroller and delete any hand-rolled visualViewport plumbing.
6. Route real screen navigations through `unNative.transition`
   (`'push'`/`'pop'`; `'zoom-in'`/`'zoom-out'` for tile/card → detail);
   leave tabs/menus/panels instant.
7. Optionally override `--un-*` variables to match the app's branding.

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

### Helping users surface runtime errors

When a user reports a runtime problem you can't reproduce from the
source ("nothing happens when I click", "it's broken on my phone", a
blank screen), the fastest path to a fix is their actual console output
— but **do not tell them to open browser devtools or press F12.** Most
users are inside the Usernode mobile app or a phone browser where
devtools don't exist, so that advice dead-ends the conversation (a
common failure mode: the agent asks for a console trace, the user
answers "I can't open the terminal / I don't have F12", and the loop
stalls).

Instead, point them at the platform's built-in **Dev Console** — an
in-app, mobile-friendly panel surfaced by the `usernode-dev-console@1`
forwarder above. It shows up as a console icon in the header (it
appears automatically once the app logs an error, and can be pinned on
via Settings → "always show dev console"). Ask them to open it and
paste the red error lines. It captures exactly the same `console.*`
output and uncaught errors on mobile as on desktop, so it works
regardless of device.

### Fixing a reported bug

When the user reports a specific broken *behaviour* (not a new
feature):

- **Reproduce it first.** On a build turn, use the in-loop browser
  (see "In-loop browser" below) to actually exercise the flow the user
  described — click the button, play the round, submit the form —
  instead of only reading source. Logic bugs (a counter that resets, a
  balance that doesn't update, "buy 16, take 1, it drops to 0") are
  invisible to source-reading *and* to the baseline "no console errors"
  check; you have to run the flow to see them.
- **Lock the fix in with a test.** After fixing, add or extend a
  `dapp.json` test that would have caught it (navigate the route +
  assert the corrected behaviour / element), so a later change can't
  silently regress it. The baseline check only proves the page loads
  without console errors — it does **not** prove behaviour, so
  behavioural regressions slip through unless you add a test for them.

## Platform-level problems & missing capabilities: escalate, don't file workarounds

You can only edit and push **this app's** repo. Some things the app
needs don't live in this repo at all — they're in the platform or
shared infrastructure. Two categories are worth escalating:

**Platform-level breakage** — something outside this repo is broken:

- the shared bridge (`usernode-bridge.js`), wallet / signing, or the
  native mobile WebView (e.g. a file picker, camera, or share sheet
  that never opens inside the Usernode app)
- the staging / build / preview pipeline itself (the preview won't boot
  for reasons unrelated to your code)
- the merge/checks gate, or a documented platform convention that
  appears wrong or impossible to satisfy

**Missing platform capabilities** — a capability this app legitimately
needs that the platform doesn't provide: a bridge API that doesn't
exist, data the platform tracks but doesn't expose (e.g. per-app LLM
spend), a platform limit or convention that blocks a reasonable app
feature. **Feature requests are as valid as bug reports here** — don't
build a fragile app-side approximation of something the platform
should own without also drafting a report for the real capability.

When you're confident the root cause is platform-level — you've ruled
out an app-side fix, you've established the capability simply doesn't
exist, or you notice you're looping on the same failure without
progress — **stop patching this app** rather than faking a workaround
that only hides the problem. On a build turn a helper is available to
escalate it:

```
usernode-report-platform-issue "<short title>" <<'EOF'
What's broken or missing, how to reproduce / what the app needs it
for, and which app/flow hit it.
EOF
```

This does **not** file anything by itself. It posts a draft report
card into the dev chat; a user must tap **"Report to platform"** on
that card before the issue is actually filed on the platform repo
(they can also dismiss it). Draft it **once per distinct problem** —
it de-dupes against open reports and this session's earlier drafts, so
don't re-suggest the same thing. Then tell the user you've suggested a
platform report and that they can confirm it from the card in the
chat, and continue with any app-side work that isn't blocked by it.

## Rendering invariants — opt-in self-checks

The bridge (see "Bridge") exposes an **opt-in** API for registering
cheap correctness checks that run in the live preview and report
failures into the same developer console as `console.error`. It is
fully **no-op by default**: an app that registers nothing behaves
exactly as before. Use it to catch *structural* rendering bugs that a
screenshot might not make obvious — the canonical example being a
canvas that should exactly fill its window but renders at the wrong
pixel density on HiDPI screens.

A check is a function returning a truthy value when the invariant
holds, or `false` / a string reason when it's violated. Register it
once the bridge is loaded:

```js
usernode.invariants.register('canvas-fills-window', function () {
  var c = document.querySelector('canvas');
  if (!c) return true; // nothing to check yet
  var expectedW = Math.round(window.innerWidth * window.devicePixelRatio);
  var expectedH = Math.round(window.innerHeight * window.devicePixelRatio);
  if (c.width !== expectedW || c.height !== expectedH) {
    return 'canvas ' + c.width + 'x' + c.height +
           ' != window ' + expectedW + 'x' + expectedH;
  }
  return true;
});
```

Behaviour:

- Registered checks run on `resize` / `orientationchange` and once
  immediately at registration (so an already-violated invariant
  reports without waiting for a resize).
- A violation posts an `error`-level entry (kind `invariant`) to the
  dev console — it badges red like any other error. A check that
  throws is reported, never propagated.
- Failures are **debounced**: a check reports once when it starts
  failing and once when it recovers, not every tick.
- Requires the hosted bridge `<script>` (it lives in the bridge, not
  the vendored forwarder, so there's nothing to re-vendor). Add the
  bridge tag if your shell doesn't already load it.

## Issue-state snapshots — opt-in app state in filed issues

The bridge (see "Bridge") exposes an **opt-in** API for sharing a
debug snapshot of the app's internal state with the platform's
issue-submission flow. When an app registers a provider, the
platform's Send Feedback modal shows an "Include app state" checkbox
(checked by default) for issues targeting that app; at filing time the
platform asks the app for the snapshot and appends it to the GitHub
issue body in a collapsed `<details>` block, giving whoever works the
issue the app's actual runtime state. Fully **no-op by default**: an
app that registers nothing behaves exactly as before.

Register a provider once the bridge is loaded:

```js
usernode.issueState.register(function () {
  // Return a JSON-serializable object (or a Promise of one) with
  // whatever would help someone debug an issue in this app.
  return {
    view: currentView,
    settings: settings,
    itemsLoaded: items.length,
  };
});
```

`usernode.issueState.unregister()` clears the provider. Repeat
`register` calls replace it (last write wins).

Behaviour:

- The provider is called at issue-submit time and raced against a
  3-second timeout; a provider that throws, hangs, or returns
  non-serializable data simply means the issue is filed **without**
  state — it never blocks or fails the submission.
- The serialized snapshot is capped at **32 KB** (32,768 chars);
  oversized dumps are cut off and labeled truncated. Keep snapshots
  well under the cap — a compact, curated summary beats a raw dump.
- **Sanitization is the app's responsibility — snapshots land in
  PUBLIC GitHub issue bodies.** Never include credentials, tokens,
  secrets, or other users' data, and skip free-text user content
  unless it's clearly non-sensitive. Registering the provider IS the
  app's declaration that its snapshot is safe to publish.
- Requires the hosted bridge `<script>` and only works inside the
  platform shell (the app iframe); standalone pages register
  harmlessly.

## In-loop browser (build turns) — optional, encouraged

On a **build** turn (not scout/sync) Claude Code has a headless browser
available through the **Playwright MCP server** — `browser_navigate`,
`browser_console_messages`, `browser_take_screenshot`, and friends. It
lets the agent load the app it just edited and *see* the result —
catching a blank page, a JS crash on load, a broken layout, or a failing
API call that source-reading alone would miss — and fix it before
committing.

It is **optional and encouraged, never a gate.** Reach for it when a
change is user-visible and a visual check is genuinely informative; skip
it for backend-only / refactor / docs work where rendering tells you
nothing. Turns that don't use it behave exactly as before, and Chromium
only launches on the first browser tool call, so there's no cost when
it's unused. Scout and sync turns have no browser at all.

### Launch contract

The app must actually be running for the browser to load it. Boot it
locally inside the worker the same way a staging container does:

- **`USERNODE_ENV=staging`** against a **fresh, empty local database** —
  the build turn exposes `INLOOP_ENV`, `INLOOP_PORT`, and
  `INLOOP_DATABASE_URL` for exactly this. Typical launch:
  `USERNODE_ENV=$INLOOP_ENV PORT=$INLOOP_PORT DATABASE_URL=$INLOOP_DATABASE_URL node server.js &`
  (or this app's declared `dapp.json` entrypoint).
- Private secrets resolve from the manifest's `staging_default` /
  `default` only, same as a real staging build — never the prod store.
- Navigate to `http://127.0.0.1:$INLOOP_PORT` joined with the SAME
  route(s) you put in the TESTING block's `path:` lines. For the
  hash-routed self-app, put the route after the `#`.
- A **blank or empty page usually means missing seed data, not a bug** —
  the local DB starts empty. Add the `IS_STAGING` seed (or a `?demo=1`
  route) per "Staging mock data" and re-check, rather than "fixing"
  code that already works.
- Keep it tight (a couple of launch→check→fix cycles, a minute or two).
  **If the app won't boot** — no local Postgres, a missing required
  secret, a crash on start — don't fight it: note that you skipped the
  visual check and commit anyway. The in-loop browser must never block
  or fail the turn.

This is an agent-facing quality aid. The before/after screenshots and
the "Test this change" button (driven by the TESTING block) remain the
reviewer-facing tools and are unchanged.

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
