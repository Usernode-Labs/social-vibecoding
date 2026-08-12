'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const llm = require('../src/services/llm');
const telemetry = require('../src/services/llm-telemetry');
const worker = require('../src/services/worker');
const agentTurn = require('../src/services/agent-turn');
const { runCodexAttemptLoop } = require('../src/routes/sessions');

function fakeStream(message) {
  return {
    on() {},
    finalMessage: async () => {
      if (message instanceof Error) throw message;
      return message;
    },
  };
}

function streamClient(responses) {
  const calls = [];
  const invoke = (kind, params, options) => {
    calls.push({ kind, params, options });
    if (!responses.length) throw new Error('no canned response');
    return fakeStream(responses.shift());
  };
  return {
    calls,
    messages: { stream: (params, options) => invoke('plain', params, options) },
    beta: { messages: { stream: (params, options) => invoke('beta', params, options) } },
  };
}

function finalMessage(overrides = {}) {
  return {
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    stop_details: null,
    content: [{ type: 'text', text: 'done' }],
    usage: { input_tokens: 12, output_tokens: 4 },
    ...overrides,
  };
}

async function withTelemetrySink(fn) {
  const rows = [];
  const priorEnabled = telemetry._setEnabledForTests(true);
  const priorSink = telemetry._setSinkForTests((row) => { rows.push(row); });
  try {
    return await fn(rows);
  } finally {
    telemetry._setSinkForTests(priorSink);
    telemetry._setEnabledForTests(priorEnabled);
  }
}

async function withClient(client, fn) {
  const prior = llm._setClientForTests(client);
  try { return await fn(); } finally { llm._setClientForTests(prior); }
}

test('stream telemetry leaves the complete Anthropic request object unchanged', async () => {
  await withTelemetrySink(async (rows) => {
    const client = streamClient([finalMessage()]);
    const messages = [{ role: 'user', content: 'unchanged message' }];
    const tools = [{ name: 'read_only_tool', description: 'unchanged', input_schema: { type: 'object' } }];
    const toolChoice = { type: 'auto' };
    await withClient(client, () => llm.streamChat({
      messages,
      systemPrompt: 'unchanged system',
      model: 'claude-opus-5',
      tools,
      toolChoice,
      telemetryContext: {
        appId: 7,
        sessionId: 11,
        backend: 'mayor',
        component: 'mayor_phase_1',
      },
    }));

    assert.deepEqual(client.calls[0].params, {
      model: 'claude-opus-5',
      max_tokens: 8192,
      system: 'unchanged system',
      messages,
      stream: true,
      tools,
      tool_choice: toolChoice,
    });
    assert.equal('telemetryContext' in client.calls[0].params, false);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].component, 'mayor_phase_1');
  });
});

test('Anthropic cache usage is preserved and absent usage stays null', async () => {
  await withTelemetrySink(async (rows) => {
    const client = streamClient([
      finalMessage({
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 70,
          cache_creation_input_tokens: 20,
          output_tokens: 9,
        },
      }),
      finalMessage({ usage: undefined }),
    ]);
    await withClient(client, async () => {
      await llm.streamChat({
        messages: [], systemPrompt: 's', model: 'claude-opus-5',
        telemetryContext: { component: 'mayor_phase_1' },
      });
      await llm.streamChat({
        messages: [], systemPrompt: 's', model: 'claude-opus-5',
        telemetryContext: { component: 'mayor_phase_2' },
      });
    });
    assert.deepEqual({
      input: rows[0].input_tokens,
      cacheRead: rows[0].cache_read_input_tokens,
      cacheWrite: rows[0].cache_write_input_tokens,
      output: rows[0].output_tokens,
    }, { input: 100, cacheRead: 70, cacheWrite: 20, output: 9 });
    assert.equal(rows[1].input_tokens, null);
    assert.equal(rows[1].cache_read_input_tokens, null);
    assert.equal(rows[1].cache_write_input_tokens, null);
    assert.equal(rows[1].output_tokens, null);
    assert.equal(rows[1].cost_usd, null);
    assert.equal(rows[1].cost_source, 'unavailable');
  });
});

test('recommended-model retry records two correlated physical attempts', async () => {
  await withTelemetrySink(async (rows) => {
    const client = streamClient([
      finalMessage({
        model: 'claude-fable-5',
        stop_reason: 'refusal',
        stop_details: { recommended_model: 'claude-opus-5' },
        content: [],
        usage: { input_tokens: 3, output_tokens: 0 },
      }),
      finalMessage({ model: 'claude-opus-5' }),
    ]);
    await withClient(client, () => llm.streamChat({
      messages: [], systemPrompt: 's', model: 'claude-fable-5',
      telemetryContext: { component: 'mayor_phase_1' },
    }));
    assert.equal(client.calls.length, 2);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.attempt_number), [1, 2]);
    assert.equal(rows[0].outcome, 'refusal');
    assert.equal(rows[1].outcome, 'success');
    assert.equal(rows[0].correlation_id, rows[1].correlation_id);
    assert.notEqual(rows[0].invocation_key, rows[1].invocation_key);
  });
});

test('server-side fallback iterations become separate model-invocation events', async () => {
  await withTelemetrySink(async (rows) => {
    const response = finalMessage({
      model: 'claude-opus-5',
      content: [
        { type: 'fallback', from: { model: 'claude-fable-5' }, to: { model: 'claude-opus-5' } },
        { type: 'text', text: 'served by fallback' },
      ],
      usage: {
        input_tokens: 30,
        output_tokens: 8,
        iterations: [
          {
            type: 'message', model: 'claude-fable-5',
            input_tokens: 10, cache_read_input_tokens: 4,
            cache_creation_input_tokens: 2, output_tokens: 1,
          },
          {
            type: 'fallback_message', model: 'claude-opus-5',
            input_tokens: 20, cache_read_input_tokens: 6,
            cache_creation_input_tokens: 3, output_tokens: 7,
          },
        ],
      },
    });
    const client = streamClient([response]);
    await withClient(client, () => llm.streamChat({
      messages: [], systemPrompt: 's', model: 'claude-fable-5',
      telemetryContext: { component: 'headless_decision' },
    }));
    assert.equal(client.calls.length, 1, 'provider API request shape is unchanged');
    assert.equal(rows.length, 2, 'two provider model iterations are measured');
    assert.deepEqual(rows.map((row) => row.requested_model), ['claude-fable-5', 'claude-fable-5']);
    assert.deepEqual(rows.map((row) => row.served_model), ['claude-fable-5', 'claude-opus-5']);
    assert.deepEqual(rows.map((row) => row.input_tokens), [10, 20]);
    assert.deepEqual(rows.map((row) => row.cache_read_input_tokens), [4, 6]);
    assert.equal(rows[0].duration_ms, null, 'enclosing duration is not duplicated');
    assert.notEqual(rows[1].duration_ms, null);
  });
});

test('direct helpers emit their fixed provider-neutral component labels', async () => {
  await withTelemetrySink(async (rows) => {
    const responses = [
      { ...finalMessage(), content: [{ type: 'text', text: '{"title":"Telemetry baseline"}' }] },
      { ...finalMessage(), content: [{ type: 'text', text: '{"title":"Add telemetry","body":"Measured","summary":"Usage is visible."}' }] },
      { ...finalMessage(), content: [{ type: 'text', text: '{"estimate":"maybe halfway","remaining_seconds":120}' }] },
      { ...finalMessage(), content: [{ type: 'tool_use', name: 'suggest_replies', input: { replies: ['Continue'] } }] },
      { ...finalMessage(), content: [{ type: 'text', text: '{"replies":["Continue"]}' }] },
      { ...finalMessage(), content: [{ type: 'text', text: 'Add usage telemetry' }] },
      { ...finalMessage(), content: [{
        type: 'text',
        text: '{"narrative":"Steady progress.","highlights":[],"risks":[],"owners":[]}',
      }] },
    ];
    const helperCalls = [];
    const client = { messages: { create: async (...args) => {
      helperCalls.push(args);
      return responses.shift();
    } } };
    const ctx = { appId: 2, sessionId: 3 };
    await withClient(client, async () => {
      await llm.generateSessionTitle({ requests: ['measure'], telemetryContext: ctx });
      await llm.generatePrMetadata({ userRequest: 'measure', ccSummary: 'done', telemetryContext: ctx });
      await llm.estimateRunProgress({ userRequest: 'measure', progressTail: [], elapsedMs: 1, steps: 0, telemetryContext: ctx });
      await llm.requireQuickReplies({
        rules: 'specific', context: 'reply', model: 'claude-opus-5',
        tool: { name: 'suggest_replies' }, telemetryContext: ctx,
      });
      await llm.generateQuickReplies({ rules: 'specific', context: 'reply', telemetryContext: ctx });
      await llm.generateIssueTitle({ description: 'measure usage', telemetryContext: ctx });
      await llm.generateReportSummary({ inputJson: '{}', appName: 'App', knownUsernames: [], telemetryContext: ctx });
    });
    assert.deepEqual(rows.map((row) => row.component), [
      'session_title', 'pr_metadata', 'progress_estimate', 'quick_replies',
      'quick_replies', 'other_helper', 'other_helper',
    ]);
    assert.ok(rows.every((row) => row.backend === 'helper'));
    assert.deepEqual(helperCalls.map((args) => args.length), [1, 1, 1, 2, 1, 1, 1],
      'telemetry preserves each helper SDK call arity, including an explicit undefined options arg');
  });
});

test('telemetry failure and kill switch cannot fail or alter an LLM turn', async () => {
  const priorEnabled = telemetry._setEnabledForTests(true);
  const priorSink = telemetry._setSinkForTests(() => { throw Object.assign(new Error('db down'), { code: '08006' }); });
  const client = streamClient([finalMessage()]);
  try {
    const result = await withClient(client, () => llm.streamChat({
      messages: [{ role: 'user', content: 'still works' }],
      systemPrompt: 'same',
      model: 'claude-opus-5',
      telemetryContext: { component: 'mayor_phase_1' },
    }));
    assert.equal(result.text, 'done');
    assert.equal(client.calls.length, 1);

    let called = 0;
    telemetry._setSinkForTests(() => { called += 1; });
    telemetry._setEnabledForTests(false);
    assert.equal(await telemetry.record(null, { provider: 'anthropic' }), false);
    assert.equal(telemetry.collectionComponent('coding_agent_build'), null);
    assert.equal(called, 0);

    telemetry._setEnabledForTests(true);
    assert.equal(telemetry.collectionComponent('coding_agent_build'), 'coding_agent_build');
    assert.equal(telemetry.collectionComponent('user supplied text'), null);
    assert.equal(await telemetry.record(null, {
      provider: 'anthropic',
      requestedModel: { toString() { throw new Error('unexpected value'); } },
    }), false, 'normalization failures are swallowed too');
    assert.equal(called, 0);
  } finally {
    telemetry._setSinkForTests(priorSink);
    telemetry._setEnabledForTests(priorEnabled);
  }
});

test('an aborted Anthropic request is counted as cancelled without storing its error', async () => {
  await withTelemetrySink(async (rows) => {
    const aborted = new Error('provider detail must not be stored');
    aborted.name = 'AbortError';
    const client = streamClient([aborted]);
    await assert.rejects(withClient(client, () => llm.streamChat({
      messages: [], systemPrompt: 's', model: 'claude-opus-5',
      telemetryContext: { component: 'mayor_phase_1' },
    })), (error) => error === aborted);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'cancelled');
    assert.equal(rows[0].stop_reason, 'cancelled');
    assert.equal(JSON.stringify(rows[0]).includes(aborted.message), false);
  });
});

test('the strict telemetry allowlist drops content and credentials', () => {
  const row = telemetry.normalizeEvent({
    provider: 'anthropic', backend: 'mayor', component: 'mayor_phase_1',
    prompt: 'secret prompt', messages: ['secret'], output: 'secret output',
    apiKey: 'sk-secret', rawError: 'secret error', filename: '/private/file',
    correlationId: 'accidental user sentence', requestedModel: 'prompt pasted here',
  });
  for (const forbidden of ['prompt', 'messages', 'output', 'apiKey', 'rawError', 'filename']) {
    assert.equal(Object.hasOwn(row, forbidden), false);
  }
  assert.equal(row.correlation_id, null);
  assert.equal(row.requested_model, null);
});

test('Claude coding-agent cost remains known while all token fields remain null', async () => {
  await withTelemetrySink(async (rows) => {
    worker._recordClaudeCodingRunForTests({
      sessionId: 42,
      turnId: '11111111-1111-4111-8111-111111111111',
      result: { costUsd: 1.25, exitCode: 0, agentModel: null },
      requestedModel: 'claude-opus-5',
      component: 'coding_agent_headless',
      startedAt: new Date(),
      durationMs: 1234,
      attemptNumber: 2,
      correlationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cost_usd, 1.25);
    assert.equal(rows[0].cost_source, 'provider_reported');
    assert.equal(rows[0].input_tokens, null);
    assert.equal(rows[0].cache_read_input_tokens, null);
    assert.equal(rows[0].cache_write_input_tokens, null);
    assert.equal(rows[0].output_tokens, null);
    assert.equal(rows[0].reasoning_output_tokens, null);
    assert.equal(rows[0].attempt_number, 2);
    assert.equal(rows[0].correlation_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

    const zeroCostState = worker.newWatchState();
    worker.parseLine(JSON.stringify({ type: 'result', cost_usd: 0 }), () => {}, zeroCostState);
    worker._recordClaudeCodingRunForTests({
      sessionId: 42,
      turnId: '22222222-2222-4222-8222-222222222222',
      result: zeroCostState,
      requestedModel: 'claude-opus-5',
      component: 'coding_agent_build',
      startedAt: new Date(),
      durationMs: 12,
    });
    worker._recordClaudeCodingRunForTests({
      sessionId: 42,
      turnId: '33333333-3333-4333-8333-333333333333',
      result: { costUsd: 0, exitCode: 0 },
      requestedModel: 'claude-opus-5',
      component: 'coding_agent_build',
      startedAt: new Date(),
      durationMs: 12,
    });
    assert.equal(rows[1].cost_usd, 0, 'provider-reported zero remains known zero');
    assert.equal(rows[1].cost_source, 'provider_reported');
    assert.equal(rows[2].cost_usd, null, 'legacy default zero without provider evidence is unavailable');
    assert.equal(rows[2].cost_source, 'unavailable');

    const billingPrecedence = worker.newWatchState();
    worker.parseLine(JSON.stringify({
      type: 'result', cost_usd: 0, total_cost_usd: 2.5,
    }), () => {}, billingPrecedence);
    assert.equal(billingPrecedence.costUsd, 2.5,
      'telemetry does not alter the existing Claude billing precedence');
    assert.equal(billingPrecedence.providerCostSeen, true);
  });
});

test('the aggregate report normalizes OpenRouter per-attempt deltas and preserves unavailable values', async () => {
  let captured;
  const pool = {
    async query(sql, params) {
      captured = { sql, params };
      return { rows: [{
        provider: 'openrouter', backend: 'coding_agent', component: 'coding_agent_build',
        requested_model: 'openai/model', served_model: 'openai/model', billing_path: 'openrouter_byok',
        invocation_count: '2', success_count: '1', error_count: '1', cancelled_count: '0', refusal_count: '0',
        input_tokens: null, cache_read_input_tokens: '0', cache_write_input_tokens: null,
        output_tokens: '8', reasoning_output_tokens: null,
        total_known_cost_usd: '0.12000000', unavailable_cost_count: '1', cache_hit_rate: '0',
        median_duration_ms: '100', p95_duration_ms: '190', median_cost_usd: '0.12', p95_cost_usd: '0.12',
        provider_reported_cost_count: '0', platform_estimate_cost_count: '0', catalog_estimate_cost_count: '1',
      }] };
    },
  };
  const report = await telemetry.aggregateReport(pool, { days: 14 });
  assert.deepEqual(captured.params, [telemetry.EVENT_TYPE, '14']);
  assert.match(captured.sql, /FROM agent_turns a/);
  assert.match(captured.sql, /e\.app_id AS app_id/);
  assert.match(captured.sql, /s\.app_id AS app_id/);
  assert.match(captured.sql, /provider_input_tokens_total IS NULL THEN NULL ELSE a\.input_tokens/);
  assert.match(captured.sql, /a\.metadata \? 'telemetry_component'/);
  assert.doesNotMatch(captured.sql, /prompt|messages|error_detail|user_id/);
  assert.equal(report.groups[0].tokens.input, null);
  assert.equal(report.groups[0].tokens.cacheReadInput, 0);
  assert.equal(report.groups[0].costSourceCounts.catalogEstimate, 1);
  assert.equal(report.groups[0].costSourceCounts.providerReported, 0);
  assert.equal(Object.hasOwn(report.groups[0], 'appId'), false);
  assert.equal(Object.hasOwn(report.groups[0], 'sessionId'), false);
  await assert.rejects(() => telemetry.aggregateReport(pool, { days: 0 }), /between 1 and 90/);
  await assert.rejects(() => telemetry.aggregateReport(pool, { days: 91 }), /between 1 and 90/);
});

test('OpenRouter telemetry excludes a durable intent that never physically dispatched', async () => {
  const originalStart = agentTurn.startCodexAttempt;
  const originalComplete = agentTurn.completeCodexAttempt;
  const starts = [];
  const completions = [];
  agentTurn.startCodexAttempt = async (args) => {
    starts.push(args);
    return { turnUuid: `attempt-${starts.length}`, journal: `/tmp/attempt-${starts.length}` };
  };
  agentTurn.completeCodexAttempt = async (args) => {
    completions.push(args);
    return { updated: true };
  };
  const run = (providerDispatched) => runCodexAttemptLoop({
    pool: {},
    session: { id: 9, agent_config_version: 1 },
    userId: 12,
    isCodexSession: true,
    turnModel: 'openai/gpt-5.3-codex',
    mode: 'build',
    telemetryComponent: 'coding_agent_headless',
    resolveRuntime: async () => ({
      agentBackend: 'codex_openrouter',
      agentModel: 'openai/gpt-5.3-codex',
      agentReasoningEffort: 'high',
      pricingSnapshot: { available: false },
    }),
    dispatchOnce: async () => ({ exitCode: providerDispatched ? 0 : 143, providerDispatched }),
    retryPredicate: () => false,
  });
  try {
    await run(false);
    await run(true);
    assert.equal(completions[0].telemetryComponent, null,
      'a pre-dispatch cancellation is not an invocation');
    assert.equal(completions[1].telemetryComponent, 'coding_agent_headless');
    assert.equal(starts[1].model, 'openai/gpt-5.3-codex');
    assert.equal(starts[1].reasoningEffort, 'high');
  } finally {
    agentTurn.startCodexAttempt = originalStart;
    agentTurn.completeCodexAttempt = originalComplete;
  }
});

test('Mayor/headless call sites carry every required phase label', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/sessions.js'), 'utf8');
  for (const component of [
    'mayor_phase_1', 'mayor_data_iteration', 'mayor_phase_2',
    'headless_decision', 'headless_wrapup',
    'coding_agent_scout', 'coding_agent_build', 'coding_agent_headless',
  ]) {
    assert.match(src, new RegExp(`['"]${component}['"]`), `${component} is attributed at its caller`);
  }
});

test('schema makes invocation event replay idempotent', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS idx_events_llm_invocation_key/);
  assert.match(schema, /WHERE event_type = 'llm_invocation' AND metadata \? 'invocation_key'/);
});

test('coding-agent component context is persisted for retry and restart attribution', () => {
  const workerSource = fs.readFileSync(path.join(__dirname, '../src/services/worker.js'), 'utf8');
  const sessionSource = fs.readFileSync(path.join(__dirname, '../src/routes/sessions.js'), 'utf8');
  const serverSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  for (const field of ['telemetryComponent', 'telemetryCorrelationId', 'telemetryAttemptNumber']) {
    assert.match(workerSource, new RegExp(field));
    assert.match(sessionSource, new RegExp(field));
    assert.match(serverSource, new RegExp(field));
  }
});

test('admin report is protected, defaults to 14 days, and bounds the timeframe', async () => {
  const poolModule = require('../src/db/pool');
  const originalGetPool = poolModule.getPool;
  const originalAggregate = telemetry.aggregateReport;
  const calls = [];
  poolModule.getPool = () => ({ query: async () => ({ rows: [] }) });
  telemetry.aggregateReport = async (_pool, args) => {
    calls.push(args);
    return { timeframe: { days: args.days }, groups: [] };
  };

  // admin.js destructures getPool at import time, so load it only after the
  // test pool is installed.
  delete require.cache[require.resolve('../src/routes/admin')];
  const { adminRoutes } = require('../src/routes/admin');
  const express = require('express');
  let currentUser = { id: 1, isAdmin: false, canAdminWrite: false };
  const app = express();
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(adminRoutes({}));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let response = await fetch(`${base}/api/admin/llm-telemetry`, { redirect: 'manual' });
    // adminMiddleware preserves the admin console's existing unauthenticated
    // redirect behavior when mounted on this router. The important invariant
    // here is that the request never reaches the aggregate query.
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/');
    assert.equal(calls.length, 0);

    currentUser = { id: 2, isAdmin: true, canAdminWrite: false };
    response = await fetch(`${base}/api/admin/llm-telemetry`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).timeframe.days, 14);

    response = await fetch(`${base}/api/admin/llm-telemetry?days=7`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).timeframe.days, 7);

    for (const invalid of ['0', '91', '1.5', 'abc']) {
      response = await fetch(`${base}/api/admin/llm-telemetry?days=${invalid}`);
      assert.equal(response.status, 400);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    telemetry.aggregateReport = originalAggregate;
    poolModule.getPool = originalGetPool;
    delete require.cache[require.resolve('../src/routes/admin')];
  }
});
