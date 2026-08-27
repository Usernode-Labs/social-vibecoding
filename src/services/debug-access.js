'use strict';

// #616: read-only production access for admin dev sessions on the
// self-edit app.
//
// The Claude Code worker never receives a DB credential or the docker
// socket — it shares a docker network with usernode-db, so any static
// credential handed to one worker would be usable from EVERY worker
// container. Instead the worker calls session-scoped, claim-gated
// internal API endpoints (src/routes/internal.js "prod-debug" routes)
// and the platform executes the reads on its side:
//
//   - SQL runs through a dedicated `usernode_debug_ro` Postgres role
//     whose password exists only in this process's memory (regenerated
//     every boot) and whose grants exclude every credential-bearing
//     table/column (deny lists below).
//   - docker reads (`docker logs`, `docker ps`) run via the platform's
//     existing docker.js helpers against an allowlist of container
//     names.
//
// Same proxy philosophy as the anthropic proxy and the push proxy in
// services/worker.js: the real credential never enters the worker.

const crypto = require('crypto');
const { Pool } = require('pg');
const { getPool } = require('../db/pool');
const log = require('./logger');

const ROLE = 'usernode_debug_ro';
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

// Query execution limits for the SQL proxy.
const QUERY_TIMEOUT_MS = 5000;
const MAX_ROWS = 500;
const MAX_RESULT_BYTES = 256 * 1024;

// ── Deny lists ──────────────────────────────────────────────────────────
//
// Tables/columns that hold credentials or private user material and must
// NEVER be selectable by the debug role. Kept in sync with the
// `staging:private` credential tags in src/db/schema.sql — a new
// secret-bearing column/table added there MUST be added here too (a test
// in tests/prod-debug-access.test.js cross-checks the schema tags against
// this list). Note this is deliberately much smaller than the full
// `staging:private` set: tables like chat_sessions and merge_debug_runs
// are private-to-staging but are exactly what a production debugger
// needs to read.
const DENIED_TABLES = new Set([
  'sessions',           // login cookie tokens
  'activation_codes',   // invite/activation secrets
  'app_secrets',        // per-app env secrets (AES blobs, still deny)
  'user_agent_files',   // personal instruction files (private user text)
  'platform_env_values', // platform's own env values (AES blobs, still deny)
  'pending_secret_declarations', // values held for a declaration PR (AES blobs)
  'mobile_otp_codes',   // topochain: one-time login codes (SPEC §6)
  'waitlist_verification_codes', // one-time waitlist email codes, same treatment as mobile_otp_codes
  'mobile_auth_tokens', // topochain: bearer session/set-password tokens (plan Global Constraints #4)
  'mobile_push_deployment_state', // trusted push deployment identity and activation state
  'mobile_push_installation_mutations', // private device mutation fences
  'mobile_push_registrations', // encrypted FCM destinations
  'mobile_push_registration_events', // private device registration lifecycle metadata
  'mobile_push_deliveries', // private notification/device delivery metadata
  'cli_device_authorizations', // global CLI device codes and request IPs
  'cli_access_tokens',   // global CLI bearer hashes and hints
  'cli_auth_audit_events', // security audit trail for CLI credentials
  'cli_auth_rate_limits', // shared security limiter state
  'profile_reports',      // private abuse reports and reporter identities
  'conversations',        // private platform messaging metadata
  'conversation_direct_pairs', // private messaging relationships
  'conversation_members', // private conversation membership/invites/read state
  'conversation_messages', // private message bodies and reply metadata
  'conversation_message_reactions', // private social interactions
  'conversation_message_attachments', // private attachment bytes + metadata
  'conversation_message_objects', // private shared-object activity
  'chat_session_spec_conversation_shares', // private spec access grants
  'user_blocks',          // private user safety relationships
  'conversation_message_reports', // private abuse evidence and reporter identity
  'mcp_clients',              // hosted-connector client registrations
  'mcp_authorization_codes',  // hosted-connector PKCE codes (hashed, short-lived)
  'mcp_tokens',               // hosted-connector bearer hashes and hints
  'mcp_auth_audit_events',    // security audit trail for connector credentials
  'user_social_identities',   // private provider ownership proofs
  'social_identity_oauth_states', // social-link state hashes + PKCE verifiers
  'user_ai_credentials', // per-user AI/LLM provider keys (encrypted blobs, still deny)
]);

const DENIED_COLUMNS = {
  users: [
    'password',
    'anthropic_key_enc',
    'anthropic_key_last4',
    'wallet_link_token',
    'wallet_link_expires_at',
    'email_confirmation_token', // topochain (SPEC §6)
    'password_reset_token_hash', // email password-reset capability
    'password_reset_expires_at',
    'waitlist_ip',              // topochain (SPEC §6)
    'profile_disabled_reason',  // private moderator rationale
    'github_oauth_token_enc',   // verified GitHub link: the user's OAuth token
  ],
  apps: [
    'db_password',
    'llm_proxy_token',
    'storage_api_token',
  ],
  chat_session_attachments: [
    'data', // raw upload bytes — large and potentially private
  ],
  onchain_accounts: [
    'secret_key',        // topochain: on-chain account private key (SPEC §6)
    'registration_code', // topochain: single-use account claim code (SPEC §6)
  ],
  waitlist_signups: [
    'ip',         // submitter IP — same treatment as users.waitlist_ip
    'more_token', // stage-2 survey capability — editing rights over the signup's answers
    'invite_code', // shareable capability — anyone holding it is attributed as this signup's invitee
  ],
};

// ── Container-log allowlist (used by the prod-debug logs endpoint) ─────
// Every `container_name` docker-compose.yml declares for a platform service,
// and nothing else. `usernode` is kept for pre-blue-green and self-hosted
// single-instance deploys; `usernode-blue` / `usernode-green` are the two
// colours production has actually run since the blue-green rollout, and
// their absence here is why `usernode-debug logs usernode` answered "No such
// container" while the connector's PR failure went uncharacterised for a
// whole afternoon. tests/prod-debug-access.test.js derives the expectation
// from docker-compose.yml, so the next rename cannot silently blind the
// debugger again.
const LOG_CONTAINER_EXACT = new Set([
  'usernode', 'usernode-blue', 'usernode-green',
  'usernode-db', 'usernode-node', 'usernode-minio', 'caddy', 'acme-dns',
]);
const LOG_CONTAINER_PREFIXES = [
  'usernode-app-', 'usernode-staging-', 'usernode-worker-',
];
const DEFAULT_LOG_TAIL = 200;
const MAX_LOG_TAIL = 2000;
const MAX_LOG_BYTES = 256 * 1024;

function isAllowedLogContainer(name) {
  if (typeof name !== 'string' || !name) return false;
  // Strict charset first so nothing shell/path-shaped gets near docker.
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return false;
  if (LOG_CONTAINER_EXACT.has(name)) return true;
  return LOG_CONTAINER_PREFIXES.some((p) => name.startsWith(p) && name.length > p.length);
}

function clampTail(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LOG_TAIL;
  return Math.min(n, MAX_LOG_TAIL);
}

// ── Role bootstrap ──────────────────────────────────────────────────────

// In-memory only: regenerated on every boot, never persisted anywhere.
let _roPassword = null;
let _roPool = null;
let _available = false;
let _unavailableReason = 'prod-debug role not initialized';

function quoteIdent(name) {
  return `"${name}"`;
}

// Pure: turn the enumerated table/column inventory into GRANT statements,
// applying the deny lists. Exported for unit tests. Input shape:
// [{ table, columns: [...] }]. Tables in DENIED_TABLES produce nothing;
// tables with DENIED_COLUMNS entries get an explicit column-list grant
// (fail-closed for columns added later — SELECT * then errors rather than
// leaking a future secret column).
function buildGrantStatements(tables) {
  const stmts = [];
  for (const { table, columns } of tables || []) {
    if (!SAFE_IDENT.test(table)) continue;
    if (DENIED_TABLES.has(table)) continue;
    const denied = DENIED_COLUMNS[table];
    if (denied && denied.length) {
      const allowed = (columns || []).filter(
        (c) => SAFE_IDENT.test(c) && !denied.includes(c)
      );
      if (!allowed.length) continue;
      stmts.push(
        `GRANT SELECT (${allowed.map(quoteIdent).join(', ')}) ON public.${quoteIdent(table)} TO ${ROLE}`
      );
    } else {
      stmts.push(`GRANT SELECT ON public.${quoteIdent(table)} TO ${ROLE}`);
    }
  }
  return stmts;
}

// #891: bounded retry around the whole bootstrap. Granting to this role
// rewrites the same catalog rows (pg_authid for the ALTER ROLEs, every
// table's pg_class ACL for the REVOKE/GRANT sweep) that the topochain
// console role's near-identical bootstrap rewrites, so two of them running
// concurrently makes Postgres raise `tuple concurrently updated` and the
// loser's capability is dead for the whole process lifetime (nothing
// re-invokes ensureRole — see the module header note below). server.js now
// awaits the two in sequence, which removes the in-process collision; this
// retry covers what ordering cannot — an overlapping deploy, where the old
// container's boot sweep is still running as the new one starts.
//
// Retrying the ENTIRE sequence rather than just the grant loop is
// deliberate: the contention can surface on any of the ALTER ROLE / REVOKE
// / GRANT statements, and the sequence is fully idempotent (create-if-
// missing, then unconditional ALTER/REVOKE/GRANT), so re-running from the
// top is always safe.
const BOOTSTRAP_ATTEMPTS = 3;
const BOOTSTRAP_RETRY_MS = 250;

// NOT unref'd, deliberately: this backoff is awaited during boot, before
// the HTTP listener exists. An unref'd timer lets Node consider the loop
// idle and exit, abandoning the retry (and the rest of startup) entirely.
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Boot-time ensure (called from server.js after migrate()): create/reset
// the role with a fresh random password, lock it down, and refresh grants
// so tables added by this deploy's migrations are covered. Any failure
// leaves the capability cleanly unavailable (endpoints 503) without
// affecting the rest of boot.
//
// NOTE: this runs exactly once per boot and `_available` is latched by it,
// so a permanent failure here disables prod-debug until the next deploy.
// That is why the retry above exists.
async function ensureRole(config) {
  for (let attempt = 1; attempt <= BOOTSTRAP_ATTEMPTS; attempt++) {
    try {
      await bootstrapRole(config);
      return;
    } catch (err) {
      if (attempt < BOOTSTRAP_ATTEMPTS) {
        log.warn('prod-debug', 'Role bootstrap attempt failed — retrying', {
          err: err.message, attempt, attempts: BOOTSTRAP_ATTEMPTS,
        });
        // Linear backoff: 250ms, then 500ms. Long enough to outlast a
        // concurrent sweep, short enough to stay invisible in boot time.
        await sleep(BOOTSTRAP_RETRY_MS * attempt);
        continue;
      }
      _available = false;
      _unavailableReason = `prod-debug role bootstrap failed: ${err.message}`;
      _roPassword = null;
      log.warn('prod-debug', 'Role bootstrap failed — capability disabled', {
        err: err.message, attempts: BOOTSTRAP_ATTEMPTS,
      });
    }
  }
}

// One bootstrap attempt. Throws on any failure so ensureRole can retry;
// sets `_available` only on the success path.
async function bootstrapRole(config) {
  const pool = getPool(config);
  // 48 hex chars — no SQL/URL-special characters, safe to inline.
  _roPassword = crypto.randomBytes(24).toString('hex');

  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${ROLE}') THEN
      CREATE ROLE ${ROLE} LOGIN PASSWORD '${_roPassword}';
    ELSE
      ALTER ROLE ${ROLE} WITH LOGIN PASSWORD '${_roPassword}';
    END IF;
  END $$;`);
  await pool.query(
    `ALTER ROLE ${ROLE} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`
  );
  // Role-level read-only: even a COMMIT-smuggling or multi-statement
  // query starts read-only, and the role has no write grants anyway.
  await pool.query(`ALTER ROLE ${ROLE} SET default_transaction_read_only = on`);
  await pool.query(`ALTER ROLE ${ROLE} SET statement_timeout = '${QUERY_TIMEOUT_MS}ms'`);

  const { rows: dbRows } = await pool.query('SELECT current_database() AS db');
  const dbName = dbRows[0].db;
  if (!SAFE_IDENT.test(dbName)) throw new Error(`unsafe database name ${dbName}`);
  // CONNECT only — no TEMP (temp tables are a write surface).
  await pool.query(`REVOKE ALL ON DATABASE ${quoteIdent(dbName)} FROM ${ROLE}`);
  await pool.query(`GRANT CONNECT ON DATABASE ${quoteIdent(dbName)} TO ${ROLE}`);
  await pool.query(`REVOKE CREATE ON SCHEMA public FROM ${ROLE}`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);

  // Reset then re-grant so deny-list additions take effect on the next
  // boot without manual REVOKEs.
  await pool.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${ROLE}`);
  const { rows: tableRows } = await pool.query(
    `SELECT c.table_name AS table, array_agg(c.column_name::text ORDER BY c.ordinal_position) AS columns
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      GROUP BY c.table_name`
  );
  const grants = buildGrantStatements(tableRows);
  for (const stmt of grants) {
    await pool.query(stmt);
  }

  // Rebuild the RO pool so it picks up the fresh password.
  if (_roPool) {
    _roPool.end().catch(() => {});
    _roPool = null;
  }
  _available = true;
  _unavailableReason = null;
  log.info('prod-debug', 'Read-only debug role ensured', {
    role: ROLE, db: dbName, grantedTables: grants.length,
    deniedTables: DENIED_TABLES.size,
  });
}

function isAvailable() {
  return _available;
}

function _getRoPool(config) {
  if (_roPool) return _roPool;
  const raw = (config && config.databaseUrl) || process.env.DATABASE_URL;
  const u = new URL(raw);
  _roPool = new Pool({
    host: u.hostname,
    port: u.port ? parseInt(u.port, 10) : 5432,
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    user: ROLE,
    password: _roPassword,
    max: 2,
    idleTimeoutMillis: 30000,
    statement_timeout: QUERY_TIMEOUT_MS,
  });
  _roPool.on('error', (err) => {
    log.warn('prod-debug', 'RO pool error', { err: err.message });
  });
  return _roPool;
}

// Pure: cap a result set to MAX_ROWS rows and ~MAX_RESULT_BYTES of
// serialized JSON. Exported for unit tests.
function truncateRows(rows, { maxRows = MAX_ROWS, maxBytes = MAX_RESULT_BYTES } = {}) {
  const out = [];
  let bytes = 0;
  let truncated = false;
  for (const row of rows || []) {
    if (out.length >= maxRows) { truncated = true; break; }
    let size;
    try {
      size = Buffer.byteLength(JSON.stringify(row) || 'null');
    } catch {
      size = 64; // unserializable row — count something, keep going
    }
    if (bytes + size > maxBytes && out.length > 0) { truncated = true; break; }
    bytes += size;
    out.push(row);
  }
  return { rows: out, truncated };
}

// Execute one read-only query as the debug role. Throws with
// err.code = 'unavailable' when the role bootstrap hasn't succeeded,
// 'bad_query' for a non-string/empty query. Postgres errors (permission
// denied on a denied column, syntax errors, read-only violations) are
// passed through with their message so the agent can self-correct.
async function runQuery(sql, { config = null } = {}) {
  if (!_available) {
    const err = new Error(_unavailableReason || 'prod-debug unavailable');
    err.code = 'unavailable';
    throw err;
  }
  if (typeof sql !== 'string' || !sql.trim()) {
    const err = new Error('query must be a non-empty string');
    err.code = 'bad_query';
    throw err;
  }
  const pool = _getRoPool(config);
  const res = await pool.query(sql);
  // Multi-statement strings resolve to an array of results; report the
  // last one (writes are impossible regardless — see role setup).
  const last = Array.isArray(res) ? res[res.length - 1] : res;
  const { rows, truncated } = truncateRows((last && last.rows) || []);
  return {
    rows,
    rowCount: (last && typeof last.rowCount === 'number') ? last.rowCount : rows.length,
    truncated,
  };
}

// ── Eligibility ─────────────────────────────────────────────────────────

// A session qualifies for prod-debug when its app is the self-edit app
// (apps.self_hosted = TRUE) AND its OWNER is currently an admin. Checked
// fresh from the DB — both at dispatch time (env injection) and on every
// internal-API request (requireProdDebug) — so revoking admin cuts access
// immediately despite the JWT's 24h TTL. View-only admins
// (admin_readonly = TRUE) qualify: the surface is read-only, matching
// their tier.
async function checkSessionEligibility(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT a.self_hosted, u.is_admin, cs.user_id
       FROM chat_sessions cs
       JOIN apps a ON a.id = cs.app_id
       JOIN users u ON u.id = cs.user_id
      WHERE cs.id = $1`,
    [sessionId]
  );
  if (!rows.length) return { found: false, eligible: false };
  return {
    found: true,
    eligible: !!rows[0].self_hosted && !!rows[0].is_admin,
    selfHosted: !!rows[0].self_hosted,
    isAdmin: !!rows[0].is_admin,
    ownerId: rows[0].user_id,
  };
}

async function isEligible(pool, sessionId) {
  const check = await checkSessionEligibility(pool, sessionId);
  return check.eligible;
}

// ── Prompt exposure ─────────────────────────────────────────────────────

// Injected into build + scout prompts ONLY when the turn is eligible, so
// ineligible agents never learn the capability exists.
function promptBlock() {
  return `PRODUCTION DEBUG ACCESS (admin session on the self-edit app): a read-only helper \`usernode-debug\` is available (run it via Bash) for inspecting the LIVE PRODUCTION deployment of this platform — use it to debug stuck sessions, broken apps, and failed merges from real production state instead of guessing from source:
- \`usernode-debug sql "SELECT ..."\` — run a read-only SQL query against the production platform database (its schema is this repo's \`src/db/schema.sql\`). Useful starting points: \`chat_sessions\` (incl. \`active_turn\`), \`merge_debug_runs\` / \`merge_debug_steps\` (step-by-step traces of every merge attempt), \`events\`, \`apps\`, \`llm_usage\`.
- \`usernode-debug containers\` — list production containers with state and memory/CPU usage.
- \`usernode-debug logs <container> [tail]\` — recent log lines from one container (\`usernode\` is the platform server; also \`usernode-db\`, \`caddy\`, \`usernode-node\`, and \`usernode-app-*\` / \`usernode-staging-*\` / \`usernode-worker-*\` containers).
- \`usernode-debug status\` — the platform health snapshot (stuck sessions, warm workers, staging, budgets) plus recent platform log events.
All output is JSON. This access is strictly READ-ONLY — writes are structurally impossible — and credential-bearing tables/columns (passwords, API keys, tokens, app secrets) are excluded at the database-grant level; do not attempt to read secrets or modify production state. Every call is audit-logged.`;
}

// Mayor-facing awareness block: appended to the Mayor system prompt
// ONLY when the session is prod-debug eligible (same gating as
// promptBlock above — ineligible Mayors must never learn the
// capability exists). Kept here beside promptBlock so the two
// capability descriptions stay in sync. Starts with the blank lines
// the prompt-assembly concatenation expects (mirrors
// getSelfHostedRefuseList in services/prompts.js).
function mayorPromptBlock() {
  return `

==== PRODUCTION DEBUG (admin session on the self-edit app) ====

This session qualifies for read-only production debugging: the session owner is an admin and this app is the platform itself. What that means for you:

- Any scout or coding agent you dispatch gets a read-only \`usernode-debug\` CLI against the LIVE PRODUCTION deployment: \`sql\` (read-only queries on the production platform database), \`containers\` (container list with memory/CPU), \`logs <container>\` (recent log lines), and \`status\` (health snapshot plus recent platform log events). When the user reports a production problem — a stuck session, a failed merge, a broken app, resource issues — your dispatch prompt SHOULD explicitly direct the agent to inspect live production state FIRST instead of guessing from source, naming the relevant starting points: \`chat_sessions\` (incl. \`active_turn\`), \`merge_debug_runs\` / \`merge_debug_steps\` (step-by-step traces of every merge attempt), \`events\`, \`llm_usage\`, container logs.
- YOU have a \`get_prod_status\` data tool: a quick, inline production health snapshot (stuck sessions, warm workers, staging, budgets, recent platform log events). Call it to answer questions like "is anything stuck right now?" or "how's the platform doing?" directly in chat. For anything deeper — SQL queries, container logs — dispatch the scout with a prod-debug-directed prompt rather than guessing, and say that's what you're doing.
- Admin surfaces worth pointing the user at when they fit the question — all sections of the one admin console behind the header shield icon (#860): #admin/merges (step-by-step merge traces), #admin/status (the health dashboard; admins see the full view), #admin/node (node, explorer and chain services), #admin/analytics (user analytics: growth, retention and spend), #admin/estimator (progress-estimator accuracy), #admin/gallery (before/after capture screenshots), #admin/users, #admin/limits, #admin/codes.

Everything here is strictly READ-ONLY and audit-logged; credential-bearing data (passwords, API keys, tokens, app secrets) is structurally unreadable. Never present these capabilities as available to non-admins or on other apps.

==== END PRODUCTION DEBUG ====`;
}

module.exports = {
  ROLE,
  ensureRole,
  isAvailable,
  runQuery,
  checkSessionEligibility,
  isEligible,
  promptBlock,
  mayorPromptBlock,
  isAllowedLogContainer,
  clampTail,
  MAX_LOG_BYTES,
  // exported for unit tests
  buildGrantStatements,
  truncateRows,
  DENIED_TABLES,
  DENIED_COLUMNS,
};
