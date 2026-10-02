// Tests for the model allowlist (src/services/models.js). Locks in the
// resolve() fallback contract (a genuinely unknown model id — including
// the now-removed Haiku 4.5 — coerces to DEFAULT_MODEL, Opus 5.5), the
// exact set list() exposes to GET /api/models after the #800 Haiku
// removal, and the presence of the selector's `changeSize` guidance on
// every entry.
//
// Run with: node --test tests/models-allowlist.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const models = require('../src/services/models');

test('Fable 5.1 is an allowed model', () => {
  assert.equal(models.isAllowed('claude-fable-5-1'), true);
});

test('an allowed Fable 5.1 selection resolves to itself', () => {
  assert.equal(models.resolve('claude-fable-5-1'), 'claude-fable-5-1');
});

test('an unknown model id resolves to the default model (Opus 5.5)', () => {
  assert.equal(models.resolve('claude-nope'), 'claude-opus-5-5');
});

// #2818: Opus 5.5 replaced Opus 5. A stored pick of the retired id is no
// longer allowed, and resolves to its successor BY NAME, so the mapping
// does not depend on which model happens to be the default.
test('the retired Opus 5 id resolves to Opus 5.5 (#2818)', () => {
  assert.equal(models.isAllowed('claude-opus-5'), false);
  assert.equal(models.resolve('claude-opus-5'), 'claude-opus-5-5');
  assert.equal(models.RETIRED_MODELS['claude-opus-5'], 'claude-opus-5-5');
  assert.equal(models.DEFAULT_MODEL, 'claude-opus-5-5');
  for (const successor of Object.values(models.RETIRED_MODELS)) {
    assert.equal(models.isAllowed(successor), true, `${successor} must be offered`);
  }
});

// #3579: Sonnet 5.5 replaced Sonnet 5 the same way. The picker offers 5.5
// only; a session, browser or setting that saved Sonnet 5 runs on 5.5.
test('the retired Sonnet 5 id resolves to Sonnet 5.5 (#3579)', () => {
  assert.equal(models.isAllowed('claude-sonnet-5'), false);
  assert.equal(models.isAllowed('claude-sonnet-5-5'), true);
  assert.equal(models.resolve('claude-sonnet-5'), 'claude-sonnet-5-5');
  assert.equal(models.resolve('claude-sonnet-5-5'), 'claude-sonnet-5-5');
  assert.equal(models.RETIRED_MODELS['claude-sonnet-5'], 'claude-sonnet-5-5');
  assert.equal(models.MODELS['claude-sonnet-5-5'].label, 'Sonnet 5.5');
  assert.equal(models.MODELS['claude-sonnet-5-5'].tier, 'sonnet');
  assert.equal(models.MODELS['claude-sonnet-5-5'].outputCostPerMTok, 10);
  assert.equal(models.MODELS['claude-sonnet-5'], undefined, 'not offered beside its successor');
});

test('the platform runs no call of its own on Sonnet 5 (#3579)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const llm = require('../src/services/llm');
  assert.equal(llm.WORKSHOP_THEME_MODEL, 'claude-sonnet-5-5');
  assert.equal(llm.PR_METADATA_MODEL, 'claude-sonnet-5-5');
  // The id may appear only where a retired id is mapped or priced for
  // recorded history: the two RETIRED_MODELS maps and RETIRED_PRICING.
  const root = path.join(__dirname, '..');
  const allowed = {
    'src/services/models.js': /^\s*'claude-sonnet-5': 'claude-sonnet-5-5',$/,
    'frontend/src/features/dev-chat/dev-chat.js': /^\s*RETIRED_MODELS: \{.*'claude-sonnet-5': 'claude-sonnet-5-5' \},$/,
    'src/services/model-costs.js': /^\s*'claude-sonnet-5': \{ inputPricePerMillion: 2, outputPricePerMillion: 10 \},$/,
  };
  const files = [
    'src/services/models.js', 'src/services/llm.js', 'src/services/model-costs.js',
    'src/services/sync-main.js', 'frontend/src/features/dev-chat/dev-chat.js', 'worker/run-cc.sh',
  ];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/claude-sonnet-5(?!-5)\b/.test(line)) return;
      assert.ok(allowed[file] && allowed[file].test(line), `${file}:${i + 1} still names Sonnet 5: ${line.trim()}`);
    });
  }
});

test('the platform LLM default moved to Opus 5.5 (#2818); the Fable fallback is Anthropic\'s default, not a pinned model', () => {
  const llm = require('../src/services/llm');
  assert.equal(llm.DEFAULT_MODEL, models.DEFAULT_MODEL);
  // #2818 also pinned the Fable fallback to Opus 5.5, which is not in
  // claude-fable-5-1's allowed_fallback_models: every Fable request 400'd.
  assert.equal(llm.FALLBACK_MODE, 'default');
  assert.equal(llm.FALLBACK_BETA, 'server-side-fallback-2026-07-01');
  assert.equal(llm.FALLBACK_TARGET_MODEL, undefined, 'no model list to keep valid');
});

test('Opus 5.5 is billed at its own $4/$20 rate, and a recorded Opus 5 turn at $5/$25', () => {
  const llm = require('../src/services/llm');
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
  assert.equal(Math.round(llm.estimateCostCents(usage, 'claude-opus-5-5')), 2400);
  assert.equal(Math.round(llm.estimateCostCents(usage, 'claude-opus-5')), 3000);
  assert.equal(models.MODELS['claude-opus-5-5'].outputCostPerMTok, 20);
});

// #800: Haiku 4.5 is no longer user-selectable. The platform still calls
// it directly for titling/estimates, but it must not survive the
// allowlist gate — a stale stored selection has to coerce to the default.
test('Haiku 4.5 is no longer an allowed model (#800)', () => {
  assert.equal(models.isAllowed('claude-haiku-4-5'), false);
  assert.equal(models.resolve('claude-haiku-4-5'), 'claude-opus-5-5');
});

test('list() exposes exactly the three model ids', () => {
  const ids = models.list().map((m) => m.id).sort();
  assert.deepEqual(ids, [
    'claude-fable-5-1',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
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
