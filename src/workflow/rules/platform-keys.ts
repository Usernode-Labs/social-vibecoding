// Which environment-variable names the platform owns. Read by the manifest
// (services/app-manifest.js re-exports these), the platform-variable DAO
// and the workflow machines, which refuse a vote to write an unwritable key.
// services/platform-env-check.js reads a branch's copy of these lists as
// TEXT, never by loading it, so each stays a plain `= new Set([...])` or
// `= [...]` literal of quoted keys.

// Reserved keys the platform owns. A manifest entry using one of these
// is rejected on read so a dapp can't shadow / spoof the platform-injected
// values that all dapps depend on.
export const RESERVED_KEYS = new Set([
  'DATABASE_URL',
  // The RS256 public key user tokens are verified against, and the app's
  // own integer id (the audience the platform mints for). Reserved for the
  // same reason as JWT_SECRET: a manifest that shadowed either could point
  // the container's verifier at an attacker-controlled key or make it
  // accept identities minted for a different app.
  'USERNODE_JWT_PUBLIC_KEY',
  'USERNODE_APP_ID',
  // The public half guest tokens are verified against (P15): shadowing it
  // would let a manifest point the container at a key of its choosing.
  'USERNODE_GUEST_JWT_PUBLIC_KEY',
  // Retired alias of USERNODE_JWT_PUBLIC_KEY (holds the same public PEM),
  // still injected so pre-cutover scaffolds verify unchanged. The
  // RESERVATION OUTLIVES THE INJECTION: even after app-identity-env.js
  // stops setting this name (see the removal criterion there), a manifest
  // must never be able to introduce it — an app that still reads
  // JWT_SECRET would then be handed an attacker-chosen verification key.
  'JWT_SECRET',
  // Same public PEM again, under the platform's own env-var name — see
  // services/app-identity-env.js. Reserved for the same reason.
  'IFRAME_JWT_PUBLIC_KEY',
  'PORT',
  'USERNODE_ENV',
  'USERNODE_MISSING_SECRETS',
  'USERNODE_LLM_PROXY_URL',
  'USERNODE_LLM_PROXY_TOKEN',
  'USERNODE_STORAGE_URL',
  'USERNODE_STORAGE_TOKEN',
  'USERNODE_PLATFORM_API_URL',
  'USERNODE_PLATFORM_API_V1_URL',
  // The platform's public origin (services/app-identity-env.js). Reserved
  // for the same reason as the rest: a manifest that shadowed it could
  // point an app's "Open in Homeroom" links at a host of its choosing.
  'USERNODE_PLATFORM_ORIGIN',
  // Turns phone sign-in's test numbers on (config.js
  // shotsPhoneTestCodeFrom). Only the platform puts it on a before & after
  // shots copy (services/shots-environment.js); a manifest that set it would
  // turn them on for an ordinary staging preview.
  'SHOTS_PHONE_TEST_CODE',
]);

// Reserved prefixes for the LLM-proxy (issue #34), app-storage (#752),
// and app-platform-API (#744) env-var families — any future
// USERNODE_LLM_PROXY_* / USERNODE_STORAGE_* / USERNODE_PLATFORM_API_*
// addition stays platform-owned without another set entry.
export const RESERVED_KEY_PREFIXES = ['USERNODE_LLM_PROXY', 'USERNODE_STORAGE', 'USERNODE_PLATFORM_API'];

export const KEY_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

// platform_env: the platform's own environment-variable manifest (see
// services/app-manifest.js).

// Keys that may be *declared* (so the admin console can show them and the
// pre-merge check can reason about them) but can NEVER be written through
// the admin UI or resolved from the platform_env store at deploy time.
// These are the platform's structural identity and credentials: they are
// injected by .github/workflows/deploy.yml straight from GitHub secrets,
// or computed by the deploy itself. Letting an admin overwrite one from a
// web form would be a privilege-escalation path (rotate JWT_SECRET →
// forge any session; rewrite DATABASE_URL → point the platform at an
// attacker's Postgres), so writes are refused at the DAO, the route, and
// the UI. Declaring one is fine and useful: it documents the variable.
export const PLATFORM_ENV_UNWRITABLE = new Set([
  // Reserved / structural.
  'DATABASE_URL',
  'PORT',
  'USERNODE_ENV',
  'GIT_SHA',
  // Auth + session crypto.
  //
  // DATA_ENCRYPTION_KEY is the load-bearing one: services/secrets.js
  // derives its AES-256-GCM key from it, and platform_env_values.value_enc
  // is itself encrypted with it. A console-settable data key is therefore
  // circular — the store would need the key to read the key — and changing
  // the value silently orphans every BYOK key and app secret at rest
  // (decrypt() returns null; nothing throws). It can only come from the
  // deploy.
  //
  // The other four are signing keys: rewriting one from a web form would
  // let an admin mint app identities, worker tokens or edge cookies at
  // will. JWT_SECRET no longer signs anything in the platform process, but
  // the deploy's own secret of that name still holds the same bytes as
  // DATA_ENCRYPTION_KEY, so it stays listed too. (The JWT_SECRET a child
  // container receives is a different thing entirely — the RSA public
  // PEM, injected by services/app-identity-env.js.)
  'DATA_ENCRYPTION_KEY',
  'IFRAME_JWT_PRIVATE_KEY',
  'IFRAME_JWT_PUBLIC_KEY',
  'WORKER_JWT_SECRET',
  'EDGE_JWT_SECRET',
  'JWT_SECRET',
  'SESSION_SECRET',
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD',
  // Database and GitHub App credentials.
  'USERNODE_DB_PASSWORD',
  'GITHUB_APP_ID',
  'GITHUB_PRIVATE_KEY',
  'GITHUB_BOT_TOKEN',
  // Model access and the platform's own dapp keypair.
  'ANTHROPIC_API_KEY',
  // OpenRouter organization-level credential. This may create, disable and
  // delete child keys, so it is deploy-owned and can never be entered in the
  // platform-variable UI.
  'OPENROUTER_MANAGEMENT_API_KEY',
  'USERNODE_APP_PUBKEY',
  'USERNODE_APP_SECRET_KEY',
  // Ingress / TLS, owned by the Caddy half of the deploy.
  'USERNODE_DOMAIN',
  'USERNODE_APPS_DOMAIN',
  'ZEROSSL_API_KEY',
  'ZEROSSL_EAB_KID',
  'ZEROSSL_EAB_HMAC',
  'ACME_DNS_PROVIDER',
  'ACME_DNS_API_TOKEN',
]);
