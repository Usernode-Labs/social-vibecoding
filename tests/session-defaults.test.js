'use strict';
// Commit 7 (plan §9): new sessions must be inserted with their final
// default coding-agent backend/model atomically. Tests the
// resolveDefaultAgentPreference resolver across the deterministic fallback
// semantics (9.2/9.5).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AgentSelectionError,
  codingAgentRuntimeIdentity,
  resolveDefaultAgentPreference,
  resolveExplicitAgentPreference,
} = require('../src/routes/sessions');

// A stubbed pool that serves the user_agent_preferences row and the
// OpenRouter credential metadata row for resolveDefaultAgentPreference.
function makePool({ prefRow = null, credRow = null }) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push(sql);
    if (/FROM user_agent_preferences/.test(sql)) {
      return { rows: prefRow ? [prefRow] : [] };
    }
    if (/FROM credentials\.user_ai_credentials/.test(sql)) {
      return { rows: credRow ? [credRow] : [] };
    }
    return { rows: [] };
  };
  return { pool: { query, connect: async () => ({ query, release() {} }) }, calls };
}

const BASE_CONFIG = {
  codexOpenrouterEnabled: true,
  openrouterBetaUserIds: [],
  openrouterDefaultCodexModel: 'openai/gpt-5.3-codex',
  dataEncryptionKey: 'test-data-key',
};

function stubExplicitCodexServices(t, {
  metadata = { id: 1, status: 'valid', revision: 4 },
  secret = 'sk-or-test',
  models = [{ id: 'openai/gpt-5.3-codex' }],
  catalogError = null,
} = {}) {
  const credentialStore = require('../src/services/credential-store');
  const agentModels = require('../src/services/agent-models');
  const originals = {
    readMetadata: credentialStore.readMetadata,
    readSecret: credentialStore.readSecret,
    listOpenRouterModels: agentModels.listOpenRouterModels,
  };
  credentialStore.readMetadata = async () => metadata;
  credentialStore.readSecret = async (args) => {
    assert.equal(args.expectedRevision, metadata?.revision);
    return secret;
  };
  agentModels.listOpenRouterModels = async () => {
    if (catalogError) throw catalogError;
    return { models };
  };
  t.after(() => {
    credentialStore.readMetadata = originals.readMetadata;
    credentialStore.readSecret = originals.readSecret;
    agentModels.listOpenRouterModels = originals.listOpenRouterModels;
  });
}

test('no preference and no OpenRouter key → Claude default', async () => {
  const { pool } = makePool({ prefRow: null });
  const out = await resolveDefaultAgentPreference(pool, 7, BASE_CONFIG);
  assert.deepEqual(out, { backend: 'claude_code', provider: 'anthropic', model: null, reasoningEffort: null });
});

test('no preference and a usable OpenRouter key → live-catalog OpenRouter default', async (t) => {
  const credentialStore = require('../src/services/credential-store');
  const agentModels = require('../src/services/agent-models');
  const originals = {
    readMetadata: credentialStore.readMetadata,
    readSecret: credentialStore.readSecret,
    listOpenRouterModels: agentModels.listOpenRouterModels,
  };
  credentialStore.readMetadata = async () => ({ id: 2, status: 'valid', revision: 5 });
  credentialStore.readSecret = async () => 'sk-or-v1-existing';
  agentModels.listOpenRouterModels = async () => ({ recommendedModelId: 'z-ai/glm-5.3' });
  t.after(() => {
    credentialStore.readMetadata = originals.readMetadata;
    credentialStore.readSecret = originals.readSecret;
    agentModels.listOpenRouterModels = originals.listOpenRouterModels;
  });
  const { pool } = makePool({ prefRow: null });
  const out = await resolveDefaultAgentPreference(pool, 7, {
    ...BASE_CONFIG, openrouterDefaultCodexModel: 'z-ai/glm-5.3',
  });
  assert.deepEqual(out, {
    backend: 'codex_openrouter', provider: 'openrouter',
    model: 'z-ai/glm-5.3', reasoningEffort: null,
  });
});

test('Claude default → Claude', async () => {
  const { pool } = makePool({ prefRow: { backend: 'claude_code', model_id: null, reasoning_effort: null } });
  const out = await resolveDefaultAgentPreference(pool, 7, BASE_CONFIG);
  assert.equal(out.backend, 'claude_code');
});

test('valid Codex default with model → Codex applied', async () => {
  const { pool } = makePool({
    prefRow: { backend: 'codex_openrouter', model_id: 'openai/gpt-5.3-codex', reasoning_effort: 'high' },
    credRow: { id: 1, status: 'valid', revision: 2 },
  });
  const out = await resolveDefaultAgentPreference(pool, 7, BASE_CONFIG);
  assert.equal(out.backend, 'codex_openrouter');
  assert.equal(out.provider, 'openrouter');
  assert.equal(out.model, 'openai/gpt-5.3-codex');
  assert.equal(out.reasoningEffort, 'high');
});

test('Codex default without model → operator default model used', async () => {
  const { pool } = makePool({
    prefRow: { backend: 'codex_openrouter', model_id: null, reasoning_effort: null },
    credRow: { id: 1, status: 'valid', revision: 2 },
  });
  const out = await resolveDefaultAgentPreference(pool, 7, BASE_CONFIG);
  assert.equal(out.backend, 'codex_openrouter');
  assert.equal(out.model, 'openai/gpt-5.3-codex');
});

test('Codex default with no model and no operator default → Claude fallback', async () => {
  const { pool } = makePool({
    prefRow: { backend: 'codex_openrouter', model_id: null, reasoning_effort: null },
    credRow: { id: 1, status: 'valid', revision: 2 },
  });
  const out = await resolveDefaultAgentPreference(pool, 7, { ...BASE_CONFIG, openrouterDefaultCodexModel: '' });
  assert.equal(out.backend, 'claude_code');
});

test('Codex default but feature disabled → Claude fallback', async () => {
  const { pool } = makePool({
    prefRow: { backend: 'codex_openrouter', model_id: 'm', reasoning_effort: null },
    credRow: { id: 1, status: 'valid', revision: 2 },
  });
  const out = await resolveDefaultAgentPreference(pool, 7, { ...BASE_CONFIG, codexOpenrouterEnabled: false });
  assert.equal(out.backend, 'claude_code');
});

test('Codex default but beta access revoked → Claude fallback', async () => {
  const { pool } = makePool({
    prefRow: { backend: 'codex_openrouter', model_id: 'm', reasoning_effort: null },
    credRow: { id: 1, status: 'valid', revision: 2 },
  });
  const out = await resolveDefaultAgentPreference(pool, 7, { ...BASE_CONFIG, openrouterBetaUserIds: ['999'] });
  assert.equal(out.backend, 'claude_code');
});

test('Codex default but missing/invalid credential → Claude fallback', async () => {
  const { pool } = makePool({
    prefRow: { backend: 'codex_openrouter', model_id: 'm', reasoning_effort: null },
    credRow: null,
  });
  const out = await resolveDefaultAgentPreference(pool, 7, BASE_CONFIG);
  assert.equal(out.backend, 'claude_code');
});

test('a preference-quoting/resolver failure falls back to Claude, not "no preference"', async () => {
  // Simulate a DB error reading the preference — the resolver throws and
  // session creation should fail (plan 9.2: a DB error is NOT "no
  // preference").
  const query = async () => { throw new Error('db down'); };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  await assert.rejects(() => resolveDefaultAgentPreference(pool, 7, BASE_CONFIG));
});

test('an explicit Claude choice is honored even when Codex is disabled', async () => {
  const out = await resolveExplicitAgentPreference({}, 7, {
    ...BASE_CONFIG, codexOpenrouterEnabled: false,
  }, {
    backend: 'claude_code', model: 'ignored', reasoningEffort: 'high',
  });
  assert.deepEqual(out, {
    backend: 'claude_code', provider: 'anthropic', model: null, reasoningEffort: null,
  });
});

test('an explicit Codex choice is returned exactly after key and catalog validation', async (t) => {
  stubExplicitCodexServices(t);
  const out = await resolveExplicitAgentPreference({}, 7, BASE_CONFIG, {
    backend: 'codex_openrouter',
    model: 'openai/gpt-5.3-codex',
    reasoningEffort: 'high',
  });
  assert.deepEqual(out, {
    backend: 'codex_openrouter',
    provider: 'openrouter',
    model: 'openai/gpt-5.3-codex',
    reasoningEffort: 'high',
  });
});

test('an explicit non-reasoning OpenRouter model drops an inapplicable effort', async (t) => {
  stubExplicitCodexServices(t, {
    models: [{ id: 'vendor/plain-tools-model', supportsReasoning: false }],
  });
  const out = await resolveExplicitAgentPreference({}, 7, BASE_CONFIG, {
    backend: 'codex_openrouter',
    model: 'vendor/plain-tools-model',
    reasoningEffort: 'high',
  });
  assert.equal(out.model, 'vendor/plain-tools-model');
  assert.equal(out.reasoningEffort, null);
});

test('an explicit Codex choice never silently falls back when unavailable', async () => {
  await assert.rejects(
    () => resolveExplicitAgentPreference({}, 7, {
      ...BASE_CONFIG, codexOpenrouterEnabled: false,
    }, {
      backend: 'codex_openrouter', model: 'openai/gpt-5.3-codex',
    }),
    (err) => err instanceof AgentSelectionError
      && err.statusCode === 403
      && /not available/.test(err.message),
  );
});

test('an explicit Codex choice requires a user-selected model', async () => {
  await assert.rejects(
    () => resolveExplicitAgentPreference({}, 7, BASE_CONFIG, {
      backend: 'codex_openrouter', model: null,
    }),
    (err) => err instanceof AgentSelectionError
      && err.statusCode === 400
      && /Choose an OpenRouter model/.test(err.message),
  );
});

test('an explicit Codex choice rejects a model outside the user catalog', async (t) => {
  stubExplicitCodexServices(t, { models: [{ id: 'openai/another-model' }] });
  await assert.rejects(
    () => resolveExplicitAgentPreference({}, 7, BASE_CONFIG, {
      backend: 'codex_openrouter', model: 'openai/gpt-5.3-codex',
    }),
    (err) => err instanceof AgentSelectionError
      && err.statusCode === 400
      && /not available under your OpenRouter key/.test(err.message),
  );
});

test('an explicit unknown backend is a client error', async () => {
  await assert.rejects(
    () => resolveExplicitAgentPreference({}, 7, BASE_CONFIG, { backend: 'mystery-agent' }),
    (err) => err instanceof AgentSelectionError
      && err.statusCode === 400
      && err.message === 'Unknown backend',
  );
});

test('runtime identity preserves the legacy Claude model and labels', () => {
  const out = codingAgentRuntimeIdentity(
    { agent_backend: 'claude_code', agent_model: null },
    'claude-opus-4-6',
    BASE_CONFIG,
  );
  assert.equal(out.backend, 'claude_code');
  assert.equal(out.agentName, 'Claude Code');
  assert.equal(out.model, 'claude-opus-4-6');
  assert.equal(out.modelLabel, 'Opus');
  assert.deepEqual(out.metadata, {
    agentBackend: 'claude_code', agentModel: 'claude-opus-4-6',
  });
});

test('runtime identity pins Codex reporting to the session model, not the Mayor model', () => {
  const out = codingAgentRuntimeIdentity(
    { agent_backend: 'codex_openrouter', agent_model: 'openai/gpt-5.3-codex' },
    'claude-opus-4-6',
    { ...BASE_CONFIG, openrouterDefaultCodexModel: 'openai/operator-default' },
  );
  assert.equal(out.backend, 'codex_openrouter');
  assert.equal(out.agentName, 'OpenRouter');
  assert.equal(out.model, 'openai/gpt-5.3-codex');
  assert.equal(out.modelLabel, 'openai/gpt-5.3-codex');
  assert.deepEqual(out.metadata, {
    agentBackend: 'codex_openrouter', agentModel: 'openai/gpt-5.3-codex',
  });
});

test('a malformed Codex row never borrows the Mayor Claude model', () => {
  const out = codingAgentRuntimeIdentity(
    { agent_backend: 'codex_openrouter', agent_model: null },
    'claude-opus-4-6',
    { ...BASE_CONFIG, openrouterDefaultCodexModel: '' },
  );
  assert.equal(out.model, null);
  assert.equal(out.modelLabel, 'model not configured');
  assert.equal(out.metadata.agentModel, null);
});

test('runtime model display is markup-safe without changing the executable id', () => {
  const model = 'openai/<img src=x onerror=alert(1)>-codex';
  const out = codingAgentRuntimeIdentity(
    { agent_backend: 'codex_openrouter', agent_model: model },
    'claude-opus-4-6',
    BASE_CONFIG,
  );
  assert.equal(out.model, model);
  assert.equal(out.metadata.agentModel, model);
  assert.doesNotMatch(out.modelLabel, /[<>"']/);
});

test('runtime model display preserves OpenRouter latest-alias prefixes', () => {
  const model = '~deepseek/deepseek-v4-flash-latest';
  const out = codingAgentRuntimeIdentity(
    { agent_backend: 'codex_openrouter', agent_model: model },
    'claude-opus-4-6',
    BASE_CONFIG,
  );
  assert.equal(out.model, model);
  assert.equal(out.modelLabel, model);
  assert.equal(out.agentName, 'OpenRouter');
});
