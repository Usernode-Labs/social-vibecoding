// Tests for the model allowlist (src/services/models.js). Locks in the
// Fable 5 re-addition and the resolve() fallback contract: a genuinely
// unknown model id coerces to DEFAULT_MODEL (now Opus 5), and list()
// exposes exactly the four model ids to GET /api/models.
//
// Run with: node --test tests/models-allowlist.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const models = require('../src/services/models');

test('Fable 5 is an allowed model', () => {
  assert.equal(models.isAllowed('claude-fable-5'), true);
});

test('an allowed Fable 5 selection resolves to itself', () => {
  assert.equal(models.resolve('claude-fable-5'), 'claude-fable-5');
});

test('an unknown model id resolves to the default model (Opus 5)', () => {
  assert.equal(models.resolve('claude-nope'), 'claude-opus-5');
});

test('list() exposes exactly the four model ids', () => {
  const ids = models.list().map((m) => m.id).sort();
  assert.deepEqual(ids, [
    'claude-fable-5',
    'claude-haiku-4-5',
    'claude-opus-5',
    'claude-sonnet-5',
  ]);
});
