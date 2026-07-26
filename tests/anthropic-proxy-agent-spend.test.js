// #800: the per-change coding-agent spend ledger
// (chat_sessions.agent_cost_cents, written by routes/anthropic-proxy.js).
//
// This ledger has NO reader and NO UI — nothing renders it yet, and its
// whole purpose is to accumulate correct history for a cost figure shown
// later. That makes this test the only thing standing between it and a
// silent regression: if the write breaks, or a gate inverts, nobody finds
// out until months of history are already wrong and unbackfillable
// (llm_usage has no session or model dimension to reconstruct from).
//
// Two layers:
//   1. noteAgentSpend's behaviour — the increment, the three
//      "don't record it" gates, and the swallow-on-failure contract.
//   2. A source guard that BOTH settle points (BYOK and platform key)
//      actually call it. Driving the real route would need the auth
//      middleware, the worker registry, limits and a live stream stub;
//      the wiring is better checked structurally than not at all.
//
// Run with: node --test tests/anthropic-proxy-agent-spend.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const proxy = require('../src/routes/anthropic-proxy');
const { noteAgentSpend } = proxy;

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'anthropic-proxy.js'),
  'utf8'
);

// Records every query the ledger issues. `fail: true` makes the pool
// reject, so the swallow contract can be exercised.
function stubPool({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    query: (sql, params) => {
      calls.push({ sql, params });
      return fail
        ? Promise.reject(new Error('connection terminated'))
        : Promise.resolve({ rowCount: 1 });
    },
  };
}

// noteAgentSpend is fire-and-forget by contract (never awaited into the
// response path), so its promise settles on a later microtask tick.
const settle = () => new Promise((r) => setImmediate(r));

// ── The increment ───────────────────────────────────────────────────

test('a settled call accumulates its cost onto the session row', async () => {
  const pool = stubPool();
  noteAgentSpend(pool, { sessionId: 42, costCents: 13.5, isSyncTurn: false });
  await settle();

  assert.equal(pool.calls.length, 1);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /UPDATE chat_sessions/);
  // Must ACCUMULATE, not overwrite — one turn makes many agent calls.
  assert.match(sql, /agent_cost_cents\s*=\s*agent_cost_cents\s*\+/);
  assert.match(sql, /WHERE id = \$2/);
  assert.deepEqual(params, [13.5, 42]);
});

test('successive calls each issue their own increment', async () => {
  const pool = stubPool();
  noteAgentSpend(pool, { sessionId: 7, costCents: 1, isSyncTurn: false });
  noteAgentSpend(pool, { sessionId: 7, costCents: 2.25, isSyncTurn: false });
  await settle();

  assert.equal(pool.calls.length, 2);
  assert.deepEqual(pool.calls.map((c) => c.params[0]), [1, 2.25]);
});

test('fractional cents are preserved, not rounded away', async () => {
  const pool = stubPool();
  noteAgentSpend(pool, { sessionId: 3, costCents: 0.0417, isSyncTurn: false });
  await settle();
  assert.equal(pool.calls[0].params[0], 0.0417);
});

// ── The gates ───────────────────────────────────────────────────────

test('a sync turn records nothing', async () => {
  const pool = stubPool();
  noteAgentSpend(pool, { sessionId: 42, costCents: 99, isSyncTurn: true });
  await settle();
  assert.equal(pool.calls.length, 0, 'sync turns bill system_token_usage, not the change');
});

test('a zero-cost call records nothing', async () => {
  const pool = stubPool();
  noteAgentSpend(pool, { sessionId: 42, costCents: 0, isSyncTurn: false });
  await settle();
  assert.equal(pool.calls.length, 0);
});

test('a missing or unusable session id records nothing', async () => {
  for (const sessionId of [undefined, null, 0, '']) {
    const pool = stubPool();
    noteAgentSpend(pool, { sessionId, costCents: 5, isSyncTurn: false });
    await settle();
    assert.equal(pool.calls.length, 0, `sessionId ${JSON.stringify(sessionId)} should not write`);
  }
});

test('a non-numeric or negative cost records nothing', async () => {
  for (const costCents of [undefined, null, NaN, 'abc', -3]) {
    const pool = stubPool();
    noteAgentSpend(pool, { sessionId: 42, costCents, isSyncTurn: false });
    await settle();
    assert.equal(pool.calls.length, 0, `costCents ${String(costCents)} should not write`);
  }
});

// ── The swallow contract ────────────────────────────────────────────

test('a rejecting pool is swallowed — bookkeeping never fails a turn', async () => {
  const pool = stubPool({ fail: true });
  assert.doesNotThrow(() => {
    noteAgentSpend(pool, { sessionId: 42, costCents: 5, isSyncTurn: false });
  });
  await settle();
  assert.equal(pool.calls.length, 1, 'it still attempted the write');
});

test('a synchronously throwing pool is swallowed too', async () => {
  const pool = { query: () => { throw new Error('pool is closed'); } };
  assert.doesNotThrow(() => {
    noteAgentSpend(pool, { sessionId: 42, costCents: 5, isSyncTurn: false });
  });
  await settle();
});

test('noteAgentSpend returns undefined, never a promise to await', () => {
  const pool = stubPool();
  assert.equal(
    noteAgentSpend(pool, { sessionId: 42, costCents: 5, isSyncTurn: false }),
    undefined,
    'awaiting it would put a bookkeeping write in the response path'
  );
});

// ── Wiring: both settle points ──────────────────────────────────────

// The lookbehind skips the `function noteAgentSpend(pool, { … })`
// declaration, which otherwise matches the same shape as a call.
const CALL_SITE_RE = /(?<!function )noteAgentSpend\(pool, \{/g;

test('both settle points call the ledger', () => {
  const callSites = SRC.match(CALL_SITE_RE) || [];
  assert.equal(
    callSites.length, 2,
    'expected exactly two call sites — the BYOK branch and the platform-key branch'
  );
});

test('the BYOK branch records alongside noteTurnByokSpend', () => {
  // The BYOK settle is identifiable by the per-turn BYOK tally next to it.
  const byokBlock = SRC.slice(
    SRC.indexOf('workerMod.noteTurnByokSpend'),
    SRC.indexOf('BYOK key rejected by Anthropic upstream')
  );
  assert.match(byokBlock, /noteAgentSpend\(pool, \{/);
});

test('the platform-key branch records alongside the live-delta fold', () => {
  const platformBlock = SRC.slice(
    SRC.indexOf('globalBudgetCache.liveDeltaCents +='),
    SRC.indexOf("'Killed call settled'")
  );
  assert.match(platformBlock, /noteAgentSpend\(pool, \{/);
});

test('every call site forwards isSyncTurn so the gate can fire', () => {
  for (const site of SRC.match(/(?<!function )noteAgentSpend\(pool, \{[^}]*\}/g) || []) {
    assert.match(site, /isSyncTurn/, `call site missing isSyncTurn: ${site}`);
    assert.match(site, /sessionId/, `call site missing sessionId: ${site}`);
    assert.match(site, /costCents/, `call site missing costCents: ${site}`);
  }
});

test('the schema declares the accumulating column with a zero default', () => {
  const schema = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'db', 'schema.sql'),
    'utf8'
  );
  assert.match(
    schema,
    /ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS agent_cost_cents NUMERIC\(12,4\) NOT NULL DEFAULT 0/
  );
  // The "filter agent_cost_cents > 0" caveat is the one thing a future
  // reader must not miss, so it has to be written down next to the column.
  assert.match(schema, /agent_cost_cents > 0/);
});
