// Unit tests for the admin /debug capture service (services/merge-debug.js).
//
// Guarantees:
//   1. startRun / step / endRun NEVER throw — not on a failing pool, not on
//      a synchronous throw, not on a null runId. Capture is best-effort and
//      must never break the merge it describes.
//   2. Secret patterns in a step's message + detail are redacted before the
//      INSERT (same SENSITIVE_PATTERNS the /status ring buffer uses).
//   3. seq is monotonic per run.
//
// Run with: node --test tests/merge-debug.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const md = require('../src/services/merge-debug');

// Mock pool that records every query and lets a handler script the result.
function makePool(handler) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (handler) return handler(sql, params);
      // Default: startRun's RETURNING id yields 1.
      if (/INSERT INTO merge_debug_runs/.test(sql)) return { rows: [{ id: 1 }] };
      return { rows: [], rowCount: 0 };
    },
  };
}

test('startRun returns the new run id', async () => {
  const pool = makePool();
  const runId = await md.startRun(pool, { appId: 5, sessionId: 9, prNumber: 42, kind: 'merge', trigger: 'vote' });
  assert.equal(runId, 1);
  const insert = pool.calls.find((c) => /INSERT INTO merge_debug_runs/.test(c.sql));
  assert.ok(insert);
  assert.deepEqual(insert.params.slice(0, 5), [5, 9, 42, 'merge', 'vote']);
});

test('startRun returns null and never throws when the pool fails', async () => {
  const pool = makePool(() => { throw new Error('db down'); });
  const runId = await md.startRun(pool, { appId: 1, sessionId: 2 });
  assert.equal(runId, null);
});

test('step is a no-op on a null runId and never throws', async () => {
  const pool = makePool();
  await md.step(pool, null, { phase: 'x', message: 'hi' }); // must not throw
  assert.equal(pool.calls.length, 0);
});

test('step never throws when the insert rejects', async () => {
  const pool = makePool((sql) => {
    if (/INSERT INTO merge_debug_steps/.test(sql)) return Promise.reject(new Error('boom'));
    return { rows: [{ id: 1 }] };
  });
  const runId = await md.startRun(pool, {});
  await md.step(pool, runId, { phase: 'p', message: 'm' }); // resolves, swallows the rejection
});

test('step redacts secrets in message and detail before persisting', async () => {
  const pool = makePool();
  const runId = await md.startRun(pool, {});
  const token = 'ghp_' + 'a'.repeat(30);
  await md.step(pool, runId, {
    phase: 'github_merge',
    level: 'error',
    message: `merge failed for ${token}`,
    detail: { url: `https://x-access-token:${token}@github.com/o/r.git`, note: 'fine' },
  });
  const stepInsert = pool.calls.find((c) => /INSERT INTO merge_debug_steps/.test(c.sql));
  assert.ok(stepInsert, 'a step row was inserted');
  const [, , phase, level, message, detailJson] = stepInsert.params;
  assert.equal(phase, 'github_merge');
  assert.equal(level, 'error');
  assert.ok(!message.includes(token), 'token scrubbed from message');
  assert.ok(message.includes('****'), 'message carries the redaction marker');
  assert.ok(!detailJson.includes(token), 'token scrubbed from detail');
  assert.ok(detailJson.includes('fine'), 'non-secret detail preserved');
});

test('step assigns a monotonic seq per run', async () => {
  const pool = makePool();
  const runId = await md.startRun(pool, {});
  await md.step(pool, runId, { message: 'a' });
  await md.step(pool, runId, { message: 'b' });
  await md.step(pool, runId, { message: 'c' });
  const seqs = pool.calls
    .filter((c) => /INSERT INTO merge_debug_steps/.test(c.sql))
    .map((c) => c.params[1]);
  assert.deepEqual(seqs, [0, 1, 2]);
});

test('an unknown level falls back to info', async () => {
  const pool = makePool();
  const runId = await md.startRun(pool, {});
  await md.step(pool, runId, { message: 'x', level: 'bogus' });
  const stepInsert = pool.calls.find((c) => /INSERT INTO merge_debug_steps/.test(c.sql));
  assert.equal(stepInsert.params[3], 'info');
});

test('endRun stamps status + summary and never throws', async () => {
  const pool = makePool();
  const runId = await md.startRun(pool, {});
  await md.endRun(pool, runId, { status: 'merged', summary: 'done' });
  const upd = pool.calls.find((c) => /UPDATE merge_debug_runs/.test(c.sql));
  assert.ok(upd);
  assert.deepEqual(upd.params, [runId, 'merged', 'done']);
});

test('endRun on a null runId is a no-op', async () => {
  const pool = makePool();
  await md.endRun(pool, null, { status: 'merged' });
  assert.equal(pool.calls.length, 0);
});

test('pruneOldRuns issues a bounded DELETE and never throws', async () => {
  const pool = makePool((sql) => {
    if (/DELETE FROM merge_debug_runs/.test(sql)) return { rowCount: 3 };
    return { rows: [] };
  });
  const n = await md.pruneOldRuns(pool, 30);
  assert.equal(n, 3);
  const del = pool.calls.find((c) => /DELETE FROM merge_debug_runs/.test(c.sql));
  assert.ok(del);
});

// ── kind='checks': the proposal-checks timing trace ─────────────────────
// The tracer is kind-agnostic by design, so the checks pipeline reuses it
// rather than growing a parallel table. These pin that the new kind and its
// verdict statuses round-trip, and that a duration-bearing step keeps its
// detail intact (the durations are the entire point of the trace).

test("a kind='checks' run round-trips its kind and trigger", async () => {
  const pool = makePool();
  const runId = await md.startRun(pool, {
    appId: 1, sessionId: 2951, prNumber: 914, kind: 'checks', trigger: 'capture',
  });
  const ins = pool.calls.find((c) => /INSERT INTO merge_debug_runs/.test(c.sql));
  assert.deepEqual(ins.params, [1, 2951, 914, 'checks', 'capture']);
  assert.equal(runId, 1);
});

test('a checks step carries its durationMs through to the stored detail', async () => {
  const pool = makePool();
  const runId = await md.startRun(pool, { kind: 'checks' });
  await md.step(pool, runId, {
    phase: 'clone', message: 'Preview database cloned', detail: { durationMs: 21870 },
  });
  const ins = pool.calls.find((c) => /INSERT INTO merge_debug_steps/.test(c.sql));
  assert.equal(ins.params[2], 'clone');
  assert.deepEqual(JSON.parse(ins.params[5]), { durationMs: 21870 });
});

test('a checks run closes on its suite verdict rather than a merge outcome', async () => {
  for (const status of ['passing', 'failing', 'skipped', 'error']) {
    const pool = makePool();
    const runId = await md.startRun(pool, { kind: 'checks' });
    await md.endRun(pool, runId, { status, summary: `checks ${status} in 42s` });
    const upd = pool.calls.find((c) => /UPDATE merge_debug_runs/.test(c.sql));
    assert.deepEqual(upd.params, [runId, status, `checks ${status} in 42s`]);
  }
});

test('tracing never throws when the run insert fails — a null id no-ops every call', async () => {
  // captureForSession traces unconditionally, so a debug-table failure must
  // never be able to fail a checks run.
  const pool = makePool((sql) => {
    if (/INSERT INTO merge_debug_runs/.test(sql)) throw new Error('table missing');
    return { rows: [] };
  });
  const runId = await md.startRun(pool, { kind: 'checks' });
  assert.equal(runId, null);
  await md.step(pool, runId, { phase: 'clone', detail: { durationMs: 1 } });
  await md.endRun(pool, runId, { status: 'passing' });
  assert.ok(!pool.calls.some((c) => /INSERT INTO merge_debug_steps/.test(c.sql)));
  assert.ok(!pool.calls.some((c) => /UPDATE merge_debug_runs/.test(c.sql)));
});
