// Unit tests for src/services/model-stats.js (#800) — the measured half
// of the model selector that replaced the old "$X/MTok" labels.
//
// Covers the pure display math and the service's failure/staging
// behaviour:
//   - tierOf folds previous-generation ids into the current tier families
//     (the whole reason the aggregate is per-tier rather than per-id)
//   - wilsonBand reproduces the production figures the spec quotes, and
//     can never emit a bound outside 0-100 at p=0 / p=1
//   - below MIN_ATTEMPTS the band is suppressed rather than shown with
//     false precision
//   - a failing query yields null (the UI then renders plain labels), and
//     never throws
//   - USERNODE_ENV=staging returns the fixed demo counts flagged demo:true
//
// Run with: node --test tests/model-stats.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const stats = require('../src/services/model-stats');
const models = require('../src/services/models');

// ── tierOf ──────────────────────────────────────────────────────────

test('tierOf folds current AND previous-generation ids into tiers', () => {
  assert.equal(stats.tierOf('claude-opus-5'), 'opus');
  assert.equal(stats.tierOf('claude-opus-4-8'), 'opus');
  assert.equal(stats.tierOf('claude-sonnet-4-6'), 'sonnet');
  assert.equal(stats.tierOf('claude-haiku-4-5-20251001'), 'haiku');
  assert.equal(stats.tierOf('claude-fable-5'), 'fable');
});

test('tierOf returns null for anything it does not recognise', () => {
  assert.equal(stats.tierOf('gpt-9'), null);
  assert.equal(stats.tierOf(''), null);
  assert.equal(stats.tierOf(null), null);
  assert.equal(stats.tierOf(undefined), null);
  assert.equal(stats.tierOf(42), null);
});

// ── wilsonBand ──────────────────────────────────────────────────────

// These two lock the z value (1.645) and the rounding together: they are
// the exact production counts quoted in the spec, so a change to either
// constant moves these numbers.
test('wilsonBand reproduces the fable-tier production band (221/401)', () => {
  assert.deepEqual(stats.wilsonBand(221, 401), { lowPct: 51, highPct: 59 });
});

test('wilsonBand reproduces the opus-tier production band (149/312)', () => {
  assert.deepEqual(stats.wilsonBand(149, 312), { lowPct: 43, highPct: 52 });
});

test('wilsonBand stays inside 0-100 at both extremes', () => {
  const none = stats.wilsonBand(0, 30);
  assert.equal(none.lowPct, 0);
  assert.ok(none.highPct > 0 && none.highPct <= 100, `highPct=${none.highPct}`);

  const all = stats.wilsonBand(30, 30);
  assert.equal(all.highPct, 100);
  assert.ok(all.lowPct >= 0 && all.lowPct < 100, `lowPct=${all.lowPct}`);
});

test('wilsonBand widens as the sample shrinks', () => {
  const wide = stats.wilsonBand(10, 19);   // sonnet today
  const narrow = stats.wilsonBand(221, 401);
  assert.ok(
    (wide.highPct - wide.lowPct) > (narrow.highPct - narrow.lowPct),
    'a 19-attempt band must be wider than a 401-attempt one'
  );
});

test('wilsonBand returns null when there is nothing to compute', () => {
  assert.equal(stats.wilsonBand(0, 0), null);
  assert.equal(stats.wilsonBand(1, -5), null);
  assert.equal(stats.wilsonBand(NaN, 10), null);
});

// ── statsForModels ──────────────────────────────────────────────────

function stubPool(rows) {
  return { query: async () => ({ rows }) };
}

test('statsForModels maps tier counts onto every model id sharing the tier', async () => {
  stats._resetCacheForTests();
  const result = await stats.statsForModels(stubPool([
    { tier: 'fable', attempts: 401, solved: 221 },
    { tier: 'opus', attempts: 312, solved: 149 },
    { tier: 'sonnet', attempts: 19, solved: 10 },
    // A retired tier still present in history must not break the mapping.
    { tier: 'haiku', attempts: 58, solved: 31 },
  ]));

  assert.deepEqual(Object.keys(result).sort(), Object.keys(models.MODELS).sort());

  assert.equal(result['claude-fable-5'].hasEnoughData, true);
  assert.equal(result['claude-fable-5'].lowPct, 51);
  assert.equal(result['claude-fable-5'].highPct, 59);
  assert.equal(result['claude-fable-5'].attempts, 401);
  assert.equal(result['claude-fable-5'].solved, 221);

  assert.equal(result['claude-opus-5'].lowPct, 43);
  assert.equal(result['claude-opus-5'].highPct, 52);
});

test('a below-threshold tier reports attempts but no band', async () => {
  stats._resetCacheForTests();
  const result = await stats.statsForModels(stubPool([
    { tier: 'sonnet', attempts: 19, solved: 10 },
  ]));
  const sonnet = result['claude-sonnet-5'];
  assert.equal(sonnet.attempts, 19);
  assert.equal(sonnet.hasEnoughData, false);
  assert.equal(sonnet.lowPct, null);
  assert.equal(sonnet.highPct, null);
  assert.ok(19 < stats.MIN_ATTEMPTS, 'fixture must sit below MIN_ATTEMPTS');
});

test('exactly MIN_ATTEMPTS is enough to show a band', async () => {
  stats._resetCacheForTests();
  const result = await stats.statsForModels(stubPool([
    { tier: 'opus', attempts: stats.MIN_ATTEMPTS, solved: 12 },
  ]));
  assert.equal(result['claude-opus-5'].hasEnoughData, true);
});

test('a tier with no rows at all still gets a zero-attempt entry', async () => {
  stats._resetCacheForTests();
  const result = await stats.statsForModels(stubPool([]));
  for (const id of Object.keys(models.MODELS)) {
    assert.equal(result[id].attempts, 0, `${id} should report 0 attempts`);
    assert.equal(result[id].hasEnoughData, false);
  }
});

test('statsForModels returns null when the query throws, and does not reject', async () => {
  stats._resetCacheForTests();
  const failing = { query: async () => { throw new Error('boom'); } };
  const result = await stats.statsForModels(failing);
  assert.equal(result, null);
});

test('staging returns the fixed demo counts flagged demo:true', async () => {
  stats._resetCacheForTests();
  const prev = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  try {
    // The pool must never be touched in staging — both session tables are
    // staging:private and therefore empty in a clone.
    const poolThatMustNotBeUsed = {
      query: async () => { throw new Error('staging must not query'); },
    };
    const result = await stats.statsForModels(poolThatMustNotBeUsed);

    assert.equal(result['claude-fable-5'].demo, true);
    assert.equal(result['claude-fable-5'].attempts, 401);
    assert.equal(result['claude-fable-5'].lowPct, 51);
    assert.equal(result['claude-fable-5'].highPct, 59);

    assert.equal(result['claude-opus-5'].attempts, 312);
    assert.equal(result['claude-opus-5'].hasEnoughData, true);

    // Sonnet stays under the threshold on purpose so ONE preview shows
    // both the band state and the "new" state.
    assert.equal(result['claude-sonnet-5'].attempts, 19);
    assert.equal(result['claude-sonnet-5'].hasEnoughData, false);
  } finally {
    if (prev === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = prev;
    stats._resetCacheForTests();
  }
});
