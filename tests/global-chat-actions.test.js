'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ActionConfirmationError,
  consumeAction,
  normalizedJson,
  openedInput,
  prepareAction,
  sealedInput,
  sha256,
} = require('../src/services/global-chat/actions');

const THREAD = '95df0790-4873-43cc-9608-728f3349da50';
const DATA_KEY = 'test-only-data-key';

test('prepared confirmations store only a token hash and sealed exact input', async () => {
  let insert;
  const pool = {
    async query(sql, params) {
      insert = { sql, params };
      return { rows: [{ id: params[0] }] };
    },
  };
  const action = await prepareAction(pool, {
    userId: 7,
    threadId: THREAD,
    capabilityId: 'settings.update.api-key',
    input: { bodyJson: '{"apiKey":"sk-private"}', query: [], pathParameters: {} },
    objectRevision: 'revision-4',
    dataKey: DATA_KEY,
    now: new Date('2026-09-18T12:00:00Z'),
    ttlMs: 60_000,
  });
  assert.match(action.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(action.expiresAt, '2026-09-18T12:01:00.000Z');
  assert.equal(insert.params[1], sha256(action.token));
  assert.doesNotMatch(JSON.stringify(insert.params), /sk-private/);
  const envelope = JSON.parse(insert.params[5]);
  const opened = openedInput(envelope, DATA_KEY);
  assert.deepEqual(opened.input, {
    bodyJson: '{"apiKey":"sk-private"}', pathParameters: {}, query: [],
  });
  assert.equal(insert.params[6], sha256(opened.json));
  assert.doesNotMatch(insert.sql, /raw_token/);
});

function consumePool(row) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT id, capability_id/.test(sql)) return { rows: row ? [row] : [] };
      if (/UPDATE global_chat_action_tokens/.test(sql)) return { rows: [{ id: row.id }] };
      return { rows: [] };
    },
    release() { calls.push({ sql: 'RELEASE' }); },
  };
  return { calls, pool: { async connect() { return client; } } };
}

test('confirmation consumes once and recovers the server-prepared input, not client input', async () => {
  const token = 'b'.repeat(43);
  const json = normalizedJson({ pathParameters: { id: '12' }, query: [], bodyJson: '{}' });
  const row = {
    id: '505b2a90-995d-4f25-85d2-d36641d18d4a',
    capability_id: 'issues.delete.apps.item.issues.item.deadbeef',
    normalized_input: sealedInput(json, DATA_KEY),
    input_hash: sha256(json),
    object_revision: 'etag-2',
    expires_at: new Date('2026-09-18T12:05:00Z'),
  };
  const fake = consumePool(row);
  const action = await consumeAction(fake.pool, {
    token,
    userId: 7,
    threadId: THREAD,
    capabilityId: row.capability_id,
    dataKey: DATA_KEY,
    now: new Date('2026-09-18T12:01:00Z'),
    resolveObjectRevision: async ({ input }) => {
      assert.equal(input.pathParameters.id, '12');
      return 'etag-2';
    },
  });
  assert.equal(action.capabilityId, row.capability_id);
  assert.equal(action.input.pathParameters.id, '12');
  assert.ok(fake.calls.some(({ sql }) => /SET consumed_at/.test(sql)));
  assert.ok(fake.calls.some(({ sql }) => sql === 'COMMIT'));
  const select = fake.calls.find(({ sql }) => /SELECT id, capability_id/.test(sql));
  assert.equal(select.params[0], sha256(token));
  assert.notEqual(select.params[0], token);
});

test('expired, reused, wrong-user, or wrong-capability tokens share one refusal', async () => {
  const fake = consumePool(null);
  await assert.rejects(
    consumeAction(fake.pool, {
      token: 'c'.repeat(43), userId: 9, threadId: THREAD,
      capabilityId: 'issues.delete.item', dataKey: DATA_KEY,
    }),
    (error) => error instanceof ActionConfirmationError
      && error.code === 'invalid_or_expired_action',
  );
  assert.ok(fake.calls.some(({ sql }) => sql === 'ROLLBACK'));
  assert.ok(!fake.calls.some(({ sql }) => /SET consumed_at/.test(sql)));
});

test('a changed object revision refuses and leaves the token unconsumed', async () => {
  const json = normalizedJson({ pathParameters: { id: '12' }, query: [], bodyJson: '{}' });
  const row = {
    id: '505b2a90-995d-4f25-85d2-d36641d18d4a',
    capability_id: 'issues.delete.item',
    normalized_input: sealedInput(json, DATA_KEY),
    input_hash: sha256(json),
    object_revision: 'before',
  };
  const fake = consumePool(row);
  await assert.rejects(
    consumeAction(fake.pool, {
      token: 'd'.repeat(43), userId: 7, threadId: THREAD,
      capabilityId: row.capability_id, dataKey: DATA_KEY,
      resolveObjectRevision: async () => 'after',
    }),
    (error) => error.code === 'stale_action',
  );
  assert.ok(fake.calls.some(({ sql }) => sql === 'ROLLBACK'));
  assert.ok(!fake.calls.some(({ sql }) => /SET consumed_at/.test(sql)));
});

test('normalization is deterministic without mutating the original input', () => {
  const input = { z: 1, nested: { y: 2, a: 3 }, a: [{ c: 4, b: 5 }] };
  assert.equal(
    normalizedJson(input),
    '{"a":[{"b":5,"c":4}],"nested":{"a":3,"y":2},"z":1}',
  );
  assert.deepEqual(input, { z: 1, nested: { y: 2, a: 3 }, a: [{ c: 4, b: 5 }] });
});
