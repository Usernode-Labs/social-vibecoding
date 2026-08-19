'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const effects = require('../src/services/turn-effects');
const limits = require('../src/services/limits');

function makePool() {
  const receipts = new Map();
  let mutations = 0;
  const debits = [];
  const specs = [];
  const messages = [];
  let currentSpec = null;
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [], rowCount: 0 };
      const key = `${params[0]}:${params[1]}`;
      if (/INSERT INTO turn_effects/.test(text)) {
        if (receipts.has(key)) return { rows: [], rowCount: 0 };
        receipts.set(key, {
          state: 'pending',
          result: params[3] === undefined ? null : JSON.parse(params[3]),
        });
        return { rows: [{ state: 'pending' }], rowCount: 1 };
      }
      if (/SELECT state, result FROM turn_effects/.test(text)) {
        return { rows: receipts.has(key) ? [receipts.get(key)] : [], rowCount: receipts.has(key) ? 1 : 0 };
      }
      if (/SELECT state FROM turn_effects/.test(text)) {
        const row = receipts.get(key);
        return { rows: row ? [{ state: row.state }] : [], rowCount: row ? 1 : 0 };
      }
      if (/UPDATE turn_effects/.test(text)) {
        const row = receipts.get(key);
        if (!row || row.state !== 'pending') return { rows: [], rowCount: 0 };
        row.state = 'completed';
        row.result = JSON.parse(params[2]);
        return { rows: [{ result: row.result }], rowCount: 1 };
      }
      if (/MUTATE/.test(text)) {
        mutations += 1;
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE chat_sessions SET spec_md/.test(text)) {
        currentSpec = params[0];
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO chat_session_specs/.test(text)) {
        const version = specs.length + 1;
        specs.push({ sessionId: params[0], version, content: params[1] });
        return { rows: [{ version }], rowCount: 1 };
      }
      if (/INSERT INTO chat_session_messages/.test(text)) {
        messages.push({
          sessionId: params[0],
          content: params[1],
          metadata: JSON.parse(params[2]),
        });
        return { rows: [], rowCount: 1 };
      }
      const debit = /INSERT INTO llm_usage \(user_id, date, (\w+)\)/.exec(text);
      if (debit) {
        debits.push({ column: debit[1], userId: params[0], costCents: params[1] });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
  return {
    receipts,
    debits,
    specs,
    messages,
    get currentSpec() { return currentSpec; },
    get mutations() { return mutations; },
    query: (...args) => client.query(...args),
    async connect() { return { ...client, release() {} }; },
  };
}

test('database-local effects replay their committed result without mutating twice', async () => {
  const pool = makePool();
  const args = {
    pool,
    turnId: '00000000-0000-4000-8000-000000000001',
    effectKey: 'claude_spend',
    sessionId: 42,
    run: async (client) => {
      await client.query('MUTATE');
      return { platformCents: 25, byokCents: 0 };
    },
  };
  const first = await effects.runDbEffect(args);
  const second = await effects.runDbEffect(args);
  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.deepEqual(second.value, first.value);
  assert.equal(pool.mutations, 1);
});

test('scout publication replays one atomic spec version and transcript card', async () => {
  const { persistScoutPublication } = require('../src/routes/sessions');
  const pool = makePool();
  const args = {
    pool,
    turnId: '00000000-0000-4000-8000-000000000008',
    sessionId: 42,
    content: '# Plan\n\n## User-facing changes\n\nOne.\n\n## Technical implementation\n\nTwo.',
    conversationContent: '# Plan\n\n## User-facing changes\n\nOne.\n\n## Technical implementation\n\nTwo.',
    hadSpec: false,
  };

  const first = await persistScoutPublication(args);
  const replay = await persistScoutPublication({ ...args, hadSpec: true });

  assert.equal(first.applied, true);
  assert.equal(replay.applied, false);
  assert.equal(replay.scoutText, first.scoutText,
    'the receipt preserves whether the original effect drafted or revised');
  assert.equal(pool.currentSpec, args.content);
  assert.equal(pool.specs.length, 1, 'recovery cannot create a second immutable version');
  assert.equal(pool.messages.length, 1, 'recovery cannot post a second scout card');
  assert.equal(pool.messages[0].metadata.specVersion, 1);
  assert.equal(pool.messages[0].metadata.scoutConversationSpecExact, true,
    'the publication records that the resumed Claude response contains this exact spec');
});

test('scout publication does not certify a spec normalized from different conversation text', async () => {
  const { persistScoutPublication } = require('../src/routes/sessions');
  const pool = makePool();
  const content = '# Plan\n\n## User-facing changes\n\nOne.';

  await persistScoutPublication({
    pool,
    turnId: '00000000-0000-4000-8000-000000000009',
    sessionId: 42,
    content,
    conversationContent: `\`\`\`markdown\n${content}\n\`\`\``,
  });

  assert.equal(pool.messages[0].metadata.scoutConversationSpecExact, undefined);
});

test('an external effect remains pending until its owner completes it', async () => {
  const pool = makePool();
  const turnId = '00000000-0000-4000-8000-000000000002';
  assert.deepEqual(
    await effects.claimExternalEffect({ pool, turnId, effectKey: 'staging', sessionId: 42 }),
    { claimed: true, state: 'pending', result: null },
  );
  assert.deepEqual(
    await effects.claimExternalEffect({ pool, turnId, effectKey: 'staging', sessionId: 42 }),
    { claimed: false, state: 'pending', result: null },
  );
  assert.equal(await effects.completeExternalEffect({
    pool, turnId, effectKey: 'staging', result: { sha: 'abc' },
  }), true);
  assert.deepEqual(
    await effects.claimExternalEffect({ pool, turnId, effectKey: 'staging', sessionId: 42 }),
    { claimed: false, state: 'completed', result: { sha: 'abc' } },
  );
});

test('a fail-closed external effect executes once and replays its receipt', async () => {
  const pool = makePool();
  const turnId = '00000000-0000-4000-8000-000000000004';
  let calls = 0;
  const args = {
    pool,
    turnId,
    effectKey: 'turn_wrapup_llm',
    sessionId: 42,
    run: async () => {
      calls += 1;
      return { text: 'done', usage: { input_tokens: 1, output_tokens: 1 } };
    },
    fallback: { text: '_Done._', usage: null },
  };

  const first = await effects.runExternalEffectFailClosed(args);
  const replay = await effects.runExternalEffectFailClosed(args);

  assert.equal(first.disposition, 'executed');
  assert.equal(replay.disposition, 'replayed');
  assert.deepEqual(replay.value, first.value);
  assert.equal(calls, 1);
});

test('an ambiguous pending external effect completes with fallback without a second call', async () => {
  const pool = makePool();
  const turnId = '00000000-0000-4000-8000-000000000005';
  await effects.claimExternalEffect({
    pool, turnId, effectKey: 'turn_wrapup_llm', sessionId: 42,
  });
  let calls = 0;

  const recovered = await effects.runExternalEffectFailClosed({
    pool,
    turnId,
    effectKey: 'turn_wrapup_llm',
    sessionId: 42,
    run: async () => { calls += 1; return { text: 'charged twice' }; },
    fallback: { text: '_Done._', usage: null },
  });

  assert.equal(recovered.disposition, 'fallback');
  assert.deepEqual(recovered.value, { text: '_Done._', usage: null });
  assert.equal(calls, 0);
  assert.equal(pool.receipts.get(`${turnId}:turn_wrapup_llm`).state, 'completed');
});

test('pending external intent remains authoritative during keyless recovery', async () => {
  const pool = makePool();
  const turnId = '00000000-0000-4000-8000-000000000009';
  await effects.claimExternalEffect({
    pool,
    turnId,
    effectKey: 'pr_metadata_generation',
    sessionId: 42,
    intent: { billingByok: true },
  });
  let calls = 0;

  const recovered = await effects.runExternalEffectFailClosed({
    pool,
    turnId,
    effectKey: 'pr_metadata_generation',
    sessionId: 42,
    // The recovery process has no plaintext user key and would choose false
    // for a new call. The pending receipt proves the ambiguous original call
    // belonged to BYOK, and no provider call may be replayed.
    intent: { billingByok: false },
    run: async () => { calls += 1; return { chargedTwice: true }; },
    fallback: (_err, pendingIntent) => ({
      fallback: true,
      billingByok: !!pendingIntent?.billingByok,
    }),
  });

  assert.equal(calls, 0);
  assert.deepEqual(recovered.value, { fallback: true, billingByok: true });
});

test('a failed first external call is terminalized with fallback and is not retried', async () => {
  const pool = makePool();
  const turnId = '00000000-0000-4000-8000-000000000006';
  let calls = 0;
  const args = {
    pool,
    turnId,
    effectKey: 'turn_wrapup_pills',
    sessionId: 42,
    run: async () => { calls += 1; throw new Error('provider unavailable'); },
    fallback: () => ({ replies: ['Retry'], source: 'static' }),
  };

  const first = await effects.runExternalEffectFailClosed(args);
  const replay = await effects.runExternalEffectFailClosed(args);

  assert.equal(first.disposition, 'fallback');
  assert.match(first.error.message, /provider unavailable/);
  assert.equal(replay.disposition, 'replayed');
  assert.deepEqual(replay.value, first.value);
  assert.equal(calls, 1);
});

test('a concurrent pending reconciler wins consistently over an in-flight result', async () => {
  const pool = makePool();
  const turnId = '00000000-0000-4000-8000-000000000007';
  let releaseProvider;
  let providerStarted;
  const started = new Promise((resolve) => { providerStarted = resolve; });
  const provider = effects.runExternalEffectFailClosed({
    pool,
    turnId,
    effectKey: 'turn_wrapup_llm',
    sessionId: 42,
    run: async () => {
      providerStarted();
      await new Promise((resolve) => { releaseProvider = resolve; });
      return { text: 'provider result' };
    },
    fallback: { text: '_Done._' },
  });
  await started;

  const reconciler = await effects.runExternalEffectFailClosed({
    pool,
    turnId,
    effectKey: 'turn_wrapup_llm',
    sessionId: 42,
    run: async () => ({ text: 'must not run' }),
    fallback: { text: '_Done._' },
  });
  releaseProvider();
  const originalOwner = await provider;

  assert.equal(reconciler.disposition, 'fallback');
  assert.deepEqual(originalOwner.value, reconciler.value,
    'both owners must observe the one authoritative completed receipt');
  assert.equal(originalOwner.disposition, 'replayed');
});

test('durable Claude settlement debits llm_usage exactly once across recovery replay', async () => {
  const pool = makePool();
  const turnId = '00000000-0000-4000-8000-000000000003';
  const first = await limits.settleTurnSpend(pool, 7, 123, {
    byokObservedCents: 23,
    turnId,
    sessionId: 42,
  });
  const replay = await limits.settleTurnSpend(pool, 7, 999, {
    byokObservedCents: 999,
    turnId,
    sessionId: 42,
  });

  assert.deepEqual(first, { platformCents: 100, byokCents: 23 });
  assert.deepEqual(replay, first, 'recovery returns the committed split, not new inputs');
  assert.deepEqual(pool.debits, [
    { column: 'total_cost_cents', userId: 7, costCents: 100 },
    { column: 'byok_cost_cents', userId: 7, costCents: 23 },
  ]);
});
