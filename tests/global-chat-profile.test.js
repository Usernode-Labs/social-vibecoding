'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const agentModels = require('../src/services/agent-models');
const profile = require('../src/services/global-chat/profile');

const config = {
  openrouterDefaultGlobalChatModel: 'cheap/default',
  openrouterDefaultGlobalChatReasoning: 'low',
  openrouterGlobalChatFallbackModels: ['fallback/valid'],
};

test('global-chat profile validation keeps cheap defaults separate and money exact', () => {
  assert.deepEqual(profile.defaults(config), {
    backend: 'openrouter',
    enabled: false,
    model: 'cheap/default',
    reasoningEffort: 'low',
    spendCapUsd: null,
  });
  assert.throws(
    () => profile.money('000.10000000'),
    /nonnegative USD amount/,
    'ambiguous noncanonical amounts are rejected',
  );
});

test('legacy minimal GLM Flash profiles are read as the supported low effort', () => {
  const legacyConfig = {
    openrouterDefaultGlobalChatModel: 'z-ai/glm-5.3-flash',
    openrouterDefaultGlobalChatReasoning: 'minimal',
  };
  assert.equal(profile.defaults(legacyConfig).reasoningEffort, 'low');
  assert.equal(profile.publicProfile({
    model_id: 'z-ai/glm-5.3-flash',
    reasoning_effort: 'minimal',
    spend_cap_usd: null,
    updated_at: null,
  }, config).reasoningEffort, 'low');
  assert.equal(profile.compatibleReasoningEffort('another/model', 'minimal'), 'minimal');
});

test('global-chat profile rejects unsafe values and normalizes valid spend caps', () => {
  assert.equal(profile.money('0.50000000'), '0.5');
  assert.equal(profile.money(12), '12');
  assert.equal(profile.money(null), null);
  assert.throws(() => profile.money('-1'), /nonnegative/);
  assert.throws(() => profile.money('1.000000001'), /at most 8 decimals/);
  assert.throws(() => profile.modelId('model\n[injection]'), /valid model id/);
  assert.throws(() => profile.reasoningEffort('ultra'), /Invalid reasoning effort/);
  assert.equal(profile.enabled(true), true);
  assert.equal(profile.enabled(false), false);
  assert.throws(() => profile.enabled('true'), /boolean/);
});

test('sanitized OpenRouter metadata exposes the exact Global Chat requirements', () => {
  const valid = agentModels.sanitizeModel({
    id: 'vendor/valid',
    supported_parameters: [
      'tools', 'structured_outputs', 'reasoning', 'parallel_tool_calls',
    ],
    reasoning: { supported_efforts: ['low', 'high', 'max'] },
    context_length: 64_000,
  }, { status: 'experimental', note: null });
  assert.equal(valid.supportsTools, true);
  assert.equal(valid.supportsStructuredOutputs, true);
  assert.equal(valid.supportsReasoningEffort, true);
  assert.equal(valid.supportsParallelToolCalls, true);
  assert.equal(valid.meetsGlobalChatMinimums, true);
  assert.equal(valid.reasoningEfforts, null, 'development-agent effort metadata stays unchanged');
  assert.deepEqual(valid.globalChatReasoningEfforts, ['low', 'high', 'max']);
  assert.equal(
    Object.keys(valid).includes('globalChatReasoningEfforts'),
    false,
    'Global Chat metadata must not alter existing development catalog JSON',
  );
  assert.equal(profile.supportsEffort(valid, 'low'), true);
  assert.equal(profile.supportsEffort(valid, 'minimal'), false);

  const textOnly = agentModels.sanitizeModel({
    id: 'vendor/text-only',
    supported_parameters: ['reasoning', 'structured_outputs'],
    context_length: 64_000,
  }, { status: 'experimental', note: null });
  assert.equal(textOnly.meetsGlobalChatMinimums, false);
});

test('global chat catalog includes only models that meet tools and the exact effort', () => {
  const catalog = profile.globalChatCatalog({
    credentialRevision: 4,
    refreshedAt: '2026-09-18T12:00:00.000Z',
    models: [
      {
        id: 'fallback/valid', supportsTools: true, supportsStructuredOutputs: true,
        supportsReasoningEffort: true, reasoningEfforts: ['low', 'high'],
      },
      {
        id: 'cheap/default', supportsTools: true, supportsStructuredOutputs: true,
        supportsReasoningEffort: true, reasoningEfforts: ['high'],
      },
      {
        id: 'vendor/tool-only', supportsTools: true, supportsStructuredOutputs: false,
        supportsReasoningEffort: true, reasoningEfforts: ['low'],
      },
      {
        id: 'vendor/no-tools', supportsTools: false, supportsStructuredOutputs: true,
        supportsReasoningEffort: true,
      },
    ],
  }, config, 'low');

  assert.deepEqual(
    catalog.models.map((model) => model.id),
    ['fallback/valid', 'vendor/tool-only'],
  );
  assert.equal(catalog.recommendedModelId, 'fallback/valid');
  assert.equal(catalog.models[0].isGlobalChatRecommended, true);
  assert.deepEqual(catalog.requiredCapabilities, {
    tools: true,
    structuredOutputs: false,
    reasoningEffort: 'low',
  });
});

test('monthly usage uses UTC boundaries and reports exact cap remaining', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{
        spent_usd: '0.12345678', input_tokens: '10', output_tokens: '4',
        reasoning_tokens: '2', turns: '3', priced_turns: '2', pending_turns: '1',
        successful_turns: '2',
      }] };
    },
  };
  const result = await profile.readMonthlyUsage(pool, 7, {
    now: new Date('2026-09-30T23:59:59.000Z'),
    spendCapUsd: '0.2',
  });
  assert.equal(result.periodStart, '2026-09-01T00:00:00.000Z');
  assert.equal(result.resetAt, '2026-10-01T00:00:00.000Z');
  assert.equal(result.remainingUsd, '0.07654322');
  assert.equal(result.capReached, false);
  assert.equal(result.unpricedTurns, '1');
  assert.equal(result.pendingTurns, '1');
  assert.equal(result.costComplete, false);
  assert.deepEqual(calls[0].params, [
    7,
    new Date('2026-09-01T00:00:00.000Z'),
    new Date('2026-10-01T00:00:00.000Z'),
  ]);
});

test('global-chat tables are private and remain above the standalone schema tail', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  const marker = schema.indexOf('EVERYTHING BELOW THIS LINE MUST STAND UP ON ITS OWN.');
  for (const table of [
    'global_chat_profiles', 'global_chat_threads', 'global_chat_messages',
    'global_chat_tool_runs', 'global_chat_action_tokens', 'global_chat_usage',
  ]) {
    const position = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`);
    assert.ok(position > 0 && position < marker, `${table} must precede the standalone tail`);
    assert.match(schema, new RegExp(`COMMENT ON TABLE ${table} IS 'staging:private'`));
  }
  assert.match(schema, /global_chat_action_tokens[\s\S]*token_hash\s+VARCHAR\(64\) NOT NULL UNIQUE/);
  assert.doesNotMatch(schema, /global_chat_action_tokens[\s\S]{0,800}\braw_token\b/);
  assert.match(schema, /global_chat_profiles \([\s\S]*enabled\s+BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(schema, /ALTER TABLE global_chat_profiles[\s\S]*ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT FALSE/);
});
