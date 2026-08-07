// Unit tests for the prod-debug capability's pure pieces (#616):
// services/debug-access.js (grant builder, deny-list coverage against
// schema.sql, result truncation, container-log allowlist, eligibility,
// prompt block) and services/worker.js's turn secret-env builder + the
// prod-debug JWT claims.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

// worker.js mints worker tokens through platform-jwt, which reads
// WORKER_JWT_SECRET from the env at call time (not at import).
process.env.WORKER_JWT_SECRET = 'prod-debug-access-test-worker-secret';
process.env.JWT_SECRET = 'prod-debug-access-test-secret';

const debugAccess = require('../src/services/debug-access');
const worker = require('../src/services/worker');
const platformJwt = require('../src/services/platform-jwt');

// ── buildGrantStatements ───────────────────────────────────────────────

test('grant builder: denied tables produce no grant at all', () => {
  const stmts = debugAccess.buildGrantStatements([
    { table: 'sessions', columns: ['token', 'user_id'] },
    { table: 'app_secrets', columns: ['id', 'value_enc'] },
    { table: 'activation_codes', columns: ['code'] },
    { table: 'user_agent_files', columns: ['id', 'content'] },
  ]);
  assert.deepEqual(stmts, []);
});

test('grant builder: plain tables get a full-table SELECT grant', () => {
  const stmts = debugAccess.buildGrantStatements([
    { table: 'issues', columns: ['id', 'title'] },
  ]);
  assert.equal(stmts.length, 1);
  assert.match(stmts[0], /^GRANT SELECT ON public\."issues" TO usernode_debug_ro$/);
});

test('grant builder: deny-listed columns are excluded via a column-list grant', () => {
  const stmts = debugAccess.buildGrantStatements([
    {
      table: 'users',
      columns: ['id', 'username', 'password', 'anthropic_key_enc',
        'anthropic_key_last4', 'wallet_link_token', 'wallet_link_expires_at',
        'is_admin'],
    },
    { table: 'apps', columns: ['id', 'slug', 'db_password', 'llm_proxy_token'] },
    { table: 'chat_session_attachments', columns: ['id', 'filename', 'data'] },
  ]);
  assert.equal(stmts.length, 3);
  for (const stmt of stmts) {
    assert.match(stmt, /^GRANT SELECT \(/);
    assert.doesNotMatch(stmt, /"password"|"anthropic_key_enc"|"anthropic_key_last4"|"wallet_link_token"|"wallet_link_expires_at"|"db_password"|"llm_proxy_token"|"data"/);
  }
  assert.match(stmts[0], /"id", "username", "is_admin"/);
});

test('grant builder: unsafe identifiers are skipped entirely', () => {
  const stmts = debugAccess.buildGrantStatements([
    { table: 'evil"; DROP TABLE users; --', columns: ['id'] },
    { table: 'ok_table', columns: ['id', 'bad"col'] },
  ]);
  assert.equal(stmts.length, 1);
  assert.match(stmts[0], /"ok_table"/);
});

test('grant builder: table whose every column is denied produces nothing', () => {
  const stmts = debugAccess.buildGrantStatements([
    { table: 'chat_session_attachments', columns: ['data'] },
  ]);
  assert.deepEqual(stmts, []);
});

// ── Deny-list coverage vs schema.sql credential tags ───────────────────
//
// Every COLUMN tagged staging:private in schema.sql stores credential or
// auth material (the table-level tags cover broader "private content"
// which the debugger legitimately reads — chat_sessions, merge_debug_*).
// Assert each tagged column is unreadable by the debug role: either its
// column is denied or its whole table is.

test('every staging:private COLUMN in schema.sql is covered by the deny lists', () => {
  const schema = fs.readFileSync(
    path.join(__dirname, '../src/db/schema.sql'), 'utf8'
  );
  const tagged = [...schema.matchAll(
    /COMMENT ON COLUMN\s+([a-z_]+)\.([a-z_]+)\s+IS\s+'staging:private'/g
  )].map((m) => ({ table: m[1], column: m[2] }));
  assert.ok(tagged.length >= 5, `expected to find tagged columns, got ${tagged.length}`);
  for (const { table, column } of tagged) {
    const covered = debugAccess.DENIED_TABLES.has(table)
      || (debugAccess.DENIED_COLUMNS[table] || []).includes(column);
    assert.ok(covered, `staging:private column ${table}.${column} is not in the prod-debug deny lists`);
  }
});

test('credential tables are deny-listed', () => {
  // pending_secret_declarations holds the AES-encrypted value a
  // declaration proposal carries until it merges — the same class of
  // material as app_secrets / platform_env_values, so the same treatment.
  for (const t of ['sessions', 'activation_codes', 'app_secrets',
    'platform_env_values', 'pending_secret_declarations',
    'cli_device_authorizations', 'cli_access_tokens',
    'cli_auth_audit_events', 'cli_auth_rate_limits']) {
    assert.ok(debugAccess.DENIED_TABLES.has(t), `${t} must be denied`);
  }
});

// ── truncateRows ───────────────────────────────────────────────────────

test('truncateRows: passes small result sets through untouched', () => {
  const rows = [{ a: 1 }, { a: 2 }];
  const out = debugAccess.truncateRows(rows);
  assert.deepEqual(out.rows, rows);
  assert.equal(out.truncated, false);
});

test('truncateRows: caps at the row limit and flags truncation', () => {
  const rows = Array.from({ length: 600 }, (_, i) => ({ i }));
  const out = debugAccess.truncateRows(rows);
  assert.equal(out.rows.length, 500);
  assert.equal(out.truncated, true);
});

test('truncateRows: caps by serialized byte size', () => {
  const big = 'x'.repeat(10 * 1024);
  const rows = Array.from({ length: 100 }, () => ({ big }));
  const out = debugAccess.truncateRows(rows, { maxBytes: 64 * 1024 });
  assert.ok(out.rows.length < 100);
  assert.ok(out.rows.length > 0);
  assert.equal(out.truncated, true);
});

// ── Container-log allowlist + tail clamp ───────────────────────────────

test('isAllowedLogContainer: exact platform names allowed', () => {
  for (const n of ['usernode', 'usernode-blue', 'usernode-green',
    'usernode-db', 'usernode-node', 'usernode-minio', 'caddy', 'acme-dns']) {
    assert.equal(debugAccess.isAllowedLogContainer(n), true, n);
  }
});

test('every container_name in docker-compose.yml is a readable log container', () => {
  // Derived from the compose file rather than restated, because the last
  // time these two lists drifted it cost a whole production investigation:
  // the platform moved to blue-green (`usernode-blue` / `usernode-green`)
  // while the allowlist still named the retired single `usernode` service,
  // so `usernode-debug logs usernode` answered "No such container" and the
  // connector's PR failure went uncharacterised for an afternoon.
  //
  // The check runs the other way round on purpose: a container the platform
  // RUNS but the debugger cannot READ is the failure mode. Extra names in
  // the allowlist (`usernode` itself, kept for pre-blue-green and
  // self-hosted single-instance deploys) are fine.
  const compose = fs.readFileSync(path.join(__dirname, '../docker-compose.yml'), 'utf8');
  const names = [...compose.matchAll(/^\s*container_name:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  assert.ok(names.length >= 7, `found the compose services (got ${names.length})`);
  for (const name of names) {
    assert.equal(
      debugAccess.isAllowedLogContainer(name), true,
      `docker-compose.yml runs "${name}" but prod-debug cannot read its logs — `
      + 'add it to LOG_CONTAINER_EXACT in src/services/debug-access.js'
    );
  }
  // The two colours specifically: this is the case that actually broke.
  assert.ok(names.includes('usernode-blue') && names.includes('usernode-green'));
});

test('isAllowedLogContainer: managed prefixes allowed, bare prefix rejected', () => {
  assert.equal(debugAccess.isAllowedLogContainer('usernode-app-myapp'), true);
  assert.equal(debugAccess.isAllowedLogContainer('usernode-staging-x-1-abc'), true);
  assert.equal(debugAccess.isAllowedLogContainer('usernode-worker-42'), true);
  assert.equal(debugAccess.isAllowedLogContainer('usernode-app-'), false);
});

test('isAllowedLogContainer: arbitrary and hostile names rejected', () => {
  for (const n of ['caddy2', '../etc', 'postgres', '', 'usernode;rm -rf /',
    'usernode\nfoo', 'a b', null, undefined, 42]) {
    assert.equal(debugAccess.isAllowedLogContainer(n), false, String(n));
  }
});

test('clampTail: default, clamp, and garbage handling', () => {
  assert.equal(debugAccess.clampTail(undefined), 200);
  assert.equal(debugAccess.clampTail('abc'), 200);
  assert.equal(debugAccess.clampTail('-5'), 200);
  assert.equal(debugAccess.clampTail('50'), 50);
  assert.equal(debugAccess.clampTail('99999'), 2000);
});

// ── Eligibility ────────────────────────────────────────────────────────

function poolReturning(rows) {
  return { async query() { return { rows }; } };
}

test('isEligible: admin owner + self-hosted app → true', async () => {
  const ok = await debugAccess.isEligible(
    poolReturning([{ self_hosted: true, is_admin: true, user_id: 1 }]), 1
  );
  assert.equal(ok, true);
});

test('isEligible: non-admin owner → false', async () => {
  const ok = await debugAccess.isEligible(
    poolReturning([{ self_hosted: true, is_admin: false, user_id: 2 }]), 1
  );
  assert.equal(ok, false);
});

test('isEligible: admin owner but not the self-edit app → false', async () => {
  const ok = await debugAccess.isEligible(
    poolReturning([{ self_hosted: false, is_admin: true, user_id: 1 }]), 1
  );
  assert.equal(ok, false);
});

test('isEligible: unknown session → false', async () => {
  const ok = await debugAccess.isEligible(poolReturning([]), 404);
  assert.equal(ok, false);
});

// ── Prompt block ───────────────────────────────────────────────────────

test('promptBlock documents all four subcommands and the read-only contract', () => {
  const block = debugAccess.promptBlock();
  assert.match(block, /usernode-debug sql/);
  assert.match(block, /usernode-debug containers/);
  assert.match(block, /usernode-debug logs/);
  assert.match(block, /usernode-debug status/);
  assert.match(block, /READ-ONLY/);
  assert.match(block, /merge_debug_runs/);
  assert.match(block, /src\/db\/schema\.sql/);
});

test('mayorPromptBlock names the Mayor tool, dispatch direction, pages, and the read-only contract', () => {
  const block = debugAccess.mayorPromptBlock();
  // The Mayor's own inline tool and the agent-side CLI it should direct
  // dispatches at.
  assert.match(block, /get_prod_status/);
  assert.match(block, /usernode-debug/);
  assert.match(block, /dispatch/);
  // The concrete production starting points a dispatch prompt should name.
  assert.match(block, /merge_debug_runs/);
  assert.match(block, /chat_sessions/);
  // The admin surfaces worth pointing users at. #860 folded the standalone
  // pages into the one #admin console, so these are section hashes now.
  assert.match(block, /#admin\/merges/);
  assert.match(block, /#admin\/status/);
  assert.match(block, /#admin\/users/);
  // The read-only + audit contract.
  assert.match(block, /READ-ONLY/);
  assert.match(block, /audit-logged/);
  // Prompt-assembly contract: starts with the blank-line separator like
  // getSelfHostedRefuseList, so concatenation renders cleanly.
  assert.match(block, /^\n\n/);
});

// ── worker.buildTurnSecretEnv ──────────────────────────────────────────

test('secret env: PROD_DEBUG_JWT present for build + scout when granted', () => {
  for (const mode of ['build', 'scout']) {
    const env = worker.buildTurnSecretEnv({
      mode, workerSessionJwt: 'wjwt', anthropicApiKey: null, prodDebugJwt: 'dbgjwt',
    });
    assert.equal(env.PROD_DEBUG_JWT, 'dbgjwt', mode);
  }
});

test('secret env: never on sync turns, never when not granted', () => {
  const sync = worker.buildTurnSecretEnv({
    mode: 'sync', workerSessionJwt: 'wjwt', anthropicApiKey: null, prodDebugJwt: 'dbgjwt',
  });
  assert.ok(!('PROD_DEBUG_JWT' in sync));
  for (const mode of ['build', 'scout', 'sync']) {
    const env = worker.buildTurnSecretEnv({
      mode, workerSessionJwt: 'wjwt', anthropicApiKey: null, prodDebugJwt: null,
    });
    assert.ok(!('PROD_DEBUG_JWT' in env), mode);
  }
});

test('secret env: pre-existing shape is preserved (scout has no WORKER_JWT)', () => {
  const scout = worker.buildTurnSecretEnv({
    mode: 'scout', workerSessionJwt: 'wjwt', anthropicApiKey: null, prodDebugJwt: null,
  });
  assert.deepEqual(scout, { ANTHROPIC_API_KEY: 'wjwt', ISSUES_JWT: 'wjwt' });
  const build = worker.buildTurnSecretEnv({
    mode: 'build', workerSessionJwt: 'wjwt', anthropicApiKey: 'sk-byok', prodDebugJwt: null,
  });
  assert.deepEqual(build, {
    ANTHROPIC_API_KEY: 'sk-byok', WORKER_JWT: 'wjwt', ISSUES_JWT: 'wjwt',
  });
});

// ── JWT claims ─────────────────────────────────────────────────────────

test('mintProdDebugJwt carries the prod_debug claim; mintWorkerJwt does not', () => {
  const dbg = platformJwt.verifyWorkerToken(worker.mintProdDebugJwt(7));
  assert.equal(dbg.scope, 'worker:session');
  assert.equal(dbg.session_id, 7);
  assert.equal(dbg.prod_debug, true);

  const plain = platformJwt.verifyWorkerToken(worker.mintWorkerJwt(7));
  assert.equal(plain.scope, 'worker:session');
  assert.ok(!('prod_debug' in plain));
});

// The whole point of the split: the retired shared secret can no longer
// mint anything the internal API accepts.
test('worker tokens do NOT verify under the legacy shared secret', () => {
  const token = worker.mintWorkerJwt(7);
  assert.throws(() => jwt.verify(token, process.env.JWT_SECRET), /invalid signature/);
});

test('a token minted with the legacy shared secret is not a valid worker token', () => {
  const forged = jwt.sign(
    { session_id: 7, scope: 'worker:session', pur: 'worker:session' },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', issuer: 'usernode', audience: 'usernode:worker', expiresIn: '1h' }
  );
  assert.throws(() => platformJwt.verifyWorkerToken(forged), /invalid signature/);
});

// ── Boot-race fix (#891) ────────────────────────────────────────────────
//
// Both this role's bootstrap and the topochain console role's near-identical
// one sweep `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public` plus a
// per-table GRANT loop over the SAME catalog rows. Fired concurrently (they
// were, both un-awaited in server.js) Postgres raises `tuple concurrently
// updated` and the loser's capability is dead for the whole process
// lifetime — observed in production 42ms apart, across consecutive deploys.
// Two guards: sequencing at the call site, and a bounded retry for
// contention ordering can't prevent (an overlapping deploy).

test('#891: server.js awaits the two role bootstraps in sequence', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /await debugAccess\.ensureRole\(config\)/,
    'the prod-debug role bootstrap must be awaited');
  assert.match(src, /await topochainConsoleRole\.ensureConsoleRole\(config\)/,
    'the topochain console role bootstrap must be awaited');
  // Ordering: prod-debug first, console role second — they must not overlap.
  const a = src.indexOf('await debugAccess.ensureRole(config)');
  const b = src.indexOf('await topochainConsoleRole.ensureConsoleRole(config)');
  assert.ok(a !== -1 && b !== -1 && a < b, 'the bootstraps must be sequenced');
  // The un-awaited form that caused the race must be gone.
  assert.doesNotMatch(src, /\n\s*debugAccess\.ensureRole\(config\)\.catch/,
    'ensureRole must not be fired un-awaited');
  assert.doesNotMatch(src, /\n\s*topochainConsoleRole\.ensureConsoleRole\(config\)\.catch/,
    'ensureConsoleRole must not be fired un-awaited');
});

test('#891: ensureRole retries a bounded number of times', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src/services/debug-access.js'), 'utf8'
  );
  assert.match(src, /const BOOTSTRAP_ATTEMPTS = 3/, 'attempts must be a named bound');
  assert.match(src, /const BOOTSTRAP_RETRY_MS = 250/, 'the backoff must be a named constant');
  assert.match(src, /async function bootstrapRole\(config\)/,
    'one attempt must be extracted so the caller can retry it');
  assert.match(src, /for \(let attempt = 1; attempt <= BOOTSTRAP_ATTEMPTS; attempt\+\+\)/,
    'ensureRole must loop over bounded attempts');
  // The backoff is awaited during boot, BEFORE the HTTP listener exists —
  // an unref'd timer lets Node treat the loop as idle and exit, abandoning
  // the retry and the rest of startup.
  const sleepLine = src.match(/const sleep = .*/)[0];
  assert.doesNotMatch(sleepLine, /unref/,
    'the boot-time backoff timer must NOT be unref\'d');
});

// Behavioural, not just a source guard: drive the real ensureRole against a
// stub pool that fails a controllable number of times.
function stubbedDebugAccess() {
  const Module = require('module');
  const origLoad = Module._load;
  const state = { attempts: 0, failTimes: 0 };
  Module._load = function (req) {
    if (req === '../db/pool') {
      return { getPool: () => ({
        query: async (sql) => {
          if (sql.includes('DO $$')) {
            state.attempts++;
            if (state.attempts <= state.failTimes) {
              throw new Error('tuple concurrently updated');
            }
          }
          if (sql.includes('current_database')) return { rows: [{ db: 'usernode' }] };
          if (sql.includes('information_schema.columns')) {
            return { rows: [{ table: 'issues', columns: ['id', 'title'] }] };
          }
          return { rows: [] };
        },
      }) };
    }
    if (req === './logger') return new Proxy({}, { get: () => () => {} });
    return origLoad.apply(this, arguments);
  };
  // Fresh copy so the stub is the one it binds to.
  const p = require.resolve('../src/services/debug-access');
  delete require.cache[p];
  const mod = require(p);
  Module._load = origLoad;
  delete require.cache[p];
  return { mod, state };
}

test('#891: ensureRole recovers from transient catalog contention', async () => {
  const { mod, state } = stubbedDebugAccess();
  state.failTimes = 2;                 // fail twice, succeed on the third
  await mod.ensureRole({});
  assert.equal(state.attempts, 3, 'must retry up to the bound');
  assert.equal(mod.isAvailable(), true, 'the capability must come up after a retry');
});

test('#891: ensureRole gives up cleanly after the bound', async () => {
  const { mod, state } = stubbedDebugAccess();
  state.failTimes = Infinity;          // always contended
  await mod.ensureRole({});
  assert.equal(state.attempts, 3, 'must stop at the bound, not spin');
  assert.equal(mod.isAvailable(), false, 'a permanent failure must disable the capability');
});

test('#891: a clean bootstrap still takes exactly one attempt', async () => {
  const { mod, state } = stubbedDebugAccess();
  await mod.ensureRole({});
  assert.equal(state.attempts, 1, 'the happy path must not pay for the retry');
  assert.equal(mod.isAvailable(), true);
});
