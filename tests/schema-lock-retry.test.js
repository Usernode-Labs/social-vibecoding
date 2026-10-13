'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src/db/migrate.js'), 'utf8');
const start = source.indexOf('const SCHEMA_LOCK_TIMEOUT =');
const end = source.indexOf('async function auditDuplicatePrSessions(', start);
assert.ok(start >= 0 && end > start, 'load the schema retry helper and its diagnostics');

const schema = 'ALTER TABLE users ADD COLUMN IF NOT EXISTS example TEXT;\n'
  + 'ALTER TABLE apps ADD COLUMN IF NOT EXISTS example TEXT;';
const pgError = (code) => Object.assign(new Error(`PostgreSQL ${code}`), { code });

// Execute the real helper with a capacity-one pool and an immediate clock.
// Pool queries have to acquire that same slot: keeping the migration client
// while inspecting blockers would hang here just as it does with max: 1.
function harness({ failures = [], setupError, diagnosticError } = {}) {
  const clients = [];
  const diagnostics = [];
  const warnings = [];
  const delays = [];
  const waiting = [];
  let occupied = false;
  let attempt = 0;

  async function acquire() {
    if (occupied) await new Promise((resolve) => waiting.push(resolve));
    occupied = true;
  }

  function releaseSlot() {
    occupied = false;
    waiting.shift()?.();
  }

  const pool = {
    async connect() {
      await acquire();
      const failure = failures[attempt++];
      const record = { queries: [], released: [] };
      clients.push(record);
      return {
        async query(sql) {
          record.queries.push(sql);
          if (sql === schema) {
            if (failure) throw failure;
          } else if (setupError) {
            throw setupError;
          }
          return { rows: [] };
        },
        release(destroy) {
          record.released.push(destroy);
          releaseSlot();
        },
      };
    },
    async query(sql) {
      await acquire();
      diagnostics.push(sql);
      try {
        if (diagnosticError) throw diagnosticError;
        return { rows: [{ pid: 123, application_name: 'platform' }] };
      } finally {
        releaseSlot();
      }
    },
  };

  const applySchema = vm.runInNewContext(`${source.slice(start, end)}\napplySchemaWithLockRetry;`, {
    log: { warn(area, message, detail) { warnings.push({ area, message, detail }); } },
    setTimeout(resolve, milliseconds) {
      assert.equal(occupied, false, 'the pool slot is free during retry backoff');
      delays.push(milliseconds);
      resolve();
    },
  }, { filename: 'src/db/migrate.js#schema-retry' });

  return {
    run: () => applySchema(pool, schema), clients, diagnostics, warnings, delays,
  };
}

function assertAttemptClients(clients, expectedCount) {
  assert.equal(clients.length, expectedCount);
  for (const client of clients) {
    assert.deepEqual(client.queries, ["SET lock_timeout = '10s'", schema],
      'each fresh session configures the lock timeout and applies the whole schema');
    assert.deepEqual(client.released, [true],
      'destroy each session exactly once so its lock_timeout cannot leak');
  }
}

test('schema success destroys its session without diagnostics or retry delay', async () => {
  const h = harness();
  await h.run();

  assertAttemptClients(h.clients, 1);
  assert.equal(h.diagnostics.length, 0);
  assert.equal(h.warnings.length, 0);
  assert.deepEqual(h.delays, []);
});

for (const code of ['40P01', '55P03']) {
  test(`${code} retries the whole schema with a fresh client in a capacity-one pool`, { timeout: 1000 }, async () => {
    const h = harness({ failures: [pgError(code)] });
    await h.run();

    assertAttemptClients(h.clients, 2);
    assert.equal(h.diagnostics.length, 1);
    assert.deepEqual(h.delays, [3000]);
    const retry = h.warnings.find(({ detail }) => detail.code === code);
    assert.ok(retry, 'the retry warning includes the PostgreSQL error code');
    assert.equal(retry.detail.attempt, 1);
    assert.equal(retry.detail.maxAttempts, 25);
    if (code === '40P01') assert.match(retry.message, /deadlock/i);
    assert.ok(h.warnings.some(({ detail }) => detail.sessions?.[0]?.pid === 123),
      'blocker diagnostics finish before the retry despite pool capacity one');
  });

  test(`${code} stops after 25 attempts and propagates the last PostgreSQL error`, { timeout: 1000 }, async () => {
    const failures = Array.from({ length: 25 }, () => pgError(code));
    const h = harness({ failures });
    await assert.rejects(h.run(), (error) => error === failures.at(-1));

    assertAttemptClients(h.clients, 25);
    assert.equal(h.diagnostics.length, 24);
    assert.deepEqual(h.delays, Array(24).fill(3000));
  });
}

for (const code of ['42601', '23505', undefined]) {
  test(`nonretryable error ${code ?? 'without a code'} escapes unchanged and destroys its session`, async () => {
    const failure = pgError(code);
    const h = harness({ failures: [failure] });
    await assert.rejects(h.run(), (error) => error === failure);

    assertAttemptClients(h.clients, 1);
    assert.equal(h.diagnostics.length, 0);
    assert.equal(h.warnings.length, 0);
    assert.deepEqual(h.delays, []);
  });
}

test('failing diagnostics do not prevent recovery from a deadlock', { timeout: 1000 }, async () => {
  const h = harness({ failures: [pgError('40P01')], diagnosticError: new Error('cannot inspect sessions') });
  await h.run();

  assertAttemptClients(h.clients, 2);
  assert.equal(h.diagnostics.length, 1);
  assert.deepEqual(h.delays, [3000]);
  assert.ok(h.warnings.some(({ detail }) => detail.message === 'cannot inspect sessions'));
});

test('a failed lock-timeout setup destroys the session without applying the schema', async () => {
  const failure = pgError('08006');
  const h = harness({ setupError: failure });
  await assert.rejects(h.run(), (error) => error === failure);

  assert.equal(h.clients.length, 1);
  assert.deepEqual(h.clients[0].queries, ["SET lock_timeout = '10s'"]);
  assert.deepEqual(h.clients[0].released, [true]);
  assert.equal(h.diagnostics.length, 0);
  assert.deepEqual(h.delays, []);
});
