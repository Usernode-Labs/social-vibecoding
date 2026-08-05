'use strict';
// Tests for the generic credential store (plan.md PR2 + review findings).
// Covers validation, atomic dual-write, delete/save serialization,
// authoritative revocation, rollback reconciliation (schema), status
// gating, legacy fallback semantics, and fingerprint — using a scripted
// transaction-aware fake pool so no real Postgres/docker is involved.
//
// Run with: node --test tests/credential-store.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const secrets = require('../src/services/secrets');
const store = require('../src/services/credential-store');

const DATA_KEY = 'test-data-encryption-key-0000';
const sk = (k) => secrets.encrypt(k, DATA_KEY);

// Scripted, transaction-aware fake pool; records every op (incl.
// BEGIN/COMMIT/ROLLBACK) on ops(). handlers(sql) => { rows } | { error }.
function makeDb(handlers) {
  const ops = [];
  let failOn = null;
  const client = {
    release: () => {},
    query: async (sql, params) => {
      const norm = String(sql).replace(/\s+/g, ' ').trim();
      ops.push({ op: 'query', sql: norm, params: params || [] });
      if (/^BEGIN$/i.test(norm) || /^COMMIT$/i.test(norm) || /^ROLLBACK$/i.test(norm)) {
        return { rows: [] };
      }
      if (failOn && failOn.test(norm)) throw new Error('injected failure: ' + norm);
      const h = handlers(norm, params);
      if (h && h.error) throw h.error;
      return { rows: h ? h.rows : [] };
    },
  };
  const pool = { connect: async () => client, query: async (sql, p) => client.query(sql, p) };
  pool.failNext = (re) => { failOn = re; };
  pool.ops = () => ops.slice();
  pool.beginIdx = () => ops.findIndex((o) => /^BEGIN$/i.test(o.sql));
  pool.commitIdx = () => ops.findIndex((o) => /^COMMIT$/i.test(o.sql));
  pool.rollbackCount = () => ops.filter((o) => /^ROLLBACK$/i.test(o.sql)).length;
  return pool;
}

// ── Validation & fingerprint ───────────────────────────────────────────
test('assertProviderPurpose rejects unknown provider/purpose', async () => {
  const pool = makeDb(() => ({ rows: [] }));
  await assert.rejects(() => store.upsert({ pool, provider: 'nope', userId: 1 }));
  await assert.rejects(() => store.upsert({ pool, provider: 'anthropic', purpose: 'nope', userId: 1 }));
});

test('assertStatus rejects unsupported status values', async () => {
  const pool = makeDb(() => ({ rows: [] }));
  await assert.rejects(
    () => store.upsert({ pool, provider: 'openrouter', purpose: 'coding_agent',
      userId: 1, secretEnc: sk('k'), secretLast4: 'xxxx', status: 'hacked' }),
    /unsupported status/
  );
});

test('status=valid requires verified=true (and verified=true requires status=valid)', async () => {
  const pool = makeDb((sql) => {
    if (/INSERT INTO credentials.user_ai_credentials/.test(sql)) {
      return { rows: [{ id: 1, revision: 1, status: 'valid', secret_last4: 'abcd' }] };
    }
    return { rows: [] };
  });
  await assert.rejects(
    () => store.upsert({
      pool, userId: 1, provider: 'openrouter', purpose: 'coding_agent',
      secretEnc: sk('k'), secretLast4: 'xxxx', status: 'valid', verified: false,
    }),
    /status=valid requires verified=true/,
  );
  await assert.rejects(
    () => store.upsert({
      pool, userId: 1, provider: 'openrouter', purpose: 'coding_agent',
      secretEnc: sk('k'), secretLast4: 'xxxx', status: 'unverified', verified: true,
    }),
    /verified=true requires status=valid/,
  );
});

test('anthropic/coding_agent upsert is rejected (must dual-write via writeAnthropicCodingAgent)', async () => {
  const pool = makeDb(() => ({ rows: [] }));
  await assert.rejects(
    () => store.upsert({
      pool, userId: 1, provider: 'anthropic', purpose: 'coding_agent',
      secretEnc: sk('k'), secretLast4: 'xxxx',
    }),
    /must use writeAnthropicCodingAgent/,
  );
});

test('fingerprint is deterministic, 64-hex, distinct from plaintext', () => {
  const a = store.fingerprint('sk-or-v1-abc', DATA_KEY);
  assert.equal(a, store.fingerprint('sk-or-v1-abc', DATA_KEY));
  assert.notEqual(a, store.fingerprint('sk-or-v1-abd', DATA_KEY));
  assert.notEqual(a, 'sk-or-v1-abc');
  assert.match(a, /^[0-9a-f]{64}$/);
});

// ── Atomic dual-write + status gating (F1, F3) ─────────────────────────
test('F1/F3: valid save dual-writes generic + legacy atomically', async () => {
  const pool = makeDb((sql) => {
    if (/INSERT INTO credentials.user_ai_credentials/.test(sql)) return { rows: [{ id: 1, revision: 1, status: 'valid', secret_last4: 'abcd' }] };
    if (/UPDATE users SET/.test(sql)) return { rows: [] };
    return { rows: [] };
  });
  await store.writeAnthropicCodingAgent({ pool, userId: 5, apiKey: 'sk-ant-api03-abcdef', dataKey: DATA_KEY });
  const sqls = pool.ops().map((o) => o.sql);
  assert.ok(sqls.some((s) => /INSERT INTO credentials.user_ai_credentials/.test(s)), 'generic insert');
  assert.ok(sqls.some((s) => /UPDATE users SET anthropic_key_enc/.test(s)), 'legacy update for valid');
  assert.ok(pool.beginIdx() >= 0 && pool.commitIdx() > pool.beginIdx(), 'atomic txn');
});

test('F1: a legacy dual-write failure rolls back AND propagates', async () => {
  const pool = makeDb((sql) => {
    if (/INSERT INTO credentials.user_ai_credentials/.test(sql)) return { rows: [{ id: 1, revision: 1 }] };
    if (/UPDATE users SET/.test(sql)) return { error: new Error('legacy write boom') };
    return { rows: [] };
  });
  await assert.rejects(
    () => store.writeAnthropicCodingAgent({ pool, userId: 5, apiKey: 'sk-ant-api03-abcdef', dataKey: DATA_KEY }),
    /legacy write boom/
  );
  assert.equal(pool.rollbackCount(), 1, 'rolled back on failure');
  assert.equal(pool.commitIdx(), -1, 'no COMMIT after rollback');
});

test('F3: a NON-valid Anthropic save CLEARS legacy columns (old key not left active)', async () => {
  const pool = makeDb((sql) => {
    if (/INSERT INTO credentials.user_ai_credentials/.test(sql)) return { rows: [{ id: 1, revision: 1, status: 'unverified' }] };
    if (/UPDATE users SET/.test(sql)) return { rows: [] };
    return { rows: [] };
  });
  await store.writeAnthropicCodingAgent({ pool, userId: 5, apiKey: 'sk-ant-abcdef', dataKey: DATA_KEY, status: 'unverified', verified: false });
  const sqls = pool.ops().map((o) => o.sql);
  assert.ok(sqls.some((s) => /INSERT INTO credentials.user_ai_credentials/.test(s)), 'generic insert');
  // A non-valid replacement must atomically CLEAR the legacy columns so
  // status-blind legacy consumers stop using the previously-valid key
  // (review F3). It must clear (set NULL), not mirror the non-valid key.
  const legacyUpdate = sqls.find((s) => /UPDATE users SET/.test(s));
  assert.ok(legacyUpdate, 'legacy columns are updated on a non-valid replacement');
  assert.match(legacyUpdate, /anthropic_key_enc = NULL/, 'non-valid key is NOT written to legacy; it is cleared');
});

// ── Revocation (F1 delete-save race, F2 authoritative) ─────────────────
test('F1: revoke issues an UPSERT tombstone (locks row even when absent)', async () => {
  const pool = makeDb((sql) => {
    if (/INSERT INTO credentials.user_ai_credentials/.test(sql)) return { rows: [{ status: 'revoked', revision: 1 }] };
    if (/UPDATE users SET anthropic_key_enc = NULL/.test(sql)) return { rows: [] };
    return { rows: [] };
  });
  await store.revoke({ pool, userId: 9, provider: 'anthropic', purpose: 'coding_agent' });
  const sqls = pool.ops().map((o) => o.sql);
  const insert = sqls.find((s) => /INSERT INTO credentials.user_ai_credentials/.test(s));
  assert.ok(insert, 'revoke uses INSERT ... ON CONFLICT');
  assert.match(insert, /ON CONFLICT/, 'revoke upserts (not a zero-row UPDATE)');
  assert.match(insert, /status = 'revoked'/, 'tombstone status set');
  assert.match(insert, /verified_at = NULL/, 'tombstone clears verified_at (satisfies valid_verified)');
  assert.ok(sqls.some((s) => /UPDATE users SET anthropic_key_enc = NULL/.test(s)), 'legacy cleared in same txn');
  assert.ok(pool.beginIdx() >= 0 && pool.commitIdx() > pool.beginIdx(), 'atomic revocation txn');
});

test('F2: a tombstoned row NEVER falls back to legacy ciphertext', async () => {
  const pool = makeDb((sql) => {
    if (/SELECT status, secret_last4, secret_enc/.test(sql)) return { rows: [{ status: 'revoked', secret_last4: null, secret_enc: null }] };
    if (/SELECT anthropic_key_enc AS enc\s+FROM users/i.test(sql)) return { rows: [{ enc: sk('sk-ant-api03-OLD-DELETED') }] };
    return { rows: [] };
  });
  const got = await store.readSecret({ pool, userId: 3, provider: 'anthropic', purpose: 'coding_agent', dataKey: DATA_KEY });
  assert.equal(got, null, 'revoked credential must not resurrect deleted key');
});

// ── Atomic read + status gating (F4) ───────────────────────────────────
test('F4: readSecret fetches status + secret in one statement (same snapshot)', async () => {
  const pool = makeDb((sql) => {
    if (/SELECT status, secret_last4, secret_enc/.test(sql)) return { rows: [{ status: 'valid', secret_last4: 'abcd', secret_enc: sk('sk-ant-ok') }] };
    return { rows: [] };
  });
  const got = await store.readSecret({ pool, userId: 1, provider: 'anthropic', purpose: 'coding_agent', dataKey: DATA_KEY });
  assert.equal(got, 'sk-ant-ok');
  // Exactly one SELECT to the credentials table (no separate metadata +
  // ciphertext queries).
  const selects = pool.ops().filter((o) => /SELECT status, secret_last4, secret_enc/.test(o.sql)).length;
  assert.equal(selects, 1, 'single-statement credential read');
});

test('F4: only status=valid rows yield a secret', async () => {
  for (const status of ['unverified', 'invalid', 'expired']) {
    const pool = makeDb((sql) => {
      if (/SELECT status, secret_last4, secret_enc/.test(sql)) return { rows: [{ status, secret_last4: 'abcd', secret_enc: sk('x') }] };
      return { rows: [] };
    });
    const got = await store.readSecret({ pool, userId: 1, provider: 'anthropic', purpose: 'coding_agent', dataKey: DATA_KEY });
    assert.equal(got, null, `status=${status} must not be usable`);
  }
});

test('F5: a valid generic row that fails decryption is NOT replaced by legacy', async () => {
  const pool = makeDb((sql) => {
    if (/SELECT status, secret_last4, secret_enc/.test(sql)) return { rows: [{ status: 'valid', secret_last4: 'abcd', secret_enc: 'v1:broken:broken:broken' }] };
    if (/SELECT anthropic_key_enc AS enc\s+FROM users/i.test(sql)) return { rows: [{ enc: sk('sk-ant-api03-OLD') }] };
    return { rows: [] };
  });
  const got = await store.readSecret({ pool, userId: 1, provider: 'anthropic', purpose: 'coding_agent', dataKey: DATA_KEY });
  assert.equal(got, null, 'valid-but-corrupt generic row must not silently fall back to stale legacy');
});

test('F5: no generic row -> legacy fallback (anthropic migration window)', async () => {
  const pool = makeDb((sql) => {
    if (/SELECT status, secret_last4, secret_enc/.test(sql)) return { rows: [] };
    if (/SELECT anthropic_key_enc AS enc\s+FROM users/i.test(sql)) return { rows: [{ enc: sk('sk-ant-api03-legacy') }] };
    return { rows: [] };
  });
  const got = await store.readSecret({ pool, userId: 3, provider: 'anthropic', purpose: 'coding_agent', dataKey: DATA_KEY });
  assert.equal(got, 'sk-ant-api03-legacy');
});

test('F5: no generic row -> no secret for non-anthropic', async () => {
  const pool = makeDb((sql) => {
    if (/SELECT status, secret_last4, secret_enc/.test(sql)) return { rows: [] };
    return { rows: [] };
  });
  const got = await store.readSecret({ pool, userId: 3, provider: 'openrouter', purpose: 'coding_agent', dataKey: DATA_KEY });
  assert.equal(got, null);
});

// ── Rollback reconciliation is expressed in schema.sql (F2) ────────────
test('F2: schema reconciliation is authoritative (no valid-row skip)', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  // The legacy->generic INSERT must NOT carry a guard that skips valid rows.
  const insert = schema.match(/ON CONFLICT \(user_id, provider, purpose\) DO UPDATE SET[\s\S]*?revision = credentials.user_ai_credentials.revision \+ 1,[\s\S]*?updated_at = NOW\(\)[\s\S]*?;/);
  assert.ok(insert, 'reconciliation upsert exists');
  assert.ok(!/status IS DISTINCT FROM 'valid'/.test(schema), 'must not skip valid rows during reconciliation');
  // A valid generic row with no legacy must be revoked (legacy delete wins).
  assert.match(schema, /AND g\.status = 'valid'/, 'valid-without-legacy rows are tombstoned');
  assert.match(schema, /NOT EXISTS \(\s*SELECT 1 FROM users/, 'tombstone keyed on missing legacy');
  // The reconciliation tombstone must clear verified_at to satisfy the
  // valid_verified CHECK (non-valid rows require verified_at NULL), or the
  // UPDATE fails and breaks roll-forward after a rollback deletion.
  assert.match(schema, /verified_at = NULL,/, 'reconciliation tombstone clears verified_at');
});
