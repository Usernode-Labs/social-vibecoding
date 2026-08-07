'use strict';
// Direct-transport proof test (review P0 + test-coverage gap #9): asserts
// that a codex_openrouter turn is dispatched CONFIGURED DIRECTLY at
// OpenRouter with the user's own key, with NO platform relay call and NO
// agent-proxy token, and that the per-turn secret env contains ONLY the
// credentials that backend needs (never Anthropic authority, and never a
// push token on scout).
//
// Run with: node --test tests/openrouter-direct-transport.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const worker = require('../src/services/worker');

// ── Secret-env isolation (the "no relay / no Anthropic authority" proof) ──
test('codex_openrouter scout env carries ONLY the OpenRouter key (no push, no Anthropic)', () => {
  const env = worker.buildTurnSecretEnv({
    mode: 'scout',
    workerJwt: 'minted.worker.jwt',
    anthropicApiKey: null,
    prodDebugJwt: 'minted.proddebug.jwt',
    openrouterApiKey: 'sk-or-user-key',
    agentBackend: 'codex_openrouter',
  });
  // Only the one credential this backend needs.
  assert.deepEqual(Object.keys(env).sort(), ['OPENROUTER_API_KEY']);
  assert.equal(env.OPENROUTER_API_KEY, 'sk-or-user-key');
  // Scout must never receive push authority, an Anthropic proxy authority,
  // or a platform relay token.
  assert.ok(!('WORKER_JWT' in env), 'scout must not receive WORKER_JWT');
  assert.ok(!('ISSUES_JWT' in env), 'scout must not receive ISSUES_JWT');
  assert.ok(!('USERNODE_AGENT_TOKEN' in env), 'scout must not receive a relay token');
  assert.ok(!('ANTHROPIC_API_KEY' in env));
  assert.ok(!('ANTHROPIC_BASE_URL' in env));
});

test('codex_openrouter build env adds WORKER_JWT but still no Anthropic/relay', () => {
  const env = worker.buildTurnSecretEnv({
    mode: 'build',
    workerJwt: 'minted.worker.jwt',
    anthropicApiKey: null,
    prodDebugJwt: 'minted.proddebug.jwt',
    openrouterApiKey: 'sk-or-user-key',
    agentBackend: 'codex_openrouter',
  });
  assert.deepEqual(Object.keys(env).sort(), ['ISSUES_JWT', 'OPENROUTER_API_KEY', 'WORKER_JWT']);
  assert.equal(env.OPENROUTER_API_KEY, 'sk-or-user-key');
  assert.equal(env.WORKER_JWT, 'minted.worker.jwt');
  assert.ok(!('ANTHROPIC_API_KEY' in env));
  assert.ok(!('ANTHROPIC_BASE_URL' in env));
  assert.ok(!('USERNODE_AGENT_TOKEN' in env));
});

test('claude_code build env keeps exactly the legacy Anthropic authority', () => {
  const env = worker.buildTurnSecretEnv({
    mode: 'build',
    workerJwt: 'minted.worker.jwt',
    anthropicApiKey: null,
    prodDebugJwt: null,
    openrouterApiKey: null,
    agentBackend: 'claude_code',
  });
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'ISSUES_JWT', 'WORKER_JWT']);
  assert.ok(!('OPENROUTER_API_KEY' in env), 'Claude turns must not carry the OpenRouter key');
});

// ── Runner config (direct transport proof) ──────────────────────────────
test('runner script points Codex directly at OpenRouter, never a relay', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const script = fs.readFileSync(path.join(__dirname, '..', 'worker', 'run-codex-agent.sh'), 'utf8');
  // Codex is configured with OpenRouter as base_url and OPENROUTER_API_KEY
  // as the provider env key (direct transport).
  assert.match(script, /base_url = "\$ESCAPED_BASE"/);
  assert.match(script, /env_key = "OPENROUTER_API_KEY"/);
  assert.match(script, /OPENROUTER_API_KEY/);
  // No platform relay / proxy token wiring remains.
  assert.ok(!/USERNODE_AGENT_TOKEN/.test(script), 'runner must not use a relay token');
  assert.ok(!/internal\/openrouter/.test(script), 'runner must not point at a platform relay');
  assert.ok(!/OPENROUTER_PROXY_ENABLED/.test(script));
});
