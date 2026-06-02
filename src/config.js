const REQUIRED = [
  'DATABASE_URL',
  'SESSION_SECRET',
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD',
  'JWT_SECRET',
];

// The platform appears as one row in `apps` with self_hosted=TRUE
// (Phase 2f boot seed). These two values pin the row's identity:
//   - SELF_APP_SLUG     — the apps.slug column; subdomain prefix for
//                         any future staging clone of the platform.
//   - SELF_APP_DB_NAME  — the per-app database that backs it. Same
//                         convention as child apps (`app_<slug>` with
//                         non-alphanumerics replaced by `_`), derived
//                         once and frozen so docker-compose.yml and
//                         the seed agree.
//
// The hex suffix exists only to avoid colliding with a hypothetical
// child app whose user-chosen slug happens to be 'usernode'. It was
// generated once via `crypto.randomBytes(3).toString('hex')` and is
// committed to history; never read from env, never overridable.
//
// See SELF-HOSTING.md sub-step 2d for the rename procedure.
const SELF_APP_SLUG = 'usernode-2d5619';
const SELF_APP_DB_NAME = 'app_usernode_2d5619';

function mask(val) {
  if (!val) return '(not set)';
  if (val.length <= 8) return '****';
  return val.slice(0, 4) + '...' + val.slice(-4);
}

function load() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`[config] Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  const config = {
    port: parseInt(process.env.PORT || '3000', 10),
    databaseUrl: process.env.DATABASE_URL,
    sessionSecret: process.env.SESSION_SECRET,
    adminUsername: process.env.ADMIN_USERNAME,
    adminPassword: process.env.ADMIN_PASSWORD,
    jwtSecret: process.env.JWT_SECRET,
    githubAppId: process.env.GITHUB_APP_ID || '',
    githubPrivateKey: (process.env.GITHUB_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    logLevel: process.env.LOG_LEVEL || 'INFO',
    // Hard cap on non-errored apps per server. Protects against runaway
    // container / DB creation chewing through host resources. Admins bypass
    // the cap; errored rows don't count (they hold ~no resources and users
    // can delete them to free a slot). See src/routes/apps.js.
    maxApps: parseInt(process.env.MAX_APPS || '20', 10),
    // Concurrency caps on dev sessions. A "session" holds (or can lazily
    // spawn) a warm worker container + optional staging container, so
    // these bound host resource fan-out. Previously hardcoded literals in
    // src/routes/sessions.js; lifted here so prod can tune them via env
    // without a code deploy. See the scaling notes in README / SPEC.
    //   - maxGlobalSessions: platform-wide active+promoted session ceiling.
    //   - maxUserSessions:   per-user active+promoted session ceiling.
    maxGlobalSessions: parseInt(process.env.MAX_GLOBAL_SESSIONS || '25', 10),
    maxUserSessions: parseInt(process.env.MAX_USER_SESSIONS || '3', 10),
    // Per-session worker container resource limits, passed to `docker run`
    // by src/services/worker.js. Defaults preserve historical behavior;
    // shrink them in prod to fit more concurrent warm workers on one box.
    workerMemory: process.env.WORKER_MEMORY || '2g',
    workerCpus: process.env.WORKER_CPUS || '2',
    // Postgres connection pool size (pg `Pool.max`). pg's built-in default
    // is 10, which can bottleneck under many concurrent SSE turns + staging
    // DB work. Tunable via env so prod can widen it without a code change.
    dbPoolMax: parseInt(process.env.DB_POOL_MAX || '10', 10),
    // Session auto-pause: a DB-driven sweeper (server.js) flips long-idle
    // 'active' sessions to 'paused' so they stop counting against the
    // session caps. This is a SEPARATE, longer timer from the in-memory
    // worker idle-eviction (WORKER_IDLE_EVICTION_MS) — eviction reclaims
    // the container RAM; auto-pause frees the cap slot. Default 2h. Set
    // sessionAutopauseIdleMs=0 to disable auto-pause entirely.
    sessionAutopauseIdleMs: parseInt(process.env.SESSION_AUTOPAUSE_IDLE_MS || String(2 * 60 * 60 * 1000), 10),
    // How often the session sweeper scans for idle sessions.
    sessionSweepIntervalMs: parseInt(process.env.SESSION_SWEEP_INTERVAL_MS || '60000', 10),
    // When a user at their session cap reopens/resumes a paused session,
    // auto-pause their least-recently-active session to make room instead
    // of refusing with a 429. Set SESSION_LRU_ON_RESUME=false to keep the
    // old hard-cap behavior.
    sessionLruOnResume: process.env.SESSION_LRU_ON_RESUME !== 'false',
    usernodeAppPubkey: process.env.USERNODE_APP_PUBKEY || '',
    // Default points at the sidecar usernode container that
    // docker-compose.yml runs alongside the platform (service name
    // `usernode-node`). Production injects NODE_RPC_URL explicitly so
    // this default only matters for local dev and ad-hoc runs; pointing
    // it at the sidecar pattern (rather than a public host that may
    // come and go) keeps the failure mode obvious — "no node reachable
    // at <name>" is clearly a setup issue, not a transient outage.
    nodeRpcUrl: process.env.NODE_RPC_URL || 'http://usernode-node:3000',
    // GitHub URL of the platform's own repo. Read by feedback (file
    // issues here), the import-flow guard (refuse to import the self-
    // repo as a child app), and the self-app boot seed (Phase 2f).
    // Default targets the canonical Usernode-Labs repo; forks self-
    // hosting under their own org just need to override this in .env.
    platformRepoUrl: (process.env.USERNODE_PLATFORM_REPO || 'https://github.com/Usernode-Labs/social-vibecoding').replace(/\/$/, ''),
    selfAppSlug: SELF_APP_SLUG,
    selfAppDbName: SELF_APP_DB_NAME,
    // SELF-HOSTING.md Phase 4: in-app vote-to-merge for the self-
    // app. ON by default — all authenticated users can see the self-
    // app row, list its promoted PRs, and cast votes via the existing
    // PR voting UI. Set SELF_APP_PUBLIC_VOTING=false to restrict
    // visibility back to admins only. All the other self-hosting
    // protections (2g rebuild skip, 2h secrets read-only-write-
    // protection, 2i Mayor refuse-list, 2k import block) stay in
    // place; this flag is purely about audience.
    selfAppPublicVoting: process.env.SELF_APP_PUBLIC_VOTING !== 'false',
  };

  console.log('[config] Loaded:');
  console.log(`  DATABASE_URL=${mask(config.databaseUrl)}`);
  console.log(`  JWT_SECRET=${mask(config.jwtSecret)}`);
  console.log(`  GITHUB_APP_ID=${config.githubAppId || '(not set)'}`);
  console.log(`  ANTHROPIC_API_KEY=${mask(config.anthropicApiKey)}`);
  console.log(`  LOG_LEVEL=${config.logLevel}`);
  console.log(`  MAX_APPS=${config.maxApps}`);
  console.log(`  MAX_GLOBAL_SESSIONS=${config.maxGlobalSessions}`);
  console.log(`  MAX_USER_SESSIONS=${config.maxUserSessions}`);
  console.log(`  WORKER_MEMORY=${config.workerMemory} WORKER_CPUS=${config.workerCpus}`);
  console.log(`  DB_POOL_MAX=${config.dbPoolMax}`);
  console.log(`  SESSION_AUTOPAUSE_IDLE_MS=${config.sessionAutopauseIdleMs}${config.sessionAutopauseIdleMs === 0 ? ' (disabled)' : ''}`);
  console.log(`  SESSION_SWEEP_INTERVAL_MS=${config.sessionSweepIntervalMs}`);
  console.log(`  SESSION_LRU_ON_RESUME=${config.sessionLruOnResume}`);
  console.log(`  USERNODE_APP_PUBKEY=${config.usernodeAppPubkey || '(not set — wallet linking disabled)'}`);
  console.log(`  NODE_RPC_URL=${config.nodeRpcUrl}`);
  console.log(`  USERNODE_PLATFORM_REPO=${config.platformRepoUrl}`);
  console.log(`  SELF_APP_SLUG=${config.selfAppSlug} (db=${config.selfAppDbName})`);
  console.log(`  SELF_APP_PUBLIC_VOTING=${config.selfAppPublicVoting} (Phase 4: ${config.selfAppPublicVoting ? 'enabled — all users can see + vote on self-app PRs' : 'disabled — self-app is admin-only'})`);

  return config;
}

module.exports = { load };
