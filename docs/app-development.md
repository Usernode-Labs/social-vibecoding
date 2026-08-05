# Building apps on Usernode

This guide is the starting point for people building a Usernode app. It
orients you to the supported scaffold, configuration model, data services,
staging behavior, browser bridge, and Usernode ledger connection. It does not
replace the runtime contract:
[`src/prompts/app-conventions.md`](../src/prompts/app-conventions.md) is the
authoritative repository copy and is served by a running platform at
`/claude.md`. App-authoring agents receive those conventions automatically;
local contributors should read the hosted copy before changing an app.

The scaffold and hosted platform APIs evolve. When an older app differs from
an example here, compare it with the current
[`src/services/template.js`](../src/services/template.js) and conventions
before copying files or compatibility aliases into new code.

## Choose a starting point

There are two supported ways to begin:

1. Create an app in Usernode. The platform generates an Express, Postgres,
   Docker, auth, frontend, `dapp.json`, and `CLAUDE.md` scaffold from
   `src/services/template.js`.
2. Start from the canonical `usernode-dapp-starter` repository when you need
   its maintained examples and shared files. Its vendored shared files are
   documented in [App conventions: Vendored shared files](../src/prompts/app-conventions.md#vendored-shared-files).

The following maintained apps are useful references for conventions already
in production: `usernode-echo-dapp`, `usernode-last-one-wins-dapp`,
`usernode-opinion-market-dapp`, `usernode-falling-sands-dapp`,
`usernode-feedback-hub`, and `usernode-group-chat-dapp-test`. Treat each as
an example of a particular product, not as a second source of platform rules.
If a shared vendored file needs a cross-app change, update its canonical source
in `usernode-dapp-starter` and re-vendor it; do not patch one consumer copy.

## Know which configuration file is for which job

| Surface | Use it for | Do not use it for |
| --- | --- | --- |
| `dapp.json` in an app repo | Declaring the app's runtime configuration, display metadata, and proposal tests | Storing production secrets in Git |
| App **Secrets** UI | Storing the values declared by an app's `dapp.json` | Declaring platform-owned runtime variables |
| `platform_env` in this platform repo's `dapp.json` | Declaring tunables read by the self-hosted platform process | Child-app container variables |
| `.env.example` | The official template for this platform's self-hosted/local deployment | A child app's secrets template |
| `src/prompts/app-conventions.md` / `/claude.md` | The current runtime and security contract for all apps | App-specific product decisions |

`.env.example` is official: copy it to `.env` when setting up this platform
locally or self-hosting it, then fill in deployment values as described in the
README. It is intentionally **not** copied into child apps. A child app uses
its `dapp.json` declaration and the app Secrets UI instead.

## Runtime variables that every app receives

The platform injects these values into every child-app container. Do not put
them in `dapp.json`, and do not supply replacements from application code:

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Connection string for this app's isolated Postgres database. |
| `USERNODE_JWT_PUBLIC_KEY` | RSA public key used to verify the platform-issued iframe identity token. |
| `USERNODE_APP_ID` | Numeric app id; use it in the token audience `usernode:app:<id>`. |
| `PORT` | Container listen port (`3000`). |
| `USERNODE_ENV` | `staging` or `production`; use it for data and side-effect boundaries, never feature availability. |
| `NODE_RPC_URL` | Platform-supplied Usernode node RPC URL. It is available even when omitted from `dapp.json`. |

New code must use `USERNODE_JWT_PUBLIC_KEY`, pin JWT verification to `RS256`,
issuer `usernode`, and the app-specific audience. `JWT_SECRET` is a retired
compatibility alias that new code must not read. `IFRAME_JWT_PUBLIC_KEY` is
also injected for the platform's own staging compatibility; ordinary apps
must use `USERNODE_JWT_PUBLIC_KEY`. Both names stay reserved and must not be
declared in an app manifest.

Some capabilities add production-only variables. LLM access adds
`USERNODE_LLM_PROXY_*`, server-mediated file storage adds
`USERNODE_STORAGE_*`, and the app governance feed adds
`USERNODE_PLATFORM_API_*`. These families are reserved, absent from staging,
and must be feature-detected rather than declared. The browser bridge remains
the staging-capable path for user-mediated LLM consent and file uploads. See
[App LLM access](../src/prompts/app-conventions.md#app-llm-access--the-platform-claude-proxy),
[App file storage](../src/prompts/app-conventions.md#app-file-storage--user-uploaded-images),
and [App governance feed](../src/prompts/app-conventions.md#app-governance-feed--the-apps-own-proposalvotemerge-activity).

## Declare app configuration in `dapp.json`

Declare only values an app actually needs beyond platform injection. The
platform rereads the manifest for creation, staging builds, and production
deploys; it then renders the declaration in the Secrets UI.

```json
{
  "secrets": [
    {
      "key": "MAPS_PUBLIC_TOKEN",
      "description": "Public browser token for the maps project",
      "required": false,
      "default": ""
    },
    {
      "key": "PAYMENT_PROVIDER_SECRET",
      "description": "Live server credential for the payment provider",
      "required": true,
      "private": true,
      "staging_default": "test-only-placeholder"
    }
  ]
}
```

- `key` must be `UPPER_SNAKE_CASE`; `description` must tell an admin what
  the value is and how to obtain it.
- `required: true` means a missing value blocks deployment. Use it only when
  the app cannot safely start without the value.
- A stored value takes precedence over a platform-managed default, which in
  turn takes precedence over a manifest `default`. Do not commit real
  credentials as a `default`.
- `private: true` encrypts the stored value and redacts it from API responses.
  It also prevents a production value from entering a staging container.
- A required private entry must have a safe committed `staging_default` (or
  `default`), otherwise staging fails intentionally. Test credentials are
  still credentials and should remain `private: true`.
- `sensitive: true` remains accepted for old manifests, but new code should
  use `private: true`.

The manifest also owns repo-reviewed app metadata and review behavior. Use
the detailed contract rather than guessing a field shape:

| Field | Purpose |
| --- | --- |
| `name`, `icon` | Display name and homescreen icon reconciled at deployment. |
| `visibility`, `admins`, `governance` | Build/view access and proposal approval policy. |
| `llm` | User-facing purpose and suggested daily cap for an app's LLM grant. |
| `tests` | URL-reachable proposal checks, including optional selector/text assertions. |
| `screenshot.deviceScaleFactor` | Proposal screenshot capture scale. |

See the [`dapp.json` contract](../src/prompts/app-conventions.md#per-app-secrets--dappjson)
and [`app-manifest.js`](../src/services/app-manifest.js), the executable parser.

`DATABASE_URL`, `USERNODE_JWT_PUBLIC_KEY`, `USERNODE_APP_ID`, `JWT_SECRET`,
`PORT`, `USERNODE_ENV`, and `USERNODE_MISSING_SECRETS` are reserved. The
platform rejects them from an app manifest so an app cannot shadow its own
runtime contract. `NODE_RPC_URL` is optional to declare because the platform
injects it automatically; a declaration can provide a standalone fallback.

For the self-hosted platform itself, new process tunables go under its
top-level `platform_env` block—not `secrets`. Deploy-owned identity,
database, and credential values may be documented there but stay read-only.
See [the platform configuration section](../src/prompts/app-conventions.md#editing-the-platform-itself--platform_env-not-secrets)
for the complete rule.

## Keep identity, wallet authority, and the browser bridge separate

The iframe JWT identifies the signed-in platform user to the app server. The
frontend forwards the initial `?token=...` value on API requests as
`x-usernode-token`; the server verifies it and uses `req.user.id` /
`req.user.username` for ownership checks. The `usernode_pubkey` claim is a
linked public address, not signing authority. Never accept it, a username, or
a client-supplied `user_id` as proof that a transaction was approved.

Wallet and platform-owned browser actions use the centrally hosted
`usernode-bridge/v1/bridge.js`. Load it from the platform; do not vendor it.
The bridge chooses the supported native, iframe-relay, local-mock, or desktop
QR path while the wallet keeps private key material outside the app. The
current authentication middleware and token-forwarding example live in
[Auth — iframe token injection](../src/prompts/app-conventions.md#auth--iframe-token-injection),
and bridge rollout/versioning rules live in
[Bridge — centrally hosted](../src/prompts/app-conventions.md#bridge--centrally-hosted-not-vendored).

## Database migrations, privacy, and files

Each app has an isolated Postgres database. Apply schema changes idempotently
at boot using `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF
NOT EXISTS`; use one shared `pg.Pool` backed by `DATABASE_URL`. Store the
verified `req.user.id` or username with user-owned rows and enforce ownership
again in every read/write query.

Staging begins from a copy of production data. Tables are public to staging by
default. Mark a table containing DMs, credentials, financial records, or
non-public personal data in the same migration:

```sql
COMMENT ON TABLE direct_messages IS 'staging:private';
```

Private tables are copied schema-only and may receive small, obviously fake,
idempotent staging seeds. A public table cannot reference a private table with
a foreign key. Follow the complete
[public/private table decision tree](../src/prompts/app-conventions.md#public-vs-private-tables--important)
instead of treating the staging copy as a backup or a privacy boundary.

Do not store uploads on a container filesystem: deploys and container
replacement make it ephemeral. For user-selected images use
`usernode.uploadFile()` through the bridge; for production-only moderation or
server-mediated flows, feature-detect the injected `USERNODE_STORAGE_*`
service. Store returned ids/URLs in the app database. The supported types,
quotas, visibility rules, deletion behavior, and staging quarantine are in
[App file storage](../src/prompts/app-conventions.md#app-file-storage--user-uploaded-images).

## Staging mocks and real behavior

Staging is a review environment for the same product behavior that will run
in production. `USERNODE_ENV` may change data sources and prevent irreversible
outbound effects, but it must not make a feature, permission rule, or core
logic exist only in staging.

Use staging-only mock data for new tables, private tables, or states that are
otherwise hard to reach. Make it small, visibly fake, idempotent, and tied to
a testable URL. For email, payment, webhook, and on-chain boundaries, run the
same validation and app workflow but use a sandbox endpoint or a no-op instead
of performing a real-world side effect. A mock wallet, balance, or ledger path
is an explicit testing tool—not the silent default that a reviewer approves.

## On-chain ledger and wallet work

`NODE_RPC_URL` is the app's route to the Usernode node. Do not hard-code the
production sidecar hostname or the local Docker hostname: the platform chooses
the correct value for each environment.

Choose the narrowest supported surface:

- Browser UI that needs an address, a user-approved send, transaction reads,
  or message signing uses the hosted bridge (`getNodeAddress()`,
  `sendTransaction()`, `getTransactions()`, and `signMessage()`). A send may
  use native confirmation, local mock endpoints, or a desktop QR flow; code
  must handle rejection, timeout, and a submitted-but-not-yet-included result.
- Server code that genuinely needs raw node RPC uses `NODE_RPC_URL`. It must
  validate responses, tolerate node unavailability, and must not move a
  user's signing key into an app secret to replace the bridge approval flow.
- The platform's `/api/v4` Topochain routes are a separate product API for
  standings, seasons, mobile, partner, ingest, and admin operations. They are
  not a generic child-app ledger client and their auth groups are deliberately
  different. Public reads may be used intentionally; never copy partner,
  ingest, mobile, or admin credentials into browser code. The route/auth map
  is documented in
  [`SELF-HOSTING.md`](../SELF-HOSTING.md#topochain-apiv4-operations), with
  executable handlers under [`src/routes/topochain/`](../src/routes/topochain/).

For local development that needs authoritative recent-transaction processing,
run a full ledger before starting the platform:

```bash
make node-full
make up
```

`make node-full` refreshes and loads the archive snapshot, then starts the
node with its full UTXO state. This is the supported local path because a
partial-ledger node can lack source information for recent transactions from
untracked senders; child-app transaction handlers can therefore drop those
events. A partial node is not a valid substitute when the feature's correctness
depends on authoritative chain history or transaction attribution.

Treat all on-chain sends as real-world side effects. Keep signing keys private,
give staging a safe test value or no-op boundary, and make the exact review
path reachable without broadcasting a real transaction. Validate normal UI and
database behavior in staging; exercise real funds only through an explicitly
chosen, appropriately funded environment.

## Contract versions and deprecations

- `/usernode-bridge/v1/` is a platform-owned major contract. Additive fixes
  may ship within v1; incompatible changes require a new major URL while v1
  remains available during migration. Never pin a copied bridge file.
- The native UI kit follows the same centrally hosted versioning model. The
  current scaffold/frontend asset strategy can change independently; consult
  the current template before migrating an older app.
- `JWT_SECRET` is an injected legacy verification alias and `sensitive` is a
  parsed legacy alias for `private`. They are compatibility promises for old
  apps, not names to introduce in new code.
- Treat the repository's app conventions and executable parser/bridge as the
  source of truth. If documentation and code disagree, stop and report the
  platform-level mismatch rather than depending on undocumented behavior.

## Before proposing a change

1. Read the current `/claude.md` (or this repository's
   `app-conventions.md`) and the app's own `CLAUDE.md`.
2. Decide whether each new value belongs in injected runtime config, app
   `dapp.json`, or the platform's `platform_env`.
3. Apply the private/staging decision before writing a secret declaration.
4. Classify new tables public/private, make migrations repeat-safe, and keep
   durable uploads off the container filesystem.
5. Separate verified app identity from wallet approval; test cancellations,
   unavailable bridges/nodes, and pending transaction states.
6. Make changed screens URL-reachable and add a matching `dapp.json` proposal
   test so reviewers can exercise the staged result.
7. Never put credentials in source code, a README example, test fixtures, or
   a proposal transcript.
