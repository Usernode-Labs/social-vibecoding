'use strict';

// A core benchmark run compares efforts of one model as arms of their own
// (`vendor/model@effort`, src/services/bench/arms.js): the arm as written is
// what a run's models and a trial's model hold, so the report, the cost and
// time history and the console already keep it apart from its model; the
// catalog prices it as its model; the blind scrub masks its model's names,
// never the effort; and the launcher (frontend/src/features/admin/
// admin-homeroom-bench.tsx) and the Configurations' "Compare on the
// benchmark" (admin-bot-configs.tsx) make arms through
// frontend/src/features/admin/bench-arms.ts. The trial's turns are in
// tests/bench-runner.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const arms = require('../src/services/bench/arms');
const catalog = require('../src/services/bench/catalog');
const blinding = require('../src/services/bench/blinding');
const botConfigs = require('../src/services/bot-configs');

const DEEP = 'deepseek/deepseek-v4.1-flash-1017';

test('an arm: a model, or a model at one of a configuration\'s efforts after an @', () => {
  assert.deepEqual(arms.parseArm(`${DEEP}@max`), { arm: `${DEEP}@max`, model: DEEP, effort: 'max' });
  assert.deepEqual(arms.parseArm(`${DEEP}@XHigh`), { arm: `${DEEP}@xhigh`, model: DEEP, effort: 'xhigh' });
  assert.deepEqual(arms.parseArm(DEEP), { arm: DEEP, model: DEEP, effort: null });
  assert.deepEqual(arms.parseArm('config:16'), { arm: 'config:16', model: 'config:16', effort: null }, 'a studio arm is left as it is');
  assert.equal(arms.parseArm(`${DEEP}@turbo`).effort, null, 'only an effort a configuration may name');
  assert.equal(arms.armOf(DEEP, 'max'), `${DEEP}@max`);
  assert.equal(arms.armOf(DEEP, null), DEEP);
  assert.equal(arms.armOf(DEEP, 'turbo'), DEEP);
  assert.equal(arms.modelOf(`${DEEP}@low`), DEEP);
  assert.equal(arms.validArm(`${DEEP}@max`), true);
  assert.equal(arms.validArm(DEEP), true);
  assert.equal(arms.validArm(`${DEEP}@turbo`), false, 'an @ the model id cannot hold');
  assert.equal(arms.validArm('@max'), false);
  assert.deepEqual(arms.EFFORTS, botConfigs.EFFORTS, 'the efforts a configuration names, one list');
});

test('the catalog prices an arm as its model, under its own id and a label that names the effort', async () => {
  const pool = {
    async query(sql) {
      if (/FROM openrouter_model_catalog/.test(String(sql))) {
        return { rows: [{ models: [{ id: DEEP, name: 'DeepSeek V4.1 Flash', context_length: 786000, pricing: { prompt: '0.0000001', completion: '0.0000004' } }] }] };
      }
      return { rows: [] };
    },
  };
  const listed = await catalog.listModels(pool, [DEEP, `${DEEP}@max`]);
  const own = catalog.modelInfo(listed, DEEP);
  const max = catalog.modelInfo(listed, `${DEEP}@max`);
  assert.equal(max.id, `${DEEP}@max`);
  assert.equal(max.model, DEEP);
  assert.equal(max.effort, 'max');
  assert.equal(max.label, `${own.label} at max effort`);
  assert.equal(max.inCatalog, own.inCatalog);
  assert.equal(max.inputPerMillion, own.inputPerMillion);
  assert.equal(max.outputPerMillion, own.outputPerMillion);
  assert.equal(max.contextTokens, own.contextTokens);
  assert.equal(max.role, null, 'an arm at an effort is not its model\'s baseline or candidate entry');
  assert.equal(catalog.notApplicableReason(max, 'build', 1000), catalog.notApplicableReason(own, 'build', 1000), 'what fits its model fits it');
});

test('the blind scrub masks an arm\'s model, never its effort', () => {
  const words = blinding.vocabulary([`${DEEP}@max`, 'z-ai/glm-5.3-flash@high']);
  assert.ok(words.includes(DEEP), 'its model id whole');
  assert.ok(words.includes('deepseek-v4.1-flash-1017'), 'and its model part');
  assert.ok(words.includes('glm-5.3-flash'));
  assert.ok(!words.some((w) => w.includes('@')), 'nothing with the effort in it');
  for (const w of ['max', 'high']) assert.ok(!words.includes(w), `"${w}" is code's word, not a name`);
  assert.equal(blinding.blindText('Written by deepseek-v4.1-flash-1017; Math.max(a, b)', [`${DEEP}@max`]),
    'Written by [model]; Math.max(a, b)');
});

function loadArms() {
  const { loadTsx } = require('./lib/render-tsx');
  return loadTsx('frontend/src/features/admin/bench-arms.ts');
}

test('the console makes arms as the server reads them: every model at every effort ticked, and a preset read back into ticks', () => {
  const { EFFORTS, parseArm, armOf, armsOf, armsGrid } = loadArms();
  assert.deepEqual([...EFFORTS], botConfigs.EFFORTS, 'bot-configs.js EFFORTS, one list');
  assert.deepEqual(parseArm(`${DEEP}@max`), { model: DEEP, effort: 'max' });
  assert.deepEqual(parseArm(DEEP), { model: DEEP, effort: null });
  assert.equal(armOf(DEEP, ''), DEEP);
  assert.deepEqual(armsOf(['a/b', 'c/d'], ['', 'max']), ['a/b', 'a/b@max', 'c/d', 'c/d@max']);
  assert.deepEqual(armsOf(['a/b'], []), ['a/b'], 'no effort ticked is the bot\'s own');
  assert.deepEqual(armsGrid([DEEP, `${DEEP}@max`]), { models: [DEEP], efforts: ['', 'max'] });
  assert.deepEqual(armsGrid(['a/b', 'c/d']), { models: ['a/b', 'c/d'], efforts: [''] });
  assert.equal(armsGrid(['a/b@high', 'c/d']), null, 'two models at different efforts are not every combination');
});

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

test('the launcher\'s Effort row: the bot\'s own ticked by default; a preset of one model at two efforts opens with both ticked, as two arms', () => {
  const { Launcher } = loadBench();
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const suites = [{ id: 5, name: 'Core', version: 1, kind: 'frozen', frozen_at: '2026-10-01', counts: { triage: 44, build: 18 }, total: 62, labelled: 62 }];
  const launcher = { suiteId: 5, models: [DEEP, 'z-ai/glm-5.3-flash'], stages: ['triage'], repeats: 3, repeatStages: ['triage'], capUsd: 50 };
  const models = [{ id: DEEP, label: 'DeepSeek' }, { id: 'z-ai/glm-5.3-flash', label: 'GLM' }, { id: `${DEEP}@max`, label: 'DeepSeek at max effort', model: DEEP, effort: 'max' }];
  const base = { suites, models, defaults: { capUsd: 50, repeats: 3, maxConcurrency: 8 }, launcher, hiddenChecks: 'x', onLaunched() {}, say() {} };

  const plain = renderToHtml(createElement(Launcher, base));
  assert.match(plain, /id="admin-homeroom-bench-launch-efforts"/);
  for (const e of ['own', ...botConfigs.EFFORTS]) assert.match(plain, new RegExp(`data-bench-effort="${e}"`));
  assert.match(plain, /data-bench-effort="own"><input type="checkbox" checked=""/, 'the bot\'s own, as every run before');
  assert.match(plain, /data-bench-effort="max"><input type="checkbox"\/>/);
  assert.doesNotMatch(plain, /data-bench-model="deepseek\/deepseek-v4\.1-flash-1017@max"/, 'an arm from an earlier run is its model and an effort, not a model of its own');
  assert.match(plain, /id="admin-homeroom-bench-launch-summary"[^>]*>Core v1 · 2 models · /);
  assert.match(plain, /Max reaches Claude Code turns only/);

  // Configurations' "Compare on the benchmark" for a version that differs in its build's effort.
  const compared = renderToHtml(createElement(Launcher, { ...base, preset: { stages: ['build'], models: [`${DEEP}@max`, DEEP] } }));
  assert.match(compared, /data-bench-effort="own"><input type="checkbox" checked=""/);
  assert.match(compared, /data-bench-effort="max"><input type="checkbox" checked=""/);
  assert.match(compared, /data-bench-model="deepseek\/deepseek-v4\.1-flash-1017"><input type="checkbox" class="mt-1" checked=""/);
  assert.match(compared, /data-bench-model="z-ai\/glm-5\.3-flash"><input type="checkbox" class="mt-1"\/>/);
  assert.match(compared, /id="admin-homeroom-bench-launch-summary"[^>]*>Core v1 · 2 arms · Build</);
  assert.match(compared, /placeholder="vendor\/model, vendor\/model@max"/);
});
