# Building apps on Usernode

This guide is the starting point for people building a Usernode app. It
orients you to the supported scaffold, configuration model, staging behavior,
and the Usernode ledger connection. It does not replace the runtime contract:
[`src/prompts/app-conventions.md`](../src/prompts/app-conventions.md) is the
authoritative repository copy and is served by a running platform at
`/claude.md`. App-authoring agents receive those conventions automatically;
local contributors should read the hosted copy before changing an app.

## Choose a starting point

There are two supported ways to begin:

1. Create an app in Usernode. The platform generates the minimal Express,
   Postgres, Docker, auth, `dapp.json`, and `CLAUDE.md` scaffold from
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
compatibility alias that new code must not read.

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

## On-chain ledger work

`NODE_RPC_URL` is the app's route to the Usernode node. Do not hard-code the
production sidecar hostname or the local Docker hostname: the platform chooses
the correct value for each environment.

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

## Before proposing a change

1. Read the current `/claude.md` (or this repository's
   `app-conventions.md`) and the app's own `CLAUDE.md`.
2. Decide whether each new value belongs in injected runtime config, app
   `dapp.json`, or the platform's `platform_env`.
3. Apply the private/staging decision before writing a secret declaration.
4. Make changed screens URL-reachable and add a matching `dapp.json` proposal
   test so reviewers can exercise the staged result.
5. Never put credentials in source code, a README example, test fixtures, or
   a proposal transcript.
