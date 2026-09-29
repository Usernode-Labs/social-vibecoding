'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../src/services/visual-evidence-plan');
const historical = require('../scripts/local-visual-evidence/run-historical');

test('historical replay plans preserve the recorded live claims and media types', () => {
  for (const pr of [2548, 2678, 2688]) {
    const plan = contract.parseReplayPlan(
      require(`../scripts/local-visual-evidence/historical-${pr}-plan.json`)
    );
    assert.doesNotThrow(() => historical.assertPlanMatchesRecordedClaims(plan, historical.CASES[pr]));
    const changed = structuredClone(plan);
    changed.stories[0].intent.animation = changed.stories[0].intent.animation === 'none' ? 'steps' : 'none';
    assert.throws(() => historical.assertPlanMatchesRecordedClaims(changed, historical.CASES[pr]));
    const omitted = { ...plan, stories: plan.stories.slice(1) };
    assert.throws(() => historical.assertPlanMatchesRecordedClaims(omitted, historical.CASES[pr]));
  }
});
