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

app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});
```

Key properties:

- `req.user` contains at minimum `{ id, username }` once authenticated.
- All non-GET requests + all `/api/*` requests are **deny-by-default**.
- To intentionally expose an API route without auth, add its exact
  path to `PUBLIC_API_PATHS`. Do **not** remove the middleware.
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
