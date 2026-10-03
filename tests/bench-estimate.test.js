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
