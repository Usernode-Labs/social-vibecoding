'use strict';
// Commit 4 (plan §6): Codex attempt accounting — cumulative provider
// totals with transactional per-attempt deltas, estimated-only cost, and
// idempotent completion. The pure helpers are tested directly; the
// completeCodexAttempt path is exercised through a stubbed transaction.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeProviderUsageDelta,
  estimateRequestedModelCost,
  pricingSnapshotForModel,
  normalizeCumulativeUsage,
  completeCodexAttempt,
  startCodexAttempt,
} = require('../src/services/agent-turn');

// ── Cumulative delta math (plan 6.5, 6.6) ──────────────────────────────
test('delta: second attempt on same thread subtracts the prior total', () => {
  const delta = computeProviderUsageDelta(
    { inputTokens: 180, outputTokens: 35, cachedInputTokens: 40, cacheWriteInputTokens: 5, reasoningOutputTokens: 2 },
    { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30, cacheWriteInputTokens: 2, reasoningOutputTokens: 1 },
  );
  assert.equal(delta.delta.inputTokens, 80);
  assert.equal(delta.delta.outputTokens, 15);
  assert.equal(delta.delta.cachedInputTokens, 10);
  assert.equal(delta.delta.cacheWriteInputTokens, 3);
  assert.equal(delta.delta.reasoningOutputTokens, 1);
  assert.equal(delta.resetDetected, false);
});

test('delta: lower new total resets baseline instead of producing negatives', () => {
  const delta = computeProviderUsageDelta(
    { inputTokens: 50, outputTokens: 10 },
    { inputTokens: 100, outputTokens: 20 },
  );
  assert.equal(delta.resetDetected, true);
  assert.equal(delta.delta.inputTokens, 50);
  assert.equal(delta.delta.outputTokens, 10);
});

test('delta: first attempt (no previous) uses full totals as the delta', () => {
  const delta = computeProviderUsageDelta(
    { inputTokens: 100, outputTokens: 20 },
    null,
  );
  assert.equal(delta.delta.inputTokens, 100);
  assert.equal(delta.delta.outputTokens, 20);
  assert.equal(delta.resetDetected, false);
});

test('delta: null current usage yields zero delta', () => {
  assert.deepEqual(computeProviderUsageDelta(null, { inputTokens: 10 }), {
    delta: { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
    resetDetected: false,
  });
});

// ── Cost estimation (plan 6.7) ─────────────────────────────────────────
test('estimate: catalog pricing × prompt/completion deltas, not exact', () => {
  const pricing = { available: true, inputPricePerMillion: 1.25, outputPricePerMillion: 10 };
  const cost = estimateRequestedModelCost(
    { inputTokens: 1_000_000, outputTokens: 100_000, reasoningOutputTokens: 0 },
    pricing,
  );
  assert.equal(cost.estimatedCostUsd, 1.25 + 1.0);
  assert.equal(cost.costSource, 'requested_model_catalog_estimate');
  assert.ok(!/exact/i.test(cost.costSource), 'never called exact');
});

test('estimate: reasoning output is not double-counted (included in output)', () => {
  const pricing = { available: true, inputPricePerMillion: 1, outputPricePerMillion: 1 };
  const cost = estimateRequestedModelCost({ inputTokens: 0, outputTokens: 100_000, reasoningOutputTokens: 90_000 }, pricing);
  assert.equal(cost.estimatedCostUsd, 0.1);
});

test('estimate: missing/invalid pricing yields unavailable, no guessed cost', () => {
  assert.deepEqual(estimateRequestedModelCost({ inputTokens: 100 }, { available: false }), {
    costSource: 'unavailable', estimatedCostUsd: null,
  });
  assert.deepEqual(estimateRequestedModelCost({ inputTokens: 100 }, { available: true, inputPricePerMillion: null }), {
    costSource: 'unavailable', estimatedCostUsd: null,
  });
});

test('pricingSnapshotForModel: requires finite nonnegative prices', () => {
  const snap = pricingSnapshotForModel({ id: 'm', inputPricePerMillion: 1.25, outputPricePerMillion: 10 });
  assert.equal(snap.available, true);
  assert.equal(snap.model, 'm');
  assert.equal(snap.inputPricePerMillion, 1.25);
  assert.equal(snap.outputPricePerMillion, 10);
  assert.match(snap.pricingAssumption, /ordinary prompt rate/);
  assert.equal(pricingSnapshotForModel({ id: 'm', inputPricePerMillion: null, outputPricePerMillion: 10 }).available, false);
  assert.equal(pricingSnapshotForModel(null), null);
});

// ── Cumulative usage normalization (plan 5.6) ──────────────────────────
test('normalizeCumulativeUsage: missing totals stay null, not zero', () => {
  assert.deepEqual(normalizeCumulativeUsage({ inputTokens: 5, outputTokens: null }), {
    inputTokens: 5, cachedInputTokens: null, cacheWriteInputTokens: null,
    outputTokens: null, reasoningOutputTokens: null,
  });
  assert.equal(normalizeCumulativeUsage(null), null);
});

// ── Start + idempotent completion over a stubbed transaction ──────────
function makeTransactionPool() {
  // A tiny in-memory stub that behaves like BEGIN/COMMIT + FOR UPDATE lock.
  const rowsById = new Map();
  const query = async (sql, params) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (/INSERT INTO agent_turns/.test(sql)) {
      const r = {
        id: params[0], session_id: params[1], user_id: params[2],
        requested_model: params[3], status: 'running', metadata: JSON.parse(params[11] || '{}'),
      };
      rowsById.set(params[0], r);
      return { rows: [r] };
    }
    if (/FOR UPDATE/.test(sql)) {
      const row = rowsById.get(params[0]);
      if (!row) return { rows: [] };
      return { rows: [{ ...row, agent_config_version: 1 }] };
    }
    if (/UPDATE agent_turns SET/.test(sql)) {
      const r = rowsById.get(params[0]);
      if (r && r.status === 'running') {
        r.status = params[1];
        r.updated = true;
      }
      return { rows: r && r.status ? [{ id: params[0] }] : [] };
    }
    if (/FROM agent_turns/.test(sql)) {
      return { rows: [] };
    }
    return { rows: [] };
  };
  const client = { query, release() {} };
  const pool = {
    query,
    async connect() { return client; },
  };
  return { pool, rowsById };
}

test('completeCodexAttempt completes once and is idempotent on repeat', async () => {
  const { pool, rowsById } = makeTransactionPool();
  const started = await startCodexAttempt({
    pool, session: { id: 11, agent_config_version: 1 }, userId: 1,
    logicalTurnId: 'lt-1', attemptNumber: 1, model: 'openai/gpt-5.3-codex',
    resumeThreadId: null, runtimeContext: { credentialId: 5, credentialRevision: 2, agentConfigVersion: 1, pricingSnapshot: { available: true, inputPricePerMillion: 1, outputPricePerMillion: 2 } },
  });
  const first = await completeCodexAttempt({
    pool, turnUuid: started.turnUuid, status: 'completed', threadId: 'thr-1',
    usageTotal: { inputTokens: 100, outputTokens: 20 },
  });
  assert.equal(first.updated, true);
  assert.equal(first.delta.inputTokens, 100);
  assert.equal(first.estimatedCost.costSource, 'requested_model_catalog_estimate');
  assert.equal(rowsById.get(started.turnUuid).status, 'completed');

  const second = await completeCodexAttempt({
    pool, turnUuid: started.turnUuid, status: 'completed', threadId: 'thr-1',
    usageTotal: { inputTokens: 200, outputTokens: 40 },
  });
  assert.equal(second.updated, false, 'repeat completion does not double-add');
  assert.equal(second.alreadyTerminal, true);
});

test('completeCodexAttempt throws for a genuinely missing turn', async () => {
  const { pool } = makeTransactionPool();
  await assert.rejects(
    () => completeCodexAttempt({ pool, turnUuid: 'missing', status: 'completed', usageTotal: { inputTokens: 10 } }),
    /agent attempt not found/,
  );
});
