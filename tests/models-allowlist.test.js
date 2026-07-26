// Tests for the model allowlist (src/services/models.js). Locks in the
// resolve() fallback contract (a genuinely unknown model id — including
// the now-removed Haiku 4.5 — coerces to DEFAULT_MODEL, Opus 5), the
// exact set list() exposes to GET /api/models after the #800 Haiku
// removal, and the presence of the selector's `changeSize` guidance on
// every entry.
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

// #800: Haiku 4.5 is no longer user-selectable. The platform still calls
// it directly for titling/estimates, but it must not survive the
// allowlist gate — a stale stored selection has to coerce to the default.
test('Haiku 4.5 is no longer an allowed model (#800)', () => {
  assert.equal(models.isAllowed('claude-haiku-4-5'), false);
  assert.equal(models.resolve('claude-haiku-4-5'), 'claude-opus-5');
});

test('list() exposes exactly the three model ids', () => {
  const ids = models.list().map((m) => m.id).sort();
  assert.deepEqual(ids, [
    'claude-fable-5',
    'claude-opus-5',
    'claude-sonnet-5',
  ]);
});

test('every model carries recommended change-size guidance (#800)', () => {
  for (const m of models.list()) {
    assert.ok(m.changeSize, `${m.id} has no changeSize`);
    assert.equal(typeof m.changeSize.short, 'string');
    assert.equal(typeof m.changeSize.long, 'string');
    assert.ok(m.changeSize.short.length > 0, `${m.id} changeSize.short is empty`);
    assert.ok(m.changeSize.long.length > 0, `${m.id} changeSize.long is empty`);
  }
});

test('every model still declares a tier the stats aggregate can key on', () => {
  const tiers = models.list().map((m) => m.tier).sort();
  assert.deepEqual(tiers, ['fable', 'opus', 'sonnet']);
});
