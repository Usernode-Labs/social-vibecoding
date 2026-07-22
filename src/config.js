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
    maxApps: parseInt(process.env.MAX_APPS || '50', 10),
    // Concurrency caps on dev sessions. A "session" holds (or can lazily
    // spawn) a warm worker container + optional staging container, so
    // these bound host resource fan-out. Previously hardcoded literals in
    // src/routes/sessions.js; lifted here so prod can tune them via env
    // without a code deploy. See the scaling notes in README / SPEC.
    //   - maxGlobalSessions: platform-wide active+promoted session ceiling.
    //   - maxUserSessions:   per-user ceiling on 'active'-status sessions
    //     only (#193). Promoted sessions are exempt: they're un-pausable
    //     while their PR is up for a merge vote, so counting them would
    //     leave the user no way to free a slot by pausing.
    //   - maxUserPromotedSessions: per-user ceiling on concurrently
    //     promoted PRs, checked at promote time. Promoted sessions don't
    //     count toward maxUserSessions, so this is the bound that keeps
    //     one user from papering the vote panel (and holding N staging
    //     previews) with open PRs.
    maxGlobalSessions: parseInt(process.env.MAX_GLOBAL_SESSIONS || '25', 10),
    maxUserSessions: parseInt(process.env.MAX_USER_SESSIONS || '3', 10),
    maxUserPromotedSessions: parseInt(process.env.MAX_USER_PROMOTED_SESSIONS || '5', 10),
    // Per-session worker container resource limits, passed to `docker run`
    // by src/services/worker.js. Defaults preserve historical behavior;
    // shrink them in prod to fit more concurrent warm workers on one box.
    workerMemory: process.env.WORKER_MEMORY || '2g',
    workerCpus: process.env.WORKER_CPUS || '2',
    // Token-optimization step 6: per-dispatch Claude Code run ceilings.
    // Threaded into run-cc.sh via `docker exec -e` (worker.execInWorker)
    // as MAX_TURNS / RUN_TIMEOUT_S / COST_CEILING_CENTS. Builds get
    // generous room; scouts (read-only spec drafts) are capped tighter
    // so a runaway read-only sweep can't burn a whole budget. A limit hit
    // still commits/pushes partial work and reports limit_hit= on the
    // result line. 0 disables a given ceiling. Cost ceiling is enforced
    // platform-side (worker.js) off the run's reported cost.
    ccBuildMaxTurns: parseInt(process.env.CC_BUILD_MAX_TURNS || '100', 10),
    ccScoutMaxTurns: parseInt(process.env.CC_SCOUT_MAX_TURNS || '50', 10),
    ccBuildTimeoutS: parseInt(process.env.CC_BUILD_TIMEOUT_S || '1800', 10),
    ccScoutTimeoutS: parseInt(process.env.CC_SCOUT_TIMEOUT_S || '900', 10),
    ccBuildCostCents: parseInt(process.env.CC_BUILD_COST_CENTS || '1200', 10),
    ccScoutCostCents: parseInt(process.env.CC_SCOUT_COST_CENTS || '500', 10),
    // Postgres connection pool size (pg `Pool.max`). pg's built-in default
    // is 10, which can bottleneck under many concurrent SSE turns + staging
    // DB work. Tunable via env so prod can widen it without a code change.
    dbPoolMax: parseInt(process.env.DB_POOL_MAX || '10', 10),
    // Session auto-pause: a DB-driven sweeper (server.js) flips idle
    // 'active' sessions to 'paused' so they stop counting against the
    // session caps. Now that pause is cheap (it no longer tears down
    // staging — see session-lifecycle.js) and activity is kept fresh by
    // the dev-chat heartbeat while the tab is open, this is tuned to
    // line up with the worker idle-eviction timescale (~5 min). A
    // session pauses ~5 min after the user actually leaves (tab closed/
    // backgrounded → no more heartbeats). Set to 0 to disable.
    sessionAutopauseIdleMs: parseInt(process.env.SESSION_AUTOPAUSE_IDLE_MS || String(5 * 60 * 1000), 10),
    // Staging preview GC: pause no longer tears staging down, so this
    // sweeper reclaims the staging container + cloned DB from sessions
    // that have gone cold for this long (promoted/merging sessions are
    // exempt — their preview backs group voting). Much longer than the
    // pause timer so reopening a recently-paused session keeps a warm
    // preview. Default 6h; set to 0 to disable staging GC.
    stagingIdleTeardownMs: parseInt(process.env.STAGING_IDLE_TEARDOWN_MS || String(6 * 60 * 60 * 1000), 10),
    // How often the session sweeper scans for idle sessions.
    sessionSweepIntervalMs: parseInt(process.env.SESSION_SWEEP_INTERVAL_MS || '60000', 10),
    // Production app-container watchdog (services/app-heal.js, #426):
    // sweeps every appHealIntervalMs for status='running' apps whose
    // `usernode-app-<slug>` container is stopped or missing and restarts
    // (or rebuilds) them automatically. 0 disables the sweep entirely.
    // appHealCooldownMs bounds retry churn per app — a persistently
    // failing heal (crash-loop on bad code, missing required secret)
    // isn't retried more often than this.
    appHealIntervalMs: parseInt(process.env.APP_HEAL_INTERVAL_MS || '60000', 10),
    appHealCooldownMs: parseInt(process.env.APP_HEAL_COOLDOWN_MS || String(10 * 60 * 1000), 10),
    // When a user at their session cap reopens/resumes a paused session,
    // auto-pause their least-recently-active session to make room instead
    // of refusing with a 429. Set SESSION_LRU_ON_RESUME=false to keep the
    // old hard-cap behavior.
    sessionLruOnResume: process.env.SESSION_LRU_ON_RESUME !== 'false',
    // Stale-promoted-PR policy. A PR proposed to the group ('promoted')
    // is otherwise sticky — it never auto-pauses and holds a cap slot
    // forever. This sweeper warns the author after prStaleNotifyMs of no
    // voting interest, then auto-archives prStaleGraceMs later if still
    // untouched. Set prStaleNotifyMs=0 to disable the whole policy.
    prStaleNotifyMs: parseInt(process.env.PR_STALE_NOTIFY_MS || String(7 * 24 * 60 * 60 * 1000), 10),
    prStaleGraceMs: parseInt(process.env.PR_STALE_GRACE_MS || String(3 * 24 * 60 * 60 * 1000), 10),
    // Reversible-archive retention. Archive keeps the CC volume + branch
    // so /unarchive can restore a session; this is how long before a hard
    // GC destroys the CC volume (memory). The row + branch survive, so
    // unarchive still works afterward but Claude starts fresh. Set to 0
    // to keep CC volumes forever (no hard GC).
    archivedRetentionMs: parseInt(process.env.ARCHIVED_RETENTION_MS || String(30 * 24 * 60 * 60 * 1000), 10),
    // How often the stale-PR / archived-GC sweeper runs. These actions
    // are day-scale, so it polls infrequently. Default 1h.
    staleSweepIntervalMs: parseInt(process.env.STALE_SWEEP_INTERVAL_MS || String(60 * 60 * 1000), 10),
    // Demand-driven global-cap eviction. When a new session is needed but
    // the platform is at maxGlobalSessions, we pause the globally least-
    // recently-active session that has been idle longer than this grace
    // window (and isn't mid-turn), freeing a slot immediately instead of
    // making the new user wait for the slow 2h auto-pause. The grace
    // window protects anyone who's actually working — only sessions idle
    // past it are eligible. If nothing qualifies, the request 429s.
    // Default 15 min; set to 0 to disable pressure-eviction (back to a
    // hard 429 at the global cap).
    sessionPressureGraceMs: parseInt(process.env.SESSION_PRESSURE_GRACE_MS || String(15 * 60 * 1000), 10),
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
    // The platform's own container name on the shared docker network.
    // Child apps run as `usernode-app-<slug>`, but the platform itself is
    // the compose service `container_name: usernode` (docker-compose.yml)
    // — the before/after capture pipeline (services/visuals.js) needs this
    // to shoot a real "before" of the production platform for self-app
    // sessions. Overridable for forks whose compose names differ.
    selfAppContainer: process.env.SELF_APP_CONTAINER || 'usernode',
    // SELF-HOSTING.md Phase 4: in-app vote-to-merge for the self-
    // app. ON by default — all authenticated users can see the self-
    // app row, list its promoted PRs, and cast votes via the existing
    // PR voting UI. Set SELF_APP_PUBLIC_VOTING=false to restrict
    // visibility back to admins only. All the other self-hosting
    // protections (2g rebuild skip, 2h secrets read-only-write-
    // protection, 2i Mayor refuse-list, 2k import block) stay in
    // place; this flag is purely about audience.
    selfAppPublicVoting: process.env.SELF_APP_PUBLIC_VOTING !== 'false',
    // #687 (PR-import): master off-by-default switch for importing an
    // existing GitHub PR as a proposal. OFF unless PR_IMPORT_ENABLED=true.
    // Slice 1 only adds the schema/config/clone-fix foundations behind
    // this flag; the routes, rendering, poller and exact-SHA merge in
    // later slices are all gated on it, so merging the feature changes
    // nothing observable until an operator flips this on (safe to test
    // in a staging preview first, then leave off in prod until sign-off).
    prImportEnabled: process.env.PR_IMPORT_ENABLED === 'true',
    // #687 Slice 6: opt-in mock-GitHub adapter. When ON, the PR-import
    // candidates/preview/import routes, the sync poller, and the imported
    // merge path read from an explicit in-memory fake GitHub source (backed
    // by the staging fixtures) instead of the real github.js client — so the
    // full create → head-change → merge-409 flow is clickable in a preview
    // with no real GitHub credentials. Separate opt-in from PR_IMPORT_ENABLED;
    // default OFF everywhere, so production always uses the real client. Never
    // gated on USERNODE_ENV in code — only the manifest value differs
    // (dapp.json ships staging_default:"true", default:"false").
    prImportMockGithub: process.env.PR_IMPORT_MOCK_GITHUB === 'true',
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
  console.log(`  MAX_USER_PROMOTED_SESSIONS=${config.maxUserPromotedSessions}`);
  console.log(`  WORKER_MEMORY=${config.workerMemory} WORKER_CPUS=${config.workerCpus}`);
  console.log(`  DB_POOL_MAX=${config.dbPoolMax}`);
  console.log(`  SESSION_AUTOPAUSE_IDLE_MS=${config.sessionAutopauseIdleMs}${config.sessionAutopauseIdleMs === 0 ? ' (disabled)' : ''}`);
  console.log(`  STAGING_IDLE_TEARDOWN_MS=${config.stagingIdleTeardownMs}${config.stagingIdleTeardownMs === 0 ? ' (disabled)' : ''}`);
  console.log(`  SESSION_SWEEP_INTERVAL_MS=${config.sessionSweepIntervalMs}`);
  console.log(`  APP_HEAL_INTERVAL_MS=${config.appHealIntervalMs}${config.appHealIntervalMs === 0 ? ' (disabled)' : ''} APP_HEAL_COOLDOWN_MS=${config.appHealCooldownMs}`);
  console.log(`  SESSION_LRU_ON_RESUME=${config.sessionLruOnResume}`);
  console.log(`  SESSION_PRESSURE_GRACE_MS=${config.sessionPressureGraceMs}${config.sessionPressureGraceMs === 0 ? ' (disabled)' : ''}`);
  console.log(`  PR_STALE_NOTIFY_MS=${config.prStaleNotifyMs}${config.prStaleNotifyMs === 0 ? ' (disabled)' : ''} PR_STALE_GRACE_MS=${config.prStaleGraceMs}`);
  console.log(`  ARCHIVED_RETENTION_MS=${config.archivedRetentionMs}${config.archivedRetentionMs === 0 ? ' (keep forever)' : ''}`);
  console.log(`  USERNODE_APP_PUBKEY=${config.usernodeAppPubkey || '(not set — wallet linking disabled)'}`);
  console.log(`  NODE_RPC_URL=${config.nodeRpcUrl}`);
  console.log(`  USERNODE_PLATFORM_REPO=${config.platformRepoUrl}`);
  console.log(`  SELF_APP_SLUG=${config.selfAppSlug} (db=${config.selfAppDbName})`);
  console.log(`  SELF_APP_CONTAINER=${config.selfAppContainer}`);
  console.log(`  SELF_APP_PUBLIC_VOTING=${config.selfAppPublicVoting} (Phase 4: ${config.selfAppPublicVoting ? 'enabled — all users can see + vote on self-app PRs' : 'disabled — self-app is admin-only'})`);
  console.log(`  PR_IMPORT_ENABLED=${config.prImportEnabled} (#687: ${config.prImportEnabled ? 'enabled — GitHub PRs can be imported as proposals' : 'disabled (default) — PR-import feature is dark'})`);
  console.log(`  PR_IMPORT_MOCK_GITHUB=${config.prImportMockGithub} (#687 Slice 6: ${config.prImportMockGithub ? 'ON — imported-PR flow uses the in-memory mock GitHub source (preview testing)' : 'off (default) — real github.js client'})`);

  return config;
}

// #687 (PR-import): single accessor for the off-by-default PR-import flag,
// used by the routes/poller/merge branches added in later slices to gate
// themselves without threading the loaded config through every call site.
// Reads the env var directly so it's stable regardless of whether a caller
// holds the config object.
function isPrImportEnabled() {
  return process.env.PR_IMPORT_ENABLED === 'true';
}

// #687 Slice 6: single accessor for the opt-in mock-GitHub adapter flag.
// Read directly from env (like isPrImportEnabled) so it's stable regardless
// of whether a caller holds the loaded config object. Only meaningful when
// PR_IMPORT_ENABLED is also on (the imported flow it affects is itself
// flag-gated). Default OFF → production always uses the real github client.
function isPrImportMockGithubEnabled() {
  return process.env.PR_IMPORT_MOCK_GITHUB === 'true';
}

module.exports = { load, isPrImportEnabled, isPrImportMockGithubEnabled };
