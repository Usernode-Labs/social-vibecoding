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
  await assert.rejects(() => store.upsert({ pool, provider: 'openrouter', purpose: 'nope', userId: 1 }));
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

// Task 2275: people's own Anthropic keys are gone. The table keeps its
// tombstones ('anthropic' stays in its CHECK), but nothing here may write,
// read or revoke one, and the legacy users.anthropic_key_* mirror is gone.
test('anthropic is no longer a provider the store reads or writes', async () => {
  assert.deepEqual(store.PROVIDERS, ['openrouter']);
  const pool = makeDb(() => ({ rows: [] }));
  await assert.rejects(() => store.upsert({
    pool, userId: 1, provider: 'anthropic', purpose: 'coding_agent', secretEnc: sk('k'), secretLast4: 'xxxx',
  }), /unknown provider anthropic/);
  await assert.rejects(() => store.readSecret({ pool, userId: 1, provider: 'anthropic', purpose: 'coding_agent', dataKey: DATA_KEY }),
    /unknown provider anthropic/);
  await assert.rejects(() => store.revoke({ pool, userId: 1, provider: 'anthropic', purpose: 'coding_agent' }),
    /unknown provider anthropic/);
  for (const gone of ['writeAnthropicCodingAgent', 'deleteAnthropicCodingAgent', 'readLegacyAnthropic', 'LEGACY_ANTHROPIC_COLUMNS']) {
    assert.equal(gone in store, false, `${gone} is gone`);
  }
  assert.equal(pool.ops().length, 0, 'not one query was sent');
});

test('fingerprint is deterministic, 64-hex, distinct from plaintext', () => {
  const a = store.fingerprint('sk-or-v1-abc', DATA_KEY);
  assert.equal(a, store.fingerprint('sk-or-v1-abc', DATA_KEY));
  assert.notEqual(a, store.fingerprint('sk-or-v1-abd', DATA_KEY));
  assert.notEqual(a, 'sk-or-v1-abc');
  assert.match(a, /^[0-9a-f]{64}$/);
});

// ── Revocation (F1 delete-save race, F2 authoritative) ─────────────────
test('F1: revoke issues an UPSERT tombstone (locks row even when absent)', async () => {
  const pool = makeDb((sql) => {
    if (/INSERT INTO credentials.user_ai_credentials/.test(sql)) return { rows: [{ status: 'revoked', revision: 1 }] };
    return { rows: [] };
  });
  await store.revoke({ pool, userId: 9, provider: 'openrouter', purpose: 'coding_agent' });
  const sqls = pool.ops().map((o) => o.sql);
  const insert = sqls.find((s) => /INSERT INTO credentials.user_ai_credentials/.test(s));
  assert.ok(insert, 'revoke uses INSERT ... ON CONFLICT');
  assert.match(insert, /ON CONFLICT/, 'revoke upserts (not a zero-row UPDATE)');
  assert.match(insert, /status = 'revoked'/, 'tombstone status set');
  assert.match(insert, /verified_at = NULL/, 'tombstone clears verified_at (satisfies valid_verified)');
  assert.equal(sqls.some((s) => /anthropic_key_enc/.test(s)), false, 'no legacy mirror to clear any more');
  assert.ok(pool.beginIdx() >= 0 && pool.commitIdx() > pool.beginIdx(), 'atomic revocation txn');
});

test('F2: a tombstoned row yields nothing', async () => {
  const pool = makeDb((sql) => {
    if (/SELECT status, secret_last4, secret_enc/.test(sql)) return { rows: [{ status: 'revoked', secret_last4: null, secret_enc: null }] };
    return { rows: [] };
  });
  const got = await store.readSecret({ pool, userId: 3, provider: 'openrouter', purpose: 'coding_agent', dataKey: DATA_KEY });
  assert.equal(got, null, 'a revoked credential must not resurrect a deleted key');
});

// ── Atomic read + status gating (F4) ───────────────────────────────────
test('F4: readSecret fetches status + secret in one statement (same snapshot)', async () => {
  const pool = makeDb((sql) => {
    if (/SELECT status, secret_last4, secret_enc/.test(sql)) return { rows: [{ status: 'valid', secret_last4: 'abcd', secret_enc: sk('sk-or-ok') }] };
    return { rows: [] };
  });
  const got = await store.readSecret({ pool, userId: 1, provider: 'openrouter', purpose: 'coding_agent', dataKey: DATA_KEY });
  assert.equal(got, 'sk-or-ok');
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
    const got = await store.readSecret({ pool, userId: 1, provider: 'openrouter', purpose: 'coding_agent', dataKey: DATA_KEY });
    assert.equal(got, null, `status=${status} must not be usable`);
  }
});

test('F5: a valid row that fails decryption yields nothing', async () => {
  const pool = makeDb((sql) => {
    if (/SELECT status, secret_last4, secret_enc/.test(sql)) return { rows: [{ status: 'valid', secret_last4: 'abcd', secret_enc: 'v1:broken:broken:broken' }] };
    return { rows: [] };
  });
  const got = await store.readSecret({ pool, userId: 1, provider: 'openrouter', purpose: 'coding_agent', dataKey: DATA_KEY });
  assert.equal(got, null, 'a valid-but-corrupt row must not be substituted by anything');
});

test('F5: no row -> no secret', async () => {
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

test('mergeKeyInfoOnClient patches only the stored key-info and reports whether a row matched', async () => {
  const pool = makeDb((sql) => (/RETURNING id/.test(sql) ? { rows: [{ id: 5 }] } : { rows: [] }));
  const client = await pool.connect();
  const merged = await store.mergeKeyInfoOnClient({
    client, userId: 7, provider: 'openrouter', purpose: 'coding_agent',
    keyInfo: { limit: 7, limitReset: 'weekly' },
  });
  assert.equal(merged, true);
  const op = pool.ops().find((o) => /jsonb_set\(metadata, '\{keyInfo\}'/.test(o.sql));
  assert.ok(op, 'the merge targets the keyInfo object inside the metadata column');
  assert.match(op.sql, /WHERE user_id = \$1 AND provider = \$2 AND purpose = \$3/);
  assert.deepEqual(op.params, [7, 'openrouter', 'coding_agent', { limit: 7, limitReset: 'weekly' }]);
  assert.doesNotMatch(op.sql, /secret_enc|revision|status/, 'ciphertext, revision and status are untouched');

  const missing = makeDb(() => ({ rows: [] }));
  assert.equal(await store.mergeKeyInfoOnClient({
    client: await missing.connect(), userId: 8, provider: 'openrouter', purpose: 'coding_agent', keyInfo: {},
  }), false);
  await assert.rejects(
    () => store.mergeKeyInfoOnClient({ client, userId: 7, provider: 'openrouter', purpose: 'nope', keyInfo: {} }),
    /unknown purpose/,
  );
});
