'use strict';

// #3710: the Benchmark tab laid out around running everything and reading
// the answer; laid out again as four places with addresses of their own
// (Overview, Runs, one run, Suites) and a New run sheet. The pure parts of
// the console module, and the places' first render (tests/lib/render-tsx.js
// runs no effects, so the estimate and the reports a browser would fetch are
// not here; they are covered against the full schema in
// tests/bench-lane-postgres.test.js and tests/bench-demo-postgres.test.js).

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

test('the New run sheet opens on everything, in four steps, with the price spelled out before Launch', () => {
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
  assert.match(html, /<details class="mt-3" id="admin-homeroom-bench-launch-settings">/, 'the rarer choices are folded away');
  const steps = [...html.matchAll(/<legend[^>]*>(\d\. \w+)<\/legend>/g)].map((m) => m[1]);
  assert.deepEqual(steps, ['1. Suite', '2. Stages', '3. Models', '4. Limits'], 'numbered steps, suite first');
  assert.ok(html.indexOf('id="admin-homeroom-bench-estimate"') > html.indexOf('4. Limits'), 'the summary beside the steps, with Launch at its foot');

  // Opened from "Run more" on a stage: that stage only.
  const more = renderToHtml(createElement(Launcher, {
    suites: [{ id: 5, name: 'Core', version: 1, kind: 'frozen', frozen_at: '2026-10-01', counts: { triage: 44, build: 18, dm: 5 }, total: 67, labelled: 67 }],
    models: [{ id: 'a/glm', label: 'GLM' }], defaults: { capUsd: 50, repeats: 3, maxConcurrency: 8 }, launcher,
    hiddenChecks: 'x', preset: { suiteId: 5, stages: ['build'] }, onLaunched() {}, say() {},
  }));
  assert.match(more, /id="admin-homeroom-bench-launch-summary"[^>]*>Core v1 · 2 models · Build</);
  assert.match(more, /id="admin-homeroom-bench-launch-go"[^>]*>Launch, up to \$50\.00</, 'not everything, so it says Launch');
});

// The estimate is a range with what it rests on: four first versions on a
// stage nothing has run at read $0.05 when a build costs a dollar or two.
test('the estimate is a range, says what each stage rests on, and is never a confident figure with nothing behind it', () => {
  const { estimateRange, rangeWords, estimateNote, estimateGuessed } = loadBench();
  assert.deepEqual(estimateRange({ likelyUsd: 0.05, estimateUsd: 3.87, lowUsd: 5.6, highUsd: 10 }), { low: 5.6, high: 10 });
  assert.deepEqual(estimateRange({ likelyUsd: 1, estimateUsd: 2 }), { low: 1, high: 2 }, 'an older server: the single figure and the most');
  assert.equal(rangeWords(5.6, 10), '$5.60 to $10');
  assert.equal(rangeWords(0.42, 0.42), '$0.42');
  assert.equal(rangeWords(63, 63, true), 'about $63', 'a guess is never a bare figure');
  assert.equal(rangeWords(0, 0), '$0');
  const byStage = {
    triage: { trials: 18, notApplicable: 0, estimateUsd: 1, likelyUsd: 1, basis: 'own', from: 'triage' },
    first_version: { trials: 4, notApplicable: 0, estimateUsd: 3.87, likelyUsd: 0.05, basis: 'comparable', from: 'build' },
    spec: { trials: 2, notApplicable: 0, estimateUsd: 1, likelyUsd: 1, basis: 'price', from: null },
    capture: { trials: 4, notApplicable: 0, estimateUsd: 0, likelyUsd: 0, basis: 'none', from: null },
  };
  const note = estimateNote({ byStage });
  assert.match(note, /Triage: from what each model's own trials have cost so far\./);
  assert.match(note, /First version: none has run yet, so this range comes from Build trials\./);
  assert.match(note, /Plan: nothing like it has run yet, so this is a guess from each model's price\./);
  assert.match(note, /Capture \(before\): runs no model, so it costs nothing\./);
  assert.equal(estimateGuessed({ byStage }), true);
  assert.equal(estimateGuessed({ byStage: { triage: byStage.triage, first_version: byStage.first_version } }), false,
    'a range from a stage like it is not a guess from the price');
  assert.match(estimateNote({ byStage: { dm: { trials: 3, basis: 'fixed' } } }), /DM: nothing like it has run and no price is known, so this is a fixed guess per trial\./);
});

test('each place has an address of its own below the tab\'s, and anything else is the Overview', () => {
  const { benchRouteFromHash, benchHash } = loadBench();
  const cases = [
    ['#admin/homeroom-bot/benchmark', { view: 'overview' }],
    ['#admin/homeroom-bot/benchmark/runs', { view: 'runs' }],
    ['#admin/homeroom-bot/benchmark/runs/936551', { view: 'run', id: 936551 }],
    ['#admin/homeroom-bot/benchmark/suites', { view: 'suites', id: null }],
    ['#admin/homeroom-bot/benchmark/suites/936542', { view: 'suites', id: 936542 }],
  ];
  for (const [hash, route] of cases) {
    assert.deepEqual(benchRouteFromHash(hash), route, hash);
    assert.equal(benchHash(route), hash, 'and back');
  }
  assert.deepEqual(benchRouteFromHash('#admin/homeroom-bot/benchmark/'), { view: 'overview' });
  assert.deepEqual(benchRouteFromHash('#admin/homeroom-bot/benchmark/runs/abc'), { view: 'overview' });
  assert.deepEqual(benchRouteFromHash('#admin/homeroom-bot/settings'), { view: 'overview' });
  assert.deepEqual(benchRouteFromHash(''), { view: 'overview' });
});

test('a run says its state in plain words, what ran of it, and a cap that left most of it unrun', () => {
  const { runState, trialWords, cappedShort, cappedWarning } = loadBench();
  assert.equal(runState('capped').label, 'Stopped at cap');
  assert.equal(runState('running').label, 'Running');
  assert.equal(runState('done').label, 'Done');
  assert.equal(runState('cancelled').label, 'Cancelled');
  assert.equal(trialWords({ counts: { ok: 81, model_fail: 1, skipped_cap: 50 } }), '82 of 132 · 50 skipped at the cap');
  assert.equal(trialWords({ counts: { ok: 6, infra_fail: 1, skipped_cap: 47 } }), '7 of 54 · 47 skipped at the cap · 1 platform fault');
  assert.equal(trialWords({ counts: { cancelled: 396 } }), '0 of 396 · all cancelled');
  assert.equal(trialWords({ counts: { pending: 6, running: 2 } }), '0 of 8 · 2 running');
  const run = (id, status, counts) => ({ id, status, counts, suite_name: 'Core', suite_version: 1 });
  // Production's runs 4 and 5: a $8 cap after 7 of 54 builds, a $3 cap after 82 of 132 triage trials.
  const list = cappedShort([run(5, 'capped', { ok: 81, model_fail: 1, skipped_cap: 50 }), run(4, 'capped', { ok: 6, infra_fail: 1, skipped_cap: 47 }), run(3, 'done', { ok: 21 })]);
  assert.deepEqual(list.map((x) => x.id), [4], 'most unrun: run 4 only');
  assert.equal(cappedWarning(list), 'Run 4 stopped at its cap after 13% of its trials, so its scores cover only part of Core v1. Raise the cap or narrow the models before trusting them.');
  assert.equal(cappedWarning([]), '');
  assert.match(cappedWarning([{ id: 4, share: 0.13, suite: 'Core v1' }, { id: 7, share: 0.2, suite: 'Core v1' }]),
    /^Runs 4 and 7 stopped at their caps after 13% and 20% of their trials, so their scores cover only part of Core v1\./);
});

test('the Overview\'s table: the model in use, the recommendation, why, and Use for, or too few to call', () => {
  const { mergeBest, StageTable, inUseFor } = loadBench();
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const best = mergeBest([{ runId: 3, report: { rows: [
    row('triage', 'a/glm', { graded: 16, accuracy: 0.8, costPerSuccess: 0.018 }),
    row('triage', 'b/qwen', { graded: 16, accuracy: 0.88, costPerSuccess: 0.024 }),
    row('build', 'a/glm', { graded: 2, accuracy: 0, costPerSuccess: null }),
    row('dm', 'a/glm', { graded: 3, accuracy: 1, costPerSuccess: 0.028 }),
    row('checks_fix', 'a/glm', { graded: 0, pending: 2 }),
  ] } }], { triage: 44, build: 18, dm: 3, checks_fix: 2 }, 'a/glm');
  const models = [{ id: 'a/glm', label: 'GLM' }, { id: 'b/qwen', label: 'Qwen' }];
  const inUse = { triage: 'a/glm', spec: 'a/glm', build: 'a/glm', followup: 'a/glm' };
  assert.equal(inUseFor('checks_fix', inUse, 'x/default'), 'a/glm', 'a checks fix runs on the follow-up model');
  assert.equal(inUseFor('dm', inUse, 'x/default'), 'x/default', 'DM answers run on the platform default');
  assert.equal(inUseFor('triage', null, 'x/default'), null);
  const html = renderToHtml(createElement(StageTable, {
    best, models, suiteLabel: 'Core v1', inUse, defaultModel: 'a/glm', canUse: true, onUseModel() {}, onRunMore() {},
    capNotes: { build: 'Run 4 stopped at its cap after 7 of 54 trials.' },
  }));
  assert.match(html, /id="admin-homeroom-bench-best-table"/);
  assert.deepEqual([...html.matchAll(/<th class="[^"]*" scope="col">([^<]*)</g)].map((m) => m[1]), ['Stage', 'In use now', 'Recommended', 'Why', 'Graded', '']);
  assert.match(html, /data-bench-stage-row="triage" data-bench-best-pick="b\/qwen"/);
  assert.match(html, /data-bench-in-use="triage">GLM</);
  assert.match(html, /88% right at \$0\.024 a success; GLM 80% at \$0\.018/, 'the pick beside the model in use');
  assert.match(html, /data-bench-use="triage\|b\/qwen"[^>]*>Use for Triage</);
  assert.match(html, /data-bench-stage-row="build" data-bench-best-pick="">.*?Too few to call.*?2 graded per model at most; a call needs 10\. Run 4 stopped at its cap after 7 of 54 trials\./);
  assert.match(html, /data-bench-run-more="build"[^>]*>Run more</);
  assert.doesNotMatch(html, /data-bench-use="build/, 'nothing to use below the threshold');
  assert.match(html, /data-bench-stage-row="dm" data-bench-best-pick="a\/glm">.*?Keep: in use now/, 'the model in use is kept');
  assert.doesNotMatch(html, /data-bench-use="dm/, 'DM answers run on the platform default: nothing to set');
  assert.match(html, /data-bench-stage-row="checks_fix" data-bench-best-pick="">.*?No graded trials yet.*?2 wait for the judge\./);
  assert.match(html, /<details class="mt-3" id="admin-homeroom-bench-best-all">.*?Every model, stage by stage.*?id="admin-homeroom-bench-best-list"/, 'every model\'s cells, folded');
  const readOnly = renderToHtml(createElement(StageTable, { best, models, suiteLabel: '', inUse: null, defaultModel: null, canUse: false }));
  assert.doesNotMatch(readOnly, /data-bench-use=|data-bench-run-more=/, 'a view-only admin reads it');
  assert.doesNotMatch(readOnly, /In use now/, 'no Settings data: no column');
  assert.match(renderToHtml(createElement(StageTable, { best: mergeBest([], {}), models, suiteLabel: '', inUse: null, defaultModel: null, canUse: true })),
    /id="admin-homeroom-bench-best-empty"/);
});

test('the taste card reads each arm\'s latest graded score, and says when nothing is graded yet', () => {
  const { tasteArms, tasteScore } = loadBench();
  const criteria = (held, n = 4) => Object.fromEntries(['hierarchy', 'type_scale', 'spacing', 'would_ship'].map((id, i) => [id, { rate: i < held ? 1 : 0, n }]));
  const cell = (c) => ({ trials: 4, criteria: c, bootedRate: 1, checks: {}, tells: {} });
  assert.deepEqual(tasteScore(cell(criteria(3))), { held: 3, of: 4, graded: 4 });
  assert.equal(tasteScore(cell({})), null, 'nothing graded');
  const arms = tasteArms([
    { runId: 7, report: { rows: [
      row('first_version', 'a/glm', { trials: 4, taste: cell({}) }),
      row('capture', 'a/glm', { trials: 4, taste: cell({}) }),
    ] } },
    { runId: 6, report: { rows: [row('first_version', 'a/glm', { trials: 4, taste: cell(criteria(2)) })] } },
  ]);
  assert.deepEqual(arms.map((a) => [a.key, a.runId, a.scoredIn, a.score && a.score.held]), [
    ['capture', 7, null, null],
    ['first_version|a/glm', 7, 6, 2],
  ], 'captures first; the latest graded score, from an older run when the newest is not graded yet');
});

test('the places\' first render: the shared header, and the Overview\'s hosts', () => {
  const { BenchmarkArea } = loadBench();
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const html = renderToHtml(createElement(BenchmarkArea, { canWrite: true }));
  assert.match(html, /id="admin-homeroom-bench" data-bench-view="overview"/);
  for (const id of ['header', 'tabs', 'tab-overview', 'tab-runs', 'tab-suites', 'overview', 'best', 'how', 'intro']) {
    assert.match(html, new RegExp(`id="admin-homeroom-bench-${id}"`), id);
  }
  assert.match(html, /href="#admin\/homeroom-bot\/benchmark\/runs" id="admin-homeroom-bench-tab-runs"/, 'a place is a real link');
  assert.match(html, /id="admin-homeroom-bench-tab-overview" class="[^"]*" aria-current="page"/);
  assert.doesNotMatch(html, /id="admin-homeroom-bench-new-run"/, 'New run waits for the suites');
  assert.doesNotMatch(html, /id="admin-homeroom-bench-launch"/, 'and nothing is launched or even offered on load');
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

// #3737: the taste eval in the console.
test('a taste suite says its first versions and captures, its tasks show their brief, and a run shows its arms side by side', () => {
  const { isTasteSuite, stageLabel, TasteTable, TasteTaskForm, TasteShots, SuitesPage, SuiteDetail, AddTaskMenu, TasteSideBySide, Launcher, TASTE_CRITERIA } = loadBench();
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  assert.equal(isTasteSuite({ counts: { first_version: 4 } }), true);
  assert.equal(isTasteSuite({ counts: { triage: 40 } }), false);
  assert.equal(stageLabel('capture'), 'Capture (before)');
  assert.equal(stageLabel('taste'), 'Taste', 'a grade item never says which arm');
  assert.deepEqual(TASTE_CRITERIA.map((c) => c.id), require('../src/services/bench/grading').RUBRICS.taste.criteria.map((c) => c.id),
    'the console names the rubric\'s own criteria');

  const suite = { id: 9, name: 'Taste v1', version: 1, kind: 'frozen', frozen_at: null, counts: { first_version: 4, capture: 2 }, total: 6, labelled: 6, deletable: false };
  const props = { core: null, coreSuiteId: null, go() {}, onChanged() {}, say() {}, onMaterialize() {}, onFreezeCore() {} };
  const suitesHtml = renderToHtml(createElement(SuitesPage, { ...props, canWrite: true, suites: [suite], selectedId: 9 }));
  assert.match(suitesHtml, /data-bench-suite="9" data-bench-suite-taste="9"><a href="#admin\/homeroom-bot\/benchmark\/suites\/9"/, 'each suite links to its own address');
  assert.match(suitesHtml, /data-bench-suite-detail="9"/, 'the address\'s suite is open');
  assert.match(suitesHtml, /First versions 4 · Captures 2/);
  const detail = renderToHtml(createElement(SuiteDetail, { ...props, suite, isCore: false, canWrite: true }));
  assert.match(detail, /data-bench-suite-freeze="9"[^>]*>Freeze</);
  assert.match(detail, /data-bench-suite-version="9"[^>]*>New version</);
  assert.match(detail, /id="admin-homeroom-bench-add-task" aria-haspopup="menu" aria-expanded="false">Add task</, 'one Add task menu');
  assert.doesNotMatch(detail, /id="admin-homeroom-bench-sampler"|id="admin-homeroom-bench-import"|id="admin-homeroom-bench-taste-form"/,
    'the three forms wait behind the menu');
  assert.doesNotMatch(renderToHtml(createElement(SuiteDetail, { ...props, suite: { ...suite, frozen_at: '2026-10-02' }, isCore: false, canWrite: true })),
    /admin-homeroom-bench-add-task|data-bench-suite-freeze/, 'a frozen suite takes no task and no second freeze');
  assert.doesNotMatch(renderToHtml(createElement(SuiteDetail, { ...props, suite, isCore: false, canWrite: false })),
    /admin-homeroom-bench-add-task|data-bench-suite-version/, 'a view-only admin reads');
  // The menu lists the four ways, in this order, when it is open.
  assert.match(renderToHtml(createElement(AddTaskMenu, { onPick() {} })), /aria-expanded="false"/);
  const menuSrc = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'frontend/src/features/admin/admin-homeroom-bench.tsx'), 'utf8');
  assert.deepEqual([...menuSrc.matchAll(/\{ key: '(\w+)', label: '([^']+)'/g)].map((m) => m[2]),
    ['Sample from past runs', 'Import a merged PR', 'First version from a brief', 'Capture an app at a commit']);

  const form = renderToHtml(createElement(TasteTaskForm, { suiteId: 9, act: async () => {} }));
  assert.match(form, /id="admin-homeroom-bench-taste-form"/);
  assert.match(form, /<option value="first_version" selected="">First version from a brief<\/option>/);
  assert.match(form, /Capture an app at a commit \(before\)/);
  assert.match(form, /id="admin-homeroom-bench-taste-brief"/);
  const capture = renderToHtml(createElement(TasteTaskForm, { suiteId: 9, act: async () => {}, kind: 'capture' }));
  assert.doesNotMatch(capture, /admin-homeroom-bench-taste-kind/, 'opened from the menu, the kind is already picked');
  assert.match(capture, /id="admin-homeroom-bench-taste-sha"/);

  const launcher = renderToHtml(createElement(Launcher, {
    suites: [suite], models: [{ id: 'a/glm', label: 'GLM' }],
    defaults: { capUsd: 50, repeats: 3, maxConcurrency: 8 },
    launcher: { suiteId: 9, models: ['a/glm'], stages: ['first_version', 'capture'], repeats: 3, repeatStages: ['triage'], capUsd: 50 },
    hiddenChecks: 'x', onLaunched() {}, say() {},
  }));
  assert.match(launcher, /Taste v1 v1 \(not frozen\) · 1 model · First version ×3 · Capture \(before\)/, 'first versions are repeated');
  assert.match(launcher, />Repeats</);

  const cell = (rate) => ({
    trials: 4, criteria: { would_ship: { rate, n: 4 }, hierarchy: { rate: 1, n: 4 } }, bootedRate: 1,
    checks: { consoleErrors: 0.5, overflowAt360px: 0, tapTargetsUnder44px: 2, lowContrastLight: 1, lowContrastDark: 3.25, cardsNestedInCards: 0 },
    tells: { emojiIcons: 7, uppercaseEyebrows: 1, arbitraryTextSizes: 0, hexColours: 4 },
  });
  const table = renderToHtml(createElement(TasteTable, {
    rows: [{ stage: 'first_version', model: 'a/glm', taste: cell(0.75) }, { stage: 'capture', model: 'a/glm', taste: cell(0.25) }],
    name: () => 'GLM',
  }));
  assert.match(table, /id="admin-homeroom-bench-taste-table"/);
  assert.match(table, /First version, GLM/);
  assert.match(table, />Capture \(before\)<\/th>/, 'a capture runs no model, so its column names none');
  assert.match(table, />Would ship<\/td><td[^>]*>75% of 4<\/td><td[^>]*>25% of 4</);
  assert.match(table, /1 \/ 3\.3/, 'low-contrast text per look');
  assert.match(table, /7 · 1 · 0 · 4/);
  assert.match(table, />Spacing<\/td><td[^>]*>–</, 'a criterion nobody graded is a dash');

  const shots = renderToHtml(createElement(TasteShots, { shots: [{ caption: 'Phone 390×844, dark look, empty (no data yet)', artifactId: 'a'.repeat(32) }] }));
  assert.match(shots, new RegExp(`src="/api/admin/homeroom-bot/bench/artifacts/${'a'.repeat(32)}"`));
  assert.match(shots, /alt="Phone 390×844, dark look, empty \(no data yet\)"/);

  // A run's page: the criteria and the checks as two tables, the change beside one first version and its capture.
  const criteriaOnly = renderToHtml(createElement(TasteTable, {
    rows: [{ stage: 'capture', model: 'a/glm', taste: cell(0.25) }, { stage: 'first_version', model: 'a/glm', taste: cell(0.75) }],
    name: () => 'GLM', part: 'criteria',
  }));
  assert.match(criteriaOnly, />Change<\/th>/);
  assert.match(criteriaOnly, />Would ship<\/td><td[^>]*>25% of 4<\/td><td[^>]*>75% of 4<\/td><td[^>]*>\+50 points</);
  assert.doesNotMatch(criteriaOnly, /Console errors/, 'the checks are their own table');
  const checksOnly = renderToHtml(createElement(TasteTable, { rows: [{ stage: 'capture', model: 'a/glm', taste: cell(0.25) }], name: () => 'GLM', part: 'checks' }));
  assert.match(checksOnly, /id="admin-homeroom-bench-taste-checks-table"/);
  assert.doesNotMatch(checksOnly, /Would ship/);

  // Side by side, app by app: what shipped beside each first version.
  const trial = (extra) => ({ trialId: 1, stage: 'capture', model: 'a/glm', attempt: 1, status: 'ok', appSlug: 'bread', appName: 'Bread Bot',
    booted: true, shots: [{ caption: 'Phone 390×844, light look, populated', artifactId: 'b'.repeat(32) }], criteria: { held: 3, of: 12 }, ...extra });
  const side = renderToHtml(createElement(TasteSideBySide, { name: () => 'GLM', trials: [
    trial({}), trial({ trialId: 2, stage: 'first_version', criteria: null }), trial({ trialId: 3, stage: 'first_version', attempt: 2, status: 'running', shots: [] }),
  ] }));
  assert.match(side, /data-bench-taste-app="bread"><p[^>]*>Bread Bot/);
  assert.ok(side.indexOf('data-bench-taste-arm="capture"') < side.indexOf('data-bench-taste-arm="first_version|a/glm"'), 'the before side first');
  assert.match(side, /Before: what shipped/);
  assert.match(side, /3 of 12 criteria held/);
  assert.match(side, /not graded yet/);
  assert.match(side, /Attempt 2.*?Building/);
});

test('the answer reads the default suite once it has run, else the newest suite a model-picking run ran on', () => {
  const { matrixRunsFor } = loadBench();
  const run = (id, suite_id, stages, counts = { ok: 3 }) => ({ id, suite_id, stages, counts });
  const runs = [run(9, 2, ['first_version', 'capture']), run(8, 1, ['triage']), run(7, 1, ['build'], { cancelled: 4 }), run(6, 3, ['triage'])];
  assert.deepEqual(matrixRunsFor(runs, { suiteId: 3 }), { suiteId: 3, runs: [runs[3]] }, 'the launcher\'s suite, once it has run');
  assert.deepEqual(matrixRunsFor(runs, { suiteId: 5 }), { suiteId: 1, runs: [runs[1]] },
    'a Core made but never run: the newest suite a model-picking run ran on, not the taste run\'s, and only runs that ran');
  assert.deepEqual(matrixRunsFor([], { suiteId: 5 }), { suiteId: 5, runs: [] });
  assert.deepEqual(matrixRunsFor([run(1, 4, ['triage'])], null), { suiteId: 4, runs: [run(1, 4, ['triage'])] });
});
