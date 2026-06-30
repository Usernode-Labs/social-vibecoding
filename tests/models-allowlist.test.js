// Tests for the model allowlist (src/services/models.js). Locks in the
// Fable 5 removal and the resolve() fallback contract: a stale or unknown
// model id coerces to DEFAULT_MODEL, and list() exposes exactly the three
// remaining model ids to GET /api/models.
//
// Run with: node --test tests/models-allowlist.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const models = require('../src/services/models');

test('Fable 5 is no longer an allowed model', () => {
  assert.equal(models.isAllowed('claude-fable-5'), false);
});

test('a stored Fable 5 selection resolves to the default model', () => {
  assert.equal(models.resolve('claude-fable-5'), 'claude-sonnet-5');
});

test('list() exposes exactly the three remaining model ids', () => {
  const ids = models.list().map((m) => m.id).sort();
  assert.deepEqual(ids, ['claude-haiku-4-5', 'claude-opus-4-8', 'claude-sonnet-5']);
});
