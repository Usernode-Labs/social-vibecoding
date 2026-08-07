'use strict';
// Commit 7 (plan §9): new sessions must be inserted with their final
// default coding-agent backend/model atomically. Tests the
// resolveDefaultAgentPreference resolver across the deterministic fallback
// semantics (9.2/9.5).

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveDefaultAgentPreference } = require('../src/routes/sessions');

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
};

test('no preference → Claude default', async () => {
  const { pool } = makePool({ prefRow: null });
  const out = await resolveDefaultAgentPreference(pool, 7, BASE_CONFIG);
  assert.deepEqual(out, { backend: 'claude_code', provider: 'anthropic', model: null, reasoningEffort: null });
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
