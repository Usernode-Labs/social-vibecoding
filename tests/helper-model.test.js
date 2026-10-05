'use strict';

// The helper calls' model (src/services/llm.js helperMessage): GLM 5.3 Flash
// through OpenRouter first, on the Homeroom bot's key, with a time limit per
// helper, and Haiku 4.5 when GLM is late, fails or gives nothing usable.
// Pins the request GLM is sent, the fallback, the cases that never reach GLM
// (a BYOK key, HELPER_MODEL=haiku, no bot key, a picked model), a caller's
// cancel, the cost the answer is billed at, the telemetry pair, and that
// every helper the switch names goes through the path.
//
// Run with: node --test tests/helper-model.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const llm = require('../src/services/llm');
const llmTelemetry = require('../src/services/llm-telemetry');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function fakeOpenRouter(reply) {
  const calls = [];
  return {
    calls,
    async streamChat(input) {
      calls.push(input);
      if (reply instanceof Error) throw reply;
      if (typeof reply === 'function') return reply(input);
      return {
        servedModel: 'z-ai/glm-5.3-flash',
        finishReason: 'tool_calls',
        toolCalls: reply === null ? [] : [{ type: 'function', function: { name: 'answer', arguments: JSON.stringify(reply) } }],
        usage: { inputTokens: 400, outputTokens: 90, reasoningTokens: 60, costUsd: 0.00012 },
      };
    },
  };
}

function stubClient(text = '{"title":"From Haiku"}') {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        return { content: [{ type: 'text', text }], usage: { input_tokens: 300, output_tokens: 20 }, stop_reason: 'end_turn' };
      },
    },
  };
}

async function withHelpers({ reply, key = 'sk-or-bot', haikuText } = {}, fn) {
  const openrouter = fakeOpenRouter(reply);
  const client = stubClient(haikuText);
  const events = [];
  const prevDeps = llm._setHelperDepsForTests({ openrouter, key, config: { openrouterApiBase: 'https://or.test/api/v1' } });
  const prevClient = llm._setClientForTests(client);
  const prevEnabled = llmTelemetry._setEnabledForTests(true);
  const prevSink = llmTelemetry._setSinkForTests((e) => { events.push(e); });
  try {
    return await fn({ openrouter, client, events });
  } finally {
    llm._setHelperDepsForTests(prevDeps);
    llm._setClientForTests(prevClient);
    llmTelemetry._setEnabledForTests(prevEnabled);
    llmTelemetry._setSinkForTests(prevSink);
  }
}

test('GLM answers: the forced tool carries the helper schema, and Haiku is never asked', async () => {
  await withHelpers({ reply: { title: 'Plant watering reminders' } }, async ({ openrouter, client, events }) => {
    const out = await llm.generateSessionTitle({ requests: ['Remind us to water the plants'] });
    assert.equal(out.title, 'Plant watering reminders');
    assert.equal(out.model, 'z-ai/glm-5.3-flash');
    assert.equal(out.usage.cost_usd, 0.00012, 'OpenRouter\'s own figure rides along');
    assert.equal(client.calls.length, 0);

    const sent = openrouter.calls[0];
    assert.equal(sent.model, llm.HELPER_MODEL);
    assert.equal(sent.apiKey, 'sk-or-bot');
    assert.equal(sent.baseUrl, 'https://or.test/api/v1');
    assert.equal(sent.reasoning, 'low');
    assert.equal(sent.timeoutMs, llm.HELPER_TIME_LIMIT_MS.session_title);
    assert.deepEqual(sent.toolChoice, { type: 'function', function: { name: 'answer' } });
    assert.deepEqual(sent.tools[0].function.parameters, llm.SESSION_TITLE_SCHEMA);
    assert.equal(sent.messages[0].role, 'system');
    assert.equal(sent.messages[1].role, 'user');
    assert.equal(sent.maxOutputTokens, 64 + 1500, 'the Haiku ceiling plus room to think');

    assert.equal(events.length, 1);
    assert.equal(events[0].provider, 'openrouter');
    assert.equal(events[0].component, 'session_title');
    assert.equal(events[0].requested_model, 'z-ai/glm-5.3-flash');
    assert.equal(events[0].outcome, 'success');
    assert.equal(events[0].cost_source, 'provider_reported');
    assert.equal(events[0].attempt_number, 1);
  });
});

test('GLM late or failing: Haiku answers as attempt 2 of the same call', async () => {
  const late = Object.assign(new Error('timed out'), { code: 'timeout' });
  await withHelpers({ reply: late }, async ({ client, events }) => {
    const out = await llm.generateSessionTitle({ requests: ['Remind us to water the plants'] });
    assert.equal(out.title, 'From Haiku');
    assert.equal(out.model, 'claude-haiku-4-5');
    assert.equal(client.calls[0].model, 'claude-haiku-4-5');
    assert.equal(client.calls[0].max_tokens, 64, 'Haiku is asked exactly as before');
    assert.equal(events.length, 2);
    const [glm, haiku] = events;
    assert.equal(glm.outcome, 'error');
    assert.equal(glm.error_class, 'timeout');
    assert.equal(haiku.provider, 'anthropic');
    assert.equal(haiku.attempt_number, 2);
    assert.equal(haiku.correlation_id, glm.correlation_id, 'one logical run');
  });
  // An answer with no usable tool call is not an answer.
  await withHelpers({ reply: null }, async ({ client, events }) => {
    const out = await llm.generateSessionTitle({ requests: ['x'] });
    assert.equal(out.model, 'claude-haiku-4-5');
    assert.equal(client.calls.length, 1);
    assert.equal(events[0].outcome, 'error');
  });
});

test('never GLM: a BYOK key, HELPER_MODEL=haiku, no bot key, a named Claude model', async () => {
  const params = { max_tokens: 64, messages: [{ role: 'user', content: 'x' }] };
  const defaults = { backend: 'helper', component: 'session_title' };
  await withHelpers({ reply: { title: 'GLM' } }, async ({ openrouter, client }) => {
    const byok = await llm.helperMessage({
      helper: 'session_title', activeClient: client, params, schema: llm.SESSION_TITLE_SCHEMA, apiKey: 'sk-ant-own', defaults,
    });
    assert.equal(byok.model, 'claude-haiku-4-5');
    const named = await llm.helperMessage({
      helper: 'session_title', activeClient: client, params, schema: llm.SESSION_TITLE_SCHEMA, defaults, model: 'claude-sonnet-5-5',
    });
    assert.equal(named.model, 'claude-sonnet-5-5');
    assert.equal(client.calls[1].model, 'claude-sonnet-5-5');
    assert.equal(openrouter.calls.length, 0);

    const prev = process.env.HELPER_MODEL;
    process.env.HELPER_MODEL = 'haiku';
    try {
      assert.equal(llm.helperRoute(), 'haiku');
      const off = await llm.generateSessionTitle({ requests: ['x'] });
      assert.equal(off.model, 'claude-haiku-4-5');
      assert.equal(openrouter.calls.length, 0);
    } finally {
      if (prev === undefined) delete process.env.HELPER_MODEL; else process.env.HELPER_MODEL = prev;
    }
    assert.equal(llm.helperRoute(), 'glm', 'glm unless the switch says haiku');
  });
  await withHelpers({ reply: { title: 'GLM' }, key: null }, async ({ openrouter, events }) => {
    const out = await llm.generateSessionTitle({ requests: ['x'] });
    assert.equal(out.model, 'claude-haiku-4-5');
    assert.equal(openrouter.calls.length, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].attempt_number, 1, 'nothing was sent to GLM, so Haiku is the first attempt');
  });
});

test('a call the caller cancelled is not asked again of Haiku', async () => {
  const ctrl = new AbortController();
  const cancelled = (input) => { ctrl.abort(); throw Object.assign(new Error('cancelled'), { code: 'cancelled' }); };
  await withHelpers({ reply: cancelled }, async ({ client }) => {
    await assert.rejects(
      () => llm.generateQuickReplies({ rules: '', context: 'c', signal: ctrl.signal }),
      (err) => err.name === 'AbortError',
    );
    assert.equal(client.calls.length, 0);
  });
});

test('structured helpers read GLM\'s answer with their existing parse', async () => {
  await withHelpers({ reply: { actionable: true, title: 'Fix the broken leaderboard sort' } }, async ({ openrouter }) => {
    const out = await llm.generateIssueTitle({ description: 'The leaderboard sorts wrong.' });
    assert.equal(out.title, 'Fix the broken leaderboard sort');
    assert.equal(out.actionable, true);
    assert.equal(openrouter.calls[0].timeoutMs, llm.HELPER_TIME_LIMIT_MS.issue_title);
    assert.deepEqual(openrouter.calls[0].tools[0].function.parameters, llm.ISSUE_TITLE_SCHEMA);
    assert.equal(openrouter.calls[0].messages[0].role, 'user', 'no system message when the helper has none');
  });
  await withHelpers({ reply: { kind: 'change', title: 'Add a Sunday watering reminder' } }, async () => {
    const out = await llm.readChatAsk({ text: 'Can it remind us on Sundays?' });
    assert.equal(out.kind, 'change');
    assert.equal(out.title, 'Add a Sunday watering reminder');
  });
  await withHelpers({ reply: { estimate: 'maybe halfway', remaining_seconds: 240 } }, async () => {
    const out = await llm.estimateRunProgress({ userRequest: 'x', progressTail: ['Reading a.js'], elapsedMs: 60000 });
    assert.equal(out.remainingSeconds, 240);
    assert.equal(out.model, 'z-ai/glm-5.3-flash');
  });
  await withHelpers({ reply: { verdict: 'pass', category: '', file: '', reason: 'Nothing against the rules.' } }, async ({ openrouter }) => {
    const out = await llm.reviewContentRules({ system: 's', diff: 'd', telemetryContext: { component: 'content_review' } });
    assert.equal(out.verdict, 'pass');
    assert.equal(openrouter.calls[0].timeoutMs, llm.HELPER_TIME_LIMIT_MS.content_review);
  });
  await withHelpers({ reply: { score: 180, reason: 'Clear steps.' } }, async ({ openrouter, events }) => {
    const out = await llm.gradeChallengeUnit({
      system: 'rubric', user: 'report', schema: { type: 'object', properties: { score: { type: 'integer' }, reason: { type: 'string' } }, required: ['score', 'reason'] },
      telemetryContext: { component: 'challenge_grade_feedback' },
    });
    assert.equal(out.score, 180);
    assert.equal(out.model, 'z-ai/glm-5.3-flash');
    assert.equal(openrouter.calls[0].timeoutMs, llm.HELPER_TIME_LIMIT_MS.challenge_grade);
    assert.equal(events[0].component, 'challenge_grade_feedback', 'the grader\'s own component is kept');
  });
  // The sketch is asked through the card schema app-sketch.js owns; with
  // none, it goes to Haiku as before.
  await withHelpers({ reply: { emoji: '🪴', tagline: 'Keep the plants alive', points: ['See who watered last'] } }, async ({ openrouter, client }) => {
    const sketch = require('../src/services/app-sketch');
    const out = await llm.generateAppSketch({ system: 's', user: 'u', schema: sketch.CARD_SCHEMA, maxTokens: 400 });
    assert.equal(JSON.parse(out.text).tagline, 'Keep the plants alive');
    assert.equal(openrouter.calls[0].timeoutMs, llm.HELPER_TIME_LIMIT_MS.app_sketch);
    await llm.generateAppSketch({ system: 's', user: 'u', maxTokens: 400 });
    assert.equal(openrouter.calls.length, 1);
    assert.equal(client.calls[0].model, 'claude-haiku-4-5');
  });
});

test('the Workshop ask box: GLM\'s answer arrives whole; a picked model is asked as before', async () => {
  await withHelpers({ reply: { answer: 'It adds a reminder on Sundays.' } }, async ({ openrouter }) => {
    const tokens = [];
    const out = await llm.answerWorkshopQuestion({ contextJson: '{}', question: 'What does it do?', onToken: (t) => tokens.push(t) });
    assert.equal(out.text, 'It adds a reminder on Sundays.');
    assert.equal(out.model, 'z-ai/glm-5.3-flash');
    assert.deepEqual(tokens, ['It adds a reminder on Sundays.']);
    assert.equal(openrouter.calls[0].timeoutMs, llm.HELPER_TIME_LIMIT_MS.workshop_ask);
    assert.deepEqual(openrouter.calls[0].tools[0].function.parameters, llm.WORKSHOP_ASK_SCHEMA);
  });
  assert.equal(llm.WORKSHOP_ASK_MODEL, llm.HELPER_MODEL);
});

test('the bill: OpenRouter\'s figure when it gave one, else the published GLM price', () => {
  assert.equal(llm.estimateCostCents({ input_tokens: 1e6, output_tokens: 0, cost_usd: 0.0002 }, 'z-ai/glm-5.3-flash'), 0.02);
  const published = require('../src/services/model-costs').publishedPricing('z-ai/glm-5.3-flash');
  assert.equal(
    llm.estimateCostCents({ input_tokens: 1e6, output_tokens: 1e6, cost_usd: null }, 'z-ai/glm-5.3-flash'),
    (published.inputPricePerMillion + published.outputPricePerMillion) * 100,
  );
  assert.equal(llm.estimateCostCents({ input_tokens: 1000, output_tokens: 1000 }, 'claude-haiku-4-5'), 0.6, 'Claude rates unchanged');
});

test('every helper the switch names goes through the path, and telemetry knows each by name', () => {
  const src = read('src/services/llm.js');
  for (const helper of Object.keys(llm.HELPER_TIME_LIMIT_MS)) {
    if (helper === 'workshop_ask') {
      assert.match(src, /askHelperModel\(\{\s+helper: 'workshop_ask',/);
    } else {
      assert.match(src, new RegExp(`helperMessage\\(\\{\\s+helper: '${helper}',`), `${helper} asks through helperMessage`);
    }
  }
  assert.equal((src.match(/'claude-haiku-4-5'/g) || []).length, 1, 'Haiku is named once, as the fallback');
  const components = read('src/services/llm-telemetry.js');
  for (const c of [...Object.keys(llm.HELPER_TIME_LIMIT_MS).filter((h) => h !== 'challenge_grade'), 'challenge_grade_feedback', 'challenge_grade_proposal']) {
    assert.ok(components.includes(`'${c}'`), `${c} is a telemetry component`);
  }

  const manifest = JSON.parse(read('dapp.json'));
  const entry = manifest.platform_env.find((e) => e.key === 'HELPER_MODEL');
  assert.equal(entry.default, 'glm');
  assert.match(entry.description, /haiku: Haiku 4\.5 only/);
  assert.equal(require('../src/services/app-sketch').SKETCH_MODEL, llm.HELPER_MODEL);
  assert.equal(require('../src/services/topochain/challenge-grader').GRADE_MODEL, llm.HELPER_MODEL);
  assert.match(read('src/services/mayor/pills.js'), /qrWithTimeout\(\(signal\) => llm\.generateQuickReplies\(\{[\s\S]*?signal,/,
    'the pills budget cancels the GLM attempt too');
});
