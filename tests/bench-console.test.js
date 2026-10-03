'use strict';

// #3710: the Benchmark tab laid out around running everything and reading
// the answer. The pure parts of the console module, and the cards' first
// render (tests/lib/render-tsx.js runs no effects, so the estimate and the
// reports a browser would fetch are not here; they are covered against the
// full schema in tests/bench-lane-postgres.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');

function loadBench() {
  globalThis.window = globalThis.window || globalThis;
  const { loadTsx } = require('./lib/render-tsx');
  return loadTsx('frontend/src/features/admin/admin-homeroom-bench.tsx', {
    stubs: {
      './admin-console.js': {
        AdminUI: new Proxy({}, { get: (_t, key) => (['btn', 'badge'].includes(key) ? new Proxy({}, { get: (_u, k) => `${key}-${String(k)}` }) : String(key)) }),
      },
    },
  });
}

const row = (stage, model, extra) => ({
  stage, model, baseline: false, trials: 10, graded: 10, pass: 5, pending: 0, unlabelled: 0, notApplicable: 0, skippedCap: 0,
  accuracy: 0.5, passK: { k: 1, tasks: 10, value: 0.5 }, costUsd: 1, costPerTask: 0.1, costPerAttempt: 0.1, costPerSuccess: 0.2,
  p50Ms: 1000, p95Ms: 2000, timeoutRate: 0, infraRate: 0, ...extra,
});

test('a run counts what ran apart from what the cap skipped or a cancel stopped', () => {
  const { runCounts } = loadBench();
  // Production's run 5: 81 ok, 1 model fail, 50 skipped at a $3 cap. It used to read "132 of 132 trials".
  assert.deepEqual(runCounts({ counts: { ok: 81, model_fail: 1, skipped_cap: 50 } }),
    { ran: 82, planned: 132, running: 0, skipped: 50, cancelled: 0, notApplicable: 0 });
  assert.deepEqual(runCounts({ counts: { ok: 2, pending: 5, running: 1, not_applicable: 9, cancelled: 3, infra_fail: 1, timeout: 1 } }),
    { ran: 4, planned: 13, running: 1, skipped: 0, cancelled: 3, notApplicable: 9 }, 'not applicable is never planned work');
  assert.deepEqual(runCounts({ counts: {} }), { ran: 0, planned: 0, running: 0, skipped: 0, cancelled: 0, notApplicable: 0 });
});

test('about how long reads in minutes, then hours', () => {
  const { duration } = loadBench();
  assert.equal(duration(20_000), 'under a minute');
  assert.equal(duration(40 * 60_000), '40 min');
  assert.equal(duration(3 * 3_600_000 + 20 * 60_000), '3.5 h');
  assert.equal(duration(12.4 * 3_600_000), '12 h');
  assert.equal(duration(null), 'not yet');
});

test('the best model per stage: the latest graded cell wins, thin cells are shown but not compared', () => {
  const { mergeBest } = loadBench();
  const newest = { runId: 6, report: { rows: [
    row('triage', 'a/glm', { graded: 28, accuracy: 0.75, costPerSuccess: 0.041 }),
    row('triage', 'b/deep', { graded: 27, accuracy: 0.74, costPerSuccess: 0.057 }),
    row('triage', 'c/luna', { graded: 27, accuracy: 0.52, costPerSuccess: 0.042 }),
    row('build', 'a/glm', { graded: 2, accuracy: 0, costPerSuccess: null }),
    row('build', 'b/deep', { graded: 0, pending: 0 }),
  ] } };
  const older = { runId: 4, report: { rows: [
    row('triage', 'a/glm', { graded: 40, accuracy: 0.1 }),
    row('build', 'b/deep', { graded: 2, accuracy: 0.5, costPerSuccess: 5.39 }),
    row('dm', 'c/luna', { graded: 0, pending: 3 }),
  ] } };
  const best = mergeBest([newest, older], { triage: 44, build: 18, dm: 5 }, 'a/glm');
  assert.deepEqual(best.stages, ['triage', 'build', 'dm']);
  assert.deepEqual(best.models, ['a/glm', 'b/deep', 'c/luna'], 'the baseline first');
  assert.equal(best.cells['triage|a/glm'].runId, 6, 'the newest run wins');
  assert.equal(best.cells['triage|a/glm'].accuracy, 0.75);
  assert.equal(best.cells['build|b/deep'].runId, 4, 'a newer run with nothing graded does not hide an older result');
  assert.equal(best.cells['dm|c/luna'].pending, 3, 'a cell waiting for the judge is shown');
  assert.deepEqual(best.enough, { triage: 10, build: 10, dm: 4 });
  // Within five points of the most accurate, the cheapest success.
  assert.equal(best.best.triage, 'triage|a/glm');
  assert.equal(best.best.build, undefined, 'two graded builds are too few to compare');
  assert.equal(best.best.dm, undefined);

  const cheaper = mergeBest([{ runId: 1, report: { rows: [
    row('triage', 'a/glm', { graded: 30, accuracy: 0.8, costPerSuccess: 0.5 }),
    row('triage', 'b/deep', { graded: 30, accuracy: 0.77, costPerSuccess: 0.1 }),
    row('triage', 'c/luna', { graded: 30, accuracy: 0.6, costPerSuccess: 0.01 }),
  ] } }], { triage: 44 });
  assert.equal(cheaper.best.triage, 'triage|b/deep', 'three points behind and five times cheaper wins; twenty behind does not');
});

test('the matrix offers "Use for <stage>" only on a compared cell, and only with somewhere to send it', () => {
  const { mergeBest, BestModels, BOT_STAGE_FOR } = loadBench();
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  assert.deepEqual(BOT_STAGE_FOR, { triage: 'triage', spec: 'spec', build: 'build', followup: 'followup', checks_fix: 'followup' },
    'a checks fix runs on the follow-up model; DM has no model of its own');
  const best = mergeBest([{ runId: 3, report: { rows: [
    row('triage', 'a/glm', { graded: 28, accuracy: 0.75, costPerSuccess: 0.041 }),
    row('build', 'a/glm', { graded: 2, accuracy: 0 }),
    row('checks_fix', 'a/glm', { graded: 2, accuracy: 1, costPerSuccess: 0.27 }),
    row('dm', 'a/glm', { graded: 4, accuracy: 0.25, costPerSuccess: 0.04 }),
  ] } }], { triage: 44, build: 18, checks_fix: 2, dm: 5 }, 'a/glm');
  const models = [{ id: 'a/glm', label: 'GLM' }];
  const html = renderToHtml(createElement(BestModels, { best, models, suiteName: 'Core v1', canUse: true, onUseModel() {} }));
  assert.match(html, /id="admin-homeroom-bench-best-list"/);
  assert.match(html, /Best value: GLM, 75% at \$0\.041 a success/, 'the stage says its answer in words');
  assert.match(html, /data-bench-best-cell="triage\|a\/glm" data-best="true" data-thin="false"/);
  assert.match(html, /data-bench-use="triage\|a\/glm"[^>]*>Use for Triage</);
  assert.match(html, /data-bench-best-cell="build\|a\/glm" data-best="false" data-thin="true"/);
  assert.doesNotMatch(html, /data-bench-use="build\|a\/glm"/, 'too few to compare: nothing to use');
  assert.match(html, /too few to compare/);
  assert.match(html, /data-bench-use="checks_fix\|a\/glm"[^>]*>Use for Follow-up</, 'both of Core\'s checks fixes graded is enough');
  assert.doesNotMatch(html, /data-bench-use="dm\|/, 'DM answers run on the platform default');
  assert.doesNotMatch(renderToHtml(createElement(BestModels, { best, models, suiteName: '', canUse: false })), /data-bench-use=/,
    'a view-only admin reads it');
  assert.match(renderToHtml(createElement(BestModels, { best: null, models, suiteName: '', canUse: true })), /class="loading">Loading…/);
  assert.match(renderToHtml(createElement(BestModels, { best: mergeBest([], {}), models, suiteName: '', canUse: true })),
    /id="admin-homeroom-bench-best-empty"/);
});

test('the launcher opens on everything, with the price spelled out before Launch', () => {
  const { Launcher } = loadBench();
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const launcher = { suiteId: 5, models: ['a/glm', 'b/deep'], stages: ['triage', 'dm'], repeats: 3, repeatStages: ['triage'], capUsd: 50 };
  const html = renderToHtml(createElement(Launcher, {
    suites: [{ id: 5, name: 'Core', version: 1, kind: 'frozen', frozen_at: '2026-10-01', counts: { triage: 44, build: 18, dm: 5, checks_fix: 2, spec: 0 }, total: 69, labelled: 69 }],
    models: [{ id: 'a/glm', label: 'GLM' }, { id: 'b/deep', label: 'DeepSeek' }],
    defaults: { capUsd: 50, repeats: 3, maxConcurrency: 8 }, launcher, hiddenChecks: 'x', onLaunched() {}, say() {},
  }));
  assert.match(html, /id="admin-homeroom-bench-launch-summary"[^>]*>Core v1 · 2 models · Triage ×3 · Build · Checks fix · DM</,
    'every stage the suite has tasks at, not just the cheap ones');
  for (const id of ['trials', 'cost', 'time', 'cap']) assert.match(html, new RegExp(`id="admin-homeroom-bench-estimate-${id}"`));
  assert.match(html, /Working out the estimate…/);
  assert.match(html, /id="admin-homeroom-bench-launch-go"[^>]*>Run everything, up to \$50\.00</);
  assert.match(html, /<option value="8" selected="">8<\/option>/, 'as many at once as the lane allows');
  assert.match(html, /<details class="mt-4" id="admin-homeroom-bench-launch-settings">/, 'the rest of the choices are folded away');
});

test('chart labels that would sit on each other move down a line', () => {
  const { placeLabels } = loadBench();
  const y = placeLabels([
    { key: 'a', x: 100, y: 50, text: 'GLM 5.3 Flash' },
    { key: 'b', x: 105, y: 50, text: 'DeepSeek V4.1 Flash' },
    { key: 'c', x: 300, y: 50, text: 'Luna' },
  ], 200);
  assert.equal(y.a, 54);
  assert.equal(y.b, 67, 'the second name moves below the first');
  assert.equal(y.c, 54, 'a name clear of the others stays beside its point');
  assert.equal(placeLabels([{ key: 'z', x: 0, y: 199, text: 'x' }], 200).z, 200, 'never below the plot');
});

test('the judge line holds when a rate has no trials behind it', () => {
  const { judgeLine } = loadBench();
  assert.equal(judgeLine({ n: 1, agreement: 1, tpr: 1, tnr: null }),
    'Agrees with people on 100% of the 1 trial a person also graded. Of those a person passed, it passed 100%. A person has failed none of them yet.');
  assert.doesNotMatch(judgeLine({ n: 6, agreement: 0.5, tpr: null, tnr: 0 }), /not yet/);
});
