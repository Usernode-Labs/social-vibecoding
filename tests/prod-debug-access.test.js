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
  for (const t of ['sessions', 'activation_codes', 'app_secrets']) {
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
  for (const n of ['usernode', 'usernode-db', 'usernode-node', 'caddy', 'acme-dns']) {
    assert.equal(debugAccess.isAllowedLogContainer(n), true, n);
  }
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
  // The admin pages worth pointing users at.
  assert.match(block, /\/debug/);
  assert.match(block, /\/status/);
  assert.match(block, /\/admin/);
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
      mode, workerJwt: 'wjwt', anthropicApiKey: null, prodDebugJwt: 'dbgjwt',
    });
    assert.equal(env.PROD_DEBUG_JWT, 'dbgjwt', mode);
  }
});

test('secret env: never on sync turns, never when not granted', () => {
  const sync = worker.buildTurnSecretEnv({
    mode: 'sync', workerJwt: 'wjwt', anthropicApiKey: null, prodDebugJwt: 'dbgjwt',
  });
  assert.ok(!('PROD_DEBUG_JWT' in sync));
  for (const mode of ['build', 'scout', 'sync']) {
    const env = worker.buildTurnSecretEnv({
      mode, workerJwt: 'wjwt', anthropicApiKey: null, prodDebugJwt: null,
    });
    assert.ok(!('PROD_DEBUG_JWT' in env), mode);
  }
});

test('secret env: pre-existing shape is preserved (scout has no WORKER_JWT)', () => {
  const scout = worker.buildTurnSecretEnv({
    mode: 'scout', workerJwt: 'wjwt', anthropicApiKey: null, prodDebugJwt: null,
  });
  assert.deepEqual(scout, { ANTHROPIC_API_KEY: 'wjwt', ISSUES_JWT: 'wjwt' });
  const build = worker.buildTurnSecretEnv({
    mode: 'build', workerJwt: 'wjwt', anthropicApiKey: 'sk-byok', prodDebugJwt: null,
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
