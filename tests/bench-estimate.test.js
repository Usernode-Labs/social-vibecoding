'use strict';

// The benchmark launcher's preview: about how long a run takes. The lane
// holds a run's trials a few at a time, at most three heavy ones (a build, a
// spec or a checks fix) and at most eight in flight, so a run lasts at
// least as long as its heavy trials spread over the heavy slots, and as all
// of its trials spread over every slot. estimateRun itself is covered against
// the full schema in tests/bench-lane-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lane = require('../src/services/bench/lane');

const MIN = 60_000;

test('light trials spread over every slot the run is given', () => {
  const items = Array.from({ length: 8 }, () => ({ stage: 'triage', ms: MIN }));
  assert.equal(lane.estimateWallMs(items, 1), 8 * MIN);
  assert.equal(lane.estimateWallMs(items, 4), 2 * MIN);
  assert.equal(lane.estimateWallMs(items, 8), MIN);
});

test('heavy trials never get more than the three heavy slots', () => {
  const builds = Array.from({ length: 6 }, () => ({ stage: 'build', ms: 10 * MIN }));
  assert.equal(lane.estimateWallMs(builds, 8), 20 * MIN, 'six builds, three at a time');
  assert.equal(lane.estimateWallMs(builds, 2), 30 * MIN, 'and fewer when the run has fewer slots');
  const mixed = [...builds, ...Array.from({ length: 30 }, () => ({ stage: 'triage', ms: MIN }))];
  assert.equal(lane.estimateWallMs(mixed, 8), 20 * MIN, 'the triage fits beside the builds');
});

test('the run is clamped to the lane\'s own limits', () => {
  const items = Array.from({ length: 16 }, () => ({ stage: 'dm', ms: MIN }));
  assert.equal(lane.estimateWallMs(items, 50), 2 * MIN, 'never more than eight in flight');
  assert.equal(lane.estimateWallMs(items, 0), 16 * MIN, 'and never fewer than one');
  assert.equal(lane.estimateWallMs([], 4), 0);
});

test('every stage has a fallback duration for a model with no history', () => {
  for (const stage of ['triage', 'dm', 'spec', 'build', 'followup', 'checks_fix']) {
    assert.ok(lane.TRIAL_MS_FALLBACK[stage] > 0, stage);
  }
});

test('the estimate route is full-admin gated and writes nothing itself', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/homeroom-bench.js'), 'utf8');
  assert.match(src, /router\.post\('\/api\/admin\/homeroom-bot\/bench\/runs\/estimate', requireAdminWrite, handler\('Estimate bench run'/);
  assert.match(src, /lane\.estimateRun\(pool, req\.body \|\| \{\}\)/);
  const laneSrc = fs.readFileSync(path.join(__dirname, '../src/services/bench/lane.js'), 'utf8');
  const fn = laneSrc.slice(laneSrc.indexOf('async function estimateRun('), laneSrc.indexOf('async function launchRun('));
  assert.doesNotMatch(fn, /INSERT|UPDATE|DELETE|wake\(/, 'a preview never writes or wakes the lane');
});

// #3710: the launcher's "likely" figure. The token budget reads every token
// as uncached; the bot's turns are mostly cache reads, so on the first
// production runs a Flash triage cost about a fifth of it ($0.031 against
// $0.158). A model with history is priced from its own trials; one without
// is priced from the budget scaled by how far the budget overshot on the
// models that have run.
const catalog = require('../src/services/bench/catalog');

const glm = { id: 'z-ai/glm-5.3-flash', inputPerMillion: 0.1, outputPerMillion: 0.4 };
const fresh = { id: 'x/fresh', inputPerMillion: 2, outputPerMillion: 10 };

test('the token budget prices its cached share at the model\'s cache rates, and the prompt rate without them', async () => {
  // The model picker's documented split: 95% of the input cache reads, 5%
  // cache writes (model-costs.js DOCUMENTED_CACHE_SHARES).
  const modelCosts = require('../src/services/model-costs');
  const budget = catalog.TOKEN_BUDGET.first_version;
  const glm53 = { id: 'z-ai/glm-5.3-flash', inputPerMillion: 0.15, outputPerMillion: 0.5, cacheReadPerMillion: 0.03, cacheWritePerMillion: null };
  const reads = budget.input * 0.95;
  const expected = ((budget.input - reads) * 0.15 + reads * 0.03 + budget.output * 0.5) / 1e6;
  assert.ok(Math.abs(catalog.budgetTrialCost(glm53, 'first_version') - expected) < 1e-12);
  // About $0.41 a first version, where pricing every token at the prompt
  // rate read $1.44; App bench run 7's GLM 5.3 Flash builds spent about
  // $0.38 at these prices (10.69M input, 10.41M of it cached, 60.1K out).
  assert.equal(Math.round(catalog.budgetTrialCost(glm53, 'first_version') * 100) / 100, 0.41);
  assert.equal(Math.round(catalog.budgetTrialCost({ ...glm53, cacheReadPerMillion: null }, 'first_version') * 100) / 100, 1.44);
  // A model that bills writes has its 5% priced as writes.
  const sonnet = { id: 'anthropic/claude-sonnet-5.5', inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.2, cacheWritePerMillion: 2.5 };
  assert.ok(Math.abs(catalog.budgetTrialCost(sonnet, 'build')
    - modelCosts.tokenCostUsd(
      { inputPricePerMillion: 2, outputPricePerMillion: 10, cacheReadPricePerMillion: 0.2, cacheWritePricePerMillion: 2.5 },
      { inputTokens: 6_000_000, cachedInputTokens: 5_700_000, cacheWriteInputTokens: 300_000, outputTokens: 120_000 },
    )) < 1e-12);
  // The studio's per-trial estimate is this figure.
  assert.equal(catalog.estimateTrialCost(glm53, 'first_version', []), catalog.budgetTrialCost(glm53, 'first_version'));

  // The prices come from the stored OpenRouter catalog, cache prices included.
  const pool = {
    async query() {
      return { rows: [{ models: [{
        id: 'z-ai/glm-5.3-flash', context_length: 1048576,
        pricing: { prompt: '0.00000015', completion: '0.0000005', input_cache_read: '0.00000003' },
      }, {
        id: 'anthropic/claude-sonnet-5.5', context_length: 1000000,
        pricing: { prompt: '0.000002', completion: '0.00001', input_cache_read: '0.0000002', input_cache_write: '0.0000025' },
      }] }] };
    },
  };
  const listed = await catalog.listModels(pool, []);
  const near = (a, b) => a != null && Math.abs(a - b) < 1e-9;
  const g = catalog.modelInfo(listed, 'z-ai/glm-5.3-flash');
  assert.ok(near(g.cacheReadPerMillion, 0.03), String(g.cacheReadPerMillion));
  assert.equal(g.cacheWritePerMillion, null, 'a price the catalog does not list is null, never a false zero');
  const s = catalog.modelInfo(listed, 'anthropic/claude-sonnet-5.5');
  assert.ok(near(s.cacheReadPerMillion, 0.2) && near(s.cacheWritePerMillion, 2.5));
  assert.equal(catalog.modelInfo(listed, 'x/unlisted').cacheReadPerMillion, null);
});

test('the calibration is the median ratio of real trials to the budget, per stage', () => {
  const history = new Map([
    ['z-ai/glm-5.3-flash|triage', [0.02, 0.03, 0.04]],
    ['z-ai/glm-5.3-flash|build', [0.2, 0.3]],
  ]);
  const cal = catalog.costCalibration([glm, fresh], history);
  const budget = catalog.budgetTrialCost(glm, 'triage');
  assert.ok(Math.abs(budget - 0.158) < 1e-9);
  assert.ok(Math.abs(cal.byStage.triage.ratio - 0.03 / 0.158) < 1e-9);
  assert.equal(cal.byStage.triage.from, 1);
  assert.equal(cal.byStage.build, undefined, 'two trials are too few to learn from');
  assert.equal(cal.any.from, 1);
  assert.deepEqual(catalog.costCalibration([fresh], new Map()), { byStage: {}, any: null });
});

test('a likely trial cost: its own median, else the calibrated budget, else the pessimistic figure', () => {
  const history = new Map([['z-ai/glm-5.3-flash|triage', [0.02, 0.03, 0.04, 0.5]]]);
  const cal = catalog.costCalibration([glm], history);
  assert.equal(catalog.likelyTrialCost(glm, 'triage', history.get('z-ai/glm-5.3-flash|triage'), cal), 0.035, 'the median, not the p90');
  assert.equal(catalog.estimateTrialCost(glm, 'triage', history.get('z-ai/glm-5.3-flash|triage')), 0.5, 'the cap still schedules on the pessimistic one');
  const ratio = cal.byStage.triage.ratio;
  assert.ok(Math.abs(catalog.likelyTrialCost(fresh, 'triage', [], cal) - catalog.budgetTrialCost(fresh, 'triage') * ratio) < 1e-9);
  assert.ok(Math.abs(catalog.likelyTrialCost(fresh, 'build', [], cal) - catalog.budgetTrialCost(fresh, 'build') * cal.any.ratio) < 1e-9,
    'a stage nothing has run at uses every stage\'s ratio');
  assert.equal(catalog.likelyTrialCost(fresh, 'triage', [], null), catalog.estimateTrialCost(fresh, 'triage', []), 'no calibration: the guess itself');
  assert.equal(catalog.likelyTrialCost({ id: 'x/noprice' }, 'triage', [], cal), catalog.FALLBACK_USD.triage);
});

test('the suggested cap leaves room for the trials in flight, and never asks for more than the worst case needs', () => {
  const items = [
    ...Array.from({ length: 5 }, () => ({ stage: 'build', est: 10 })),
    ...Array.from({ length: 20 }, () => ({ stage: 'triage', est: 1 })),
  ];
  assert.equal(lane.capHeadroom(items, 8), 3 * 10 + 5 * 1, 'three heavy slots, five light');
  assert.equal(lane.capHeadroom(items, 2), 20, 'two slots');
  assert.equal(lane.capHeadroom([{ stage: 'build', est: 10 }], 8), 10);
  assert.equal(lane.suggestCap({ likelyUsd: 100, pessimisticUsd: 400, headroomUsd: 5 }), 115, 'the likely cost plus 15%');
  assert.equal(lane.suggestCap({ likelyUsd: 100, pessimisticUsd: 400, headroomUsd: 35 }), 135, 'or the room the slots need');
  assert.equal(lane.suggestCap({ likelyUsd: 100, pessimisticUsd: 90, headroomUsd: 35 }), 125, 'never more than the worst case plus that room');
  assert.equal(lane.suggestCap({ likelyUsd: 0, pessimisticUsd: 0, headroomUsd: 0 }), 1);
  assert.equal(lane.suggestCap({ likelyUsd: 5000, pessimisticUsd: 9000, headroomUsd: 50 }), 1000, 'inside the lane\'s range');
});

// The launcher's range (catalog.costRange): the closest trials that exist,
// and what they are, never one confident figure with nothing behind it. The
// single "likely" figure priced four first versions at $0.05 with no first
// version run yet, from triage's calibration, while a build cost a dollar or
// two (#3737's first taste runs).
test('a cost range rests on the closest trials there are, and says which', () => {
  const history = new Map([
    ['z-ai/glm-5.3-flash|triage', [0.003, 0.004, 0.005, 0.006]],
    ['z-ai/glm-5.3-flash|build', [1.0, 1.4, 2.5]],
    ['x/fresh|build', [9]],
  ]);
  const cal = catalog.costCalibration([glm, fresh], history);
  const range = (m, st, h = history, c = cal) => catalog.costRange(m, st, h, c);

  const own = range(glm, 'triage');
  assert.deepEqual({ ...own, low: Math.round(own.low * 1e6) / 1e6 }, { low: 0.0045, high: 0.006, basis: 'own', from: 'triage' }, 'its own trials: the median to the dearest tenth');
  assert.equal(range(glm, 'triage').high, catalog.estimateTrialCost(glm, 'triage', history.get('z-ai/glm-5.3-flash|triage')),
    'the top is the figure the cap is scheduled against');

  // The bug: a first version nobody has run.
  const fv = range(glm, 'first_version');
  assert.deepEqual(fv, { low: 1.4, high: 2.5, basis: 'comparable', from: 'build' }, 'a first version is priced from its builds');
  assert.ok(4 * fv.low >= 4 && 4 * fv.high <= 10, 'four first versions: about $4 to $10, not $0.05');

  // One build of another model's says what a build cost, not what this one's will: the range takes in this model's price.
  const thin = range(fresh, 'first_version', new Map([['z-ai/glm-5.3-flash|build', [1.2]]]), null);
  assert.equal(thin.basis, 'comparable');
  assert.equal(thin.low, 1.2);
  assert.equal(thin.high, catalog.budgetTrialCost(fresh, 'first_version'), 'up to its own price-based guess');
  assert.ok(thin.high > thin.low, 'a range, not a figure');

  // Its own few trials at the stage come before a stage like it.
  assert.deepEqual(range(fresh, 'build'), { low: 9, high: catalog.budgetTrialCost(fresh, 'build'), basis: 'own', from: 'build' },
    'its one build, up to its own price-based guess');

  // Other models' trials at the stage, from enough of them: the calibrated price, as before.
  const qwen = { id: 'qwen/qwen3.8-flash', inputPerMillion: 0.15, outputPerMillion: 0.47 };
  const triage = range(qwen, 'triage');
  assert.equal(triage.basis, 'stage');
  assert.ok(Math.abs(triage.low - catalog.likelyTrialCost(qwen, 'triage', [], cal)) < 1e-12);
  assert.equal(triage.high, catalog.estimateTrialCost(qwen, 'triage', []));

  // Nothing like it: a guess from the price, or with no price the fixed guess, and said so.
  assert.equal(range(glm, 'spec').basis, 'price');
  assert.deepEqual(range({ id: 'x/noprice' }, 'spec', new Map(), null), { low: catalog.FALLBACK_USD.spec, high: catalog.FALLBACK_USD.spec, basis: 'fixed', from: null });
  assert.deepEqual(range(glm, 'capture'), { low: 0, high: 0, basis: 'none', from: null }, 'a capture runs no model');
  assert.deepEqual(catalog.COMPARABLE_STAGE, { first_version: 'build', checks_fix: 'followup', followup: 'checks_fix' });
});
