'use strict';

// The plan at Make it, when its reply cannot be used (newcomer run five,
// 13 Oct 2026): the plan was refused as `unusable_reply` and nothing said
// what had come back, or from which of OpenRouter's providers. Now the
// reply's SHAPE is kept on the first version's row (first-version-plan.js
// replyShape, homeroom_bot_first_versions.early_plan_reply): its top-level
// keys with each value's type and length, how far it got as JSON and why it
// was refused, the length of its text, its tool calls and its finish
// reason, never a word of it. And every helper call's llm_invocation row
// names the provider that served it (`routed_provider`, llm.js
// askHelperModel) beside the ledger's own `provider: 'openrouter'`.

const test = require('node:test');
const assert = require('node:assert/strict');

const fvPlan = require('../src/services/first-version-plan');
const llm = require('../src/services/llm');
const llmTelemetry = require('../src/services/llm-telemetry');

const SECRET = 'a private line about the club';

test('the shape of a reply the plan cannot use, and never its words', () => {
  const noJson = fvPlan.replyShape(`Sorry, ${SECRET}`);
  assert.deepEqual(noJson, {
    chars: `Sorry, ${SECRET}`.length, json: 'none', why: 'no_json', keys: [],
    finishReason: null, toolCallCount: null, textChars: null, routedProvider: null,
  });
  assert.deepEqual([fvPlan.replyShape('{"plan": [').json, fvPlan.replyShape('{"plan": [').why], ['none', 'no_json']);
  assert.deepEqual([fvPlan.replyShape('{ plan: 1 }').json, fvPlan.replyShape('{ plan: 1 }').why], ['invalid', 'bad_json']);

  // An object whose plan lines are objects, not lines: no plan survives.
  const objects = fvPlan.replyShape(JSON.stringify({
    plan: [{ line: SECRET }, { line: SECRET }], choices: [], build_note: SECRET, assumptions: [SECRET], 'odd key!': 3, extra: null,
  }), { finishReason: 'tool_calls', toolCallCount: 1, textChars: 0, routedProvider: 'Z.AI' });
  assert.equal(objects.json, 'object');
  assert.equal(objects.why, 'no_plan');
  assert.equal(objects.keyCount, 6);
  assert.deepEqual(objects.keys, [
    { key: 'plan', type: 'array', length: 2, items: ['object'] },
    { key: 'choices', type: 'array', length: 0, items: [] },
    { key: 'build_note', type: 'string', length: SECRET.length },
    { key: 'assumptions', type: 'array', length: 1, items: ['string'] },
    { key: '?', type: 'number' },
    { key: 'extra', type: 'null' },
  ]);
  assert.deepEqual([objects.finishReason, objects.toolCallCount, objects.textChars, objects.routedProvider], ['tool_calls', 1, 0, 'Z.AI']);
  assert.equal(JSON.stringify(objects).includes(SECRET), false);
  assert.equal(JSON.stringify(objects).includes('line'), false, 'not even a nested key');

  // Plan lines but no build note.
  assert.equal(fvPlan.replyShape(JSON.stringify({ plan: ['One', 'Two'], build_note: '  ' })).why, 'no_note');
  // A reply that is a plan is no refusal.
  const ok = JSON.stringify({ plan: ['One', 'Two', 'Three'], choices: [], build_note: 'A note', assumptions: [] });
  assert.equal(fvPlan.replyShape(ok).why, null);
  assert.ok(fvPlan.parsePlanReply(ok));
  // What the call says about itself is kept only in its own shape.
  const odd = fvPlan.replyShape('nope', { finishReason: 'stop; DROP', toolCallCount: -1, textChars: 2.5, routedProvider: '<script>' });
  assert.deepEqual([odd.finishReason, odd.toolCallCount, odd.textChars, odd.routedProvider], [null, null, null, null]);
  // Many keys: at most 20 of them.
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
  const wide = fvPlan.replyShape(JSON.stringify(many));
  assert.equal(wide.keys.length, 20);
  assert.equal(wide.keyCount, 30);
});

test('makePlan hands back the shape with `unusable_reply`, from what the call said of itself', async () => {
  const pool = { async query() { return { rows: [{ username: 'alex', locale: null }] }; } };
  const reply = {
    text: JSON.stringify({ plan: [], choices: [], build_note: SECRET, assumptions: [] }),
    usage: null, model: 'z-ai/glm-5.3-flash',
    reply: { finishReason: 'tool_calls', toolCallCount: 1, textChars: 12, routedProvider: 'DeepInfra' },
  };
  const made = await fvPlan.makePlan(pool, {
    app: { id: 3, name: 'Club Votes' }, user: { id: 7 }, brief: 'Polls',
    deps: {
      llm: { isEnabled: () => true, estimateCostCents: () => 0, async generateFirstVersionPlan() { return reply; } },
      limits: { async recordSpend() {} },
      bot: { projectMembers: async () => null, starterOfApp: async () => null },
      botConfigs: { async currentVersion() { return null; } },
    },
  });
  assert.equal(made.error, 'unusable_reply');
  assert.equal(made.shape.why, 'no_plan');
  assert.equal(made.shape.routedProvider, 'DeepInfra');
  assert.equal(made.shape.textChars, 12);
  assert.equal(JSON.stringify(made.shape).includes(SECRET), false);
});

test('savePlan keeps the shape only for a plan it could not use', async () => {
  const sql = [];
  let appRow = { id: 3, name: 'Club Votes', slug: 'club-votes' };
  const pool = {
    async query(text, params) {
      sql.push({ text, params });
      if (/FROM homeroom_bot_first_versions f JOIN apps a/.test(text)) return { rows: [{ user_id: 7, brief: 'Polls', early_plan_status: 'pending', ...appRow }] };
      if (/early_plan_reply = \$5::jsonb/.test(text)) return { rows: [], rowCount: 1 };
      return { rows: [] };
    },
  };
  const stages = [];
  const deps = (text) => ({
    llm: { isEnabled: () => true, estimateCostCents: () => 0, async generateFirstVersionPlan() { return { text, reply: { finishReason: 'stop', toolCallCount: 0, textChars: 4 } }; } },
    limits: { async recordSpend() {} },
    bot: { projectMembers: async () => null, starterOfApp: async () => null },
    botConfigs: { async currentVersion() { return null; } },
    timeline: { async record(_pool, args) { stages.push(args); return true; } },
  });
  assert.deepEqual(await fvPlan.runEarlyPlan(pool, { appId: 3 }, deps('nope')), { planned: false });
  const failed = sql.find((q) => /early_plan_reply = \$5::jsonb/.test(q.text));
  assert.equal(failed.params[1], 'failed');
  assert.equal(failed.params[3], 'unusable_reply');
  assert.deepEqual(JSON.parse(failed.params[4]), {
    chars: 4, json: 'none', why: 'no_json', keys: [], finishReason: 'stop', toolCallCount: 0, textChars: 4, routedProvider: null,
  });
  assert.deepEqual(stages, [], 'no plan: no stage');

  sql.length = 0;
  appRow = { id: 4, name: 'Book Swap', slug: 'book-swap' };
  const ok = JSON.stringify({ plan: ['One', 'Two', 'Three'], choices: [{ question: 'Who?', answers: ['a', 'b'] }], build_note: 'A note', assumptions: [] });
  assert.deepEqual(await fvPlan.runEarlyPlan(pool, { appId: 4 }, deps(ok)), { planned: true });
  const ready = sql.find((q) => /early_plan_reply = \$5::jsonb/.test(q.text));
  assert.equal(ready.params[1], 'ready');
  assert.equal(ready.params[4], null);
  assert.deepEqual(stages, [{ appId: 4, stage: 'plan_written', detail: { source: 'make_it', questions: 1 } }],
    'its timeline starts the moment it is written (first-version-timeline.js)');
});

// ── The helper path ──

function fakeOpenRouter(result) {
  return { async streamChat() { if (result instanceof Error) throw result; return result; } };
}

async function withHelper(result, fn, { haiku = null } = {}) {
  const events = [];
  const prevDeps = llm._setHelperDepsForTests({ openrouter: fakeOpenRouter(result), key: 'sk-or-bot', config: {} });
  const prevClient = llm._setClientForTests({
    messages: { create: async () => haiku || { content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' } },
  });
  const prevEnabled = llmTelemetry._setEnabledForTests(true);
  const prevSink = llmTelemetry._setSinkForTests((e) => { events.push(e); });
  try {
    return await fn(events);
  } finally {
    llm._setHelperDepsForTests(prevDeps);
    llm._setClientForTests(prevClient);
    llmTelemetry._setEnabledForTests(prevEnabled);
    llmTelemetry._setSinkForTests(prevSink);
  }
}

const ANSWER = { plan: [], choices: [], build_note: 'x', assumptions: [] };

test('a helper call\'s row names the provider OpenRouter routed it to, apart from `provider`', async () => {
  await withHelper({
    servedModel: 'z-ai/glm-5.3-flash', provider: 'Z.AI', finishReason: 'tool_calls', content: 'Here you go',
    toolCalls: [{ type: 'function', function: { name: 'answer', arguments: JSON.stringify(ANSWER) } }],
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0001 },
  }, async (events) => {
    const out = await llm.generateFirstVersionPlan({ system: 's', user: 'u', schema: fvPlan.PLAN_SCHEMA });
    assert.equal(events.length, 1);
    assert.equal(events[0].provider, 'openrouter', 'the ledger\'s route, unchanged');
    assert.equal(events[0].routed_provider, 'Z.AI');
    assert.equal(events[0].stop_reason, 'tool_calls');
    // And the call says how its reply came back, for a plan that cannot use it.
    assert.deepEqual(out.reply, { finishReason: 'tool_calls', toolCallCount: 1, textChars: 'Here you go'.length, routedProvider: 'Z.AI' });
    assert.deepEqual(JSON.parse(out.text), ANSWER);
  });
});

test('a provider that refused the call is named too; an unknown one is left out', async () => {
  const refused = Object.assign(new Error('rate limited'), { code: 'rate_limited', provider: 'Inceptron' });
  await withHelper(refused, async (events) => {
    const out = await llm.generateFirstVersionPlan({ system: 's', user: 'u', schema: fvPlan.PLAN_SCHEMA });
    assert.equal(events[0].routed_provider, 'Inceptron');
    assert.equal(events[0].outcome, 'error');
    // Haiku answered instead: what its reply was, with no provider of OpenRouter's.
    assert.deepEqual(out.reply, { finishReason: 'end_turn', toolCallCount: 0, textChars: 2, routedProvider: null });
  });
  await withHelper({
    servedModel: 'z-ai/glm-5.3-flash', finishReason: 'tool_calls',
    toolCalls: [{ type: 'function', function: { name: 'answer', arguments: JSON.stringify(ANSWER) } }], usage: {},
  }, async (events) => {
    await llm.generateFirstVersionPlan({ system: 's', user: 'u', schema: fvPlan.PLAN_SCHEMA });
    assert.equal('routed_provider' in events[0], false, 'absent, not null: older rows read the same');
  });
  // Only a provider's plain name is kept.
  assert.equal('routed_provider' in llmTelemetry.normalizeEvent({ routedProvider: 'Bad <name>' }), false);
  assert.equal(llmTelemetry.normalizeEvent({ routedProvider: 'Together AI' }).routed_provider, 'Together AI');
});
