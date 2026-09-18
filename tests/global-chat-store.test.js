'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const store = require('../src/services/global-chat/store');

const THREAD = '95df0790-4873-43cc-9608-728f3349da50';
const RUN = '505b2a90-995d-4f25-85d2-d36641d18d4a';
const DATA_KEY = 'global-chat-store-test-key';

test('private persisted values are sealed and recover byte-for-byte JSON', () => {
  const value = { bodyJson: '{"secret":"do-not-store-plain"}', nested: { b: 2, a: 1 } };
  const sealed = store.sealJson(value, DATA_KEY);
  assert.equal(sealed.version, 1);
  assert.match(sealed.ciphertext, /^v1:/);
  assert.doesNotMatch(JSON.stringify(sealed), /do-not-store-plain/);
  assert.deepEqual(store.openJson(sealed, DATA_KEY), value);
  assert.throws(() => store.openJson(sealed, 'wrong-key'), /cannot be read/);
});

test('thread turn claims use a durable stale lease and exact release id', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SET active_turn_id = \$3/.test(sql)) return { rows: [{ active_turn_id: RUN }] };
      return { rows: [], rowCount: 1 };
    },
  };
  const claimed = await store.claimTurn(pool, {
    userId: 7, threadId: THREAD, turnId: RUN,
    now: new Date('2026-09-18T12:00:00Z'),
  });
  assert.equal(claimed, RUN);
  const claim = calls[0];
  assert.match(claim.sql, /active_turn_started_at < \$5/);
  assert.equal(claim.params[4].toISOString(), '2026-09-18T11:50:00.000Z');
  assert.equal(await store.releaseTurn(pool, { userId: 7, threadId: THREAD, turnId: RUN }), true);
  assert.match(calls[1].sql, /active_turn_id = \$3/);
});

test('a concurrent turn is refused without silently stealing its lease', async () => {
  const pool = { async query() { return { rows: [] }; } };
  await assert.rejects(
    store.claimTurn(pool, { userId: 7, threadId: THREAD, turnId: RUN }),
    (error) => error.code === 'turn_in_progress',
  );
});

test('tool-run storage seals both action input and authoritative result', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/INSERT INTO global_chat_tool_runs/.test(sql)) return { rows: [{ id: params[0] }] };
      return { rows: [{ id: params[0] }], rowCount: 1 };
    },
  };
  const runId = await store.startToolRun(pool, {
    userId: 7,
    threadId: THREAD,
    messageId: '4',
    capabilityId: 'settings.update.api-key',
    input: { bodyJson: '{"apiKey":"sk-private"}' },
    dataKey: DATA_KEY,
  });
  assert.match(runId, /^[0-9a-f-]{36}$/);
  const insert = calls[0];
  assert.doesNotMatch(JSON.stringify(insert.params), /sk-private/);
  assert.equal(store.openJson(JSON.parse(insert.params[5]), DATA_KEY).bodyJson,
    '{"apiKey":"sk-private"}');

  await store.finishToolRun(pool, {
    userId: 7,
    toolRunId: runId,
    modelResult: { ok: true, data: { secret: undefined } },
    authoritativeResult: { ok: true, data: { secret: 'browser-only' } },
    renderer: 'setting',
    classicPath: '#settings/api-key',
    durationMs: 12,
    dataKey: DATA_KEY,
  });
  const finish = calls[1];
  assert.doesNotMatch(JSON.stringify(finish.params), /browser-only/);
  assert.equal(store.openJson(JSON.parse(finish.params[3]), DATA_KEY).data.secret, 'browser-only');
});

test('result reads require thread ownership and decrypt only selected authoritative results', async () => {
  const authoritative = { ok: true, data: { id: 9, title: 'Result' } };
  const pool = {
    async query(sql, params) {
      assert.match(sql, /JOIN global_chat_threads/);
      assert.deepEqual(params, [THREAD, 7, [RUN]]);
      return { rows: [{
        id: RUN,
        capability_id: 'issues.get.item',
        bounded_model_result: { ok: true, data: { id: 9 } },
        authoritative_result: store.sealJson(authoritative, DATA_KEY),
        renderer: 'issue',
        classic_path: '#app/demo/dev/issues/9',
        status: 'completed',
        created_at: '2026-09-18T12:00:00Z',
        completed_at: '2026-09-18T12:00:01Z',
      }] };
    },
  };
  const rows = await store.loadToolResults(pool, {
    userId: 7, threadId: THREAD, resultIds: [RUN, RUN], dataKey: DATA_KEY,
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].authoritativeResult, authoritative);
  assert.equal(rows[0].classicPath, '#app/demo/dev/issues/9');
});

test('messages are bounded and returned chronologically with an opaque cursor', async () => {
  const pool = {
    async query(sql, params) {
      assert.match(sql, /ORDER BY m\.id DESC/);
      assert.equal(params[3], 3);
      return { rows: [
        { id: 5, thread_id: THREAD, role: 'assistant', plain_text: 'Newest', structured_payload: {}, created_at: '2026-09-18T12:02:00Z' },
        { id: 4, thread_id: THREAD, role: 'user', plain_text: 'Middle', structured_payload: {}, created_at: '2026-09-18T12:01:00Z' },
        { id: 3, thread_id: THREAD, role: 'assistant', plain_text: 'Older', structured_payload: {}, created_at: '2026-09-18T12:00:00Z' },
      ] };
    },
  };
  const page = await store.listMessages(pool, {
    userId: 7, threadId: THREAD, before: '6', limit: 2,
  });
  assert.deepEqual(page.messages.map(({ id }) => id), ['4', '5']);
  assert.equal(page.hasMore, true);
  assert.equal(page.before, '4');
  await assert.rejects(
    store.listMessages(pool, { userId: 7, threadId: THREAD, before: '1 OR 1=1' }),
    (error) => error.code === 'invalid_cursor',
  );
});

test('schema carries restart-safe turn leases above the standalone tail', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  const marker = schema.indexOf('EVERYTHING BELOW THIS LINE MUST STAND UP ON ITS OWN.');
  const table = schema.indexOf('CREATE TABLE IF NOT EXISTS global_chat_threads');
  assert.ok(table > 0 && table < marker);
  assert.match(schema.slice(table, marker), /active_turn_id\s+UUID/);
  assert.match(schema.slice(table, marker), /active_turn_started_at\s+TIMESTAMPTZ/);
});
