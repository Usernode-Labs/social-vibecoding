'use strict';
// Tests for the agent backend registry (plan.md PR1 + review finding F6).
//
// Run with: node --test tests/agent-registry.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../src/agents/registry');

test('defaults to claude_code only for ABSENT values', () => {
  assert.equal(registry.resolveBackend(null), 'claude_code');
  assert.equal(registry.resolveBackend(undefined), 'claude_code');
  assert.equal(registry.resolveBackend(''), 'claude_code');
});

test('returns a known backend unchanged', () => {
  assert.equal(registry.resolveBackend('claude_code'), 'claude_code');
  assert.equal(registry.isBackend('claude_code'), true);
});

test('F6: fails CLOSED on unknown or typo backend ids (never silently Claude)', () => {
  for (const bad of ['cluade_code', 'unknown-backend', ' ', 'CODE', 'claudecode']) {
    assert.throws(() => registry.resolveBackend(bad), /unknown backend/, `should reject '${bad}'`);
  }
});

test('getBackend resolves known and throws on unknown', () => {
  assert.equal(registry.getBackend('claude_code').provider, 'anthropic');
  assert.equal(registry.getBackend('claude_code').runner, '/usr/local/bin/run-cc.sh');
  assert.equal(registry.getBackend('codex_openrouter').runner, '/usr/local/bin/run-codex-agent.sh');
  assert.throws(() => registry.getBackend('nope'), /unknown backend/);
});

test('listBackends exposes both seeded backends', () => {
  const all = registry.listBackends();
  assert.deepEqual(all.map((b) => b.id).sort(), ['claude_code', 'codex_openrouter']);
});
