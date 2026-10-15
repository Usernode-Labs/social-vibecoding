'use strict';

// #4452: how long testing a change usually takes on one app, from the
// app's recent finished runs (src/services/checks-estimate.js), and the
// change page reads it with the proposal (both detail routes).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const estimate = require('../src/services/checks-estimate');

const run = (buildSteps, checksMs) => ({
  build: { step: 'done', steps: buildSteps.map((ms, i) => ({ key: `s${i}`, ms })), totalMs: 1 },
  checksMs,
});

test('the median of the recent runs, each half on its own', () => {
  const e = estimate.estimateFrom([
    run([60000, 60000], 600000),
    run([90000, 90000], 300000),
    run([30000, 30000], 900000),
  ]);
  assert.deepEqual(e, { buildMs: 120000, checksMs: 600000, runs: 3 });
});

test('fewer than three finished runs make no estimate', () => {
  assert.equal(estimate.estimateFrom([run([1000], 1000), run([1000], 1000)]), null);
  assert.equal(estimate.estimateFrom([]), null);
  assert.equal(estimate.estimateFrom(null), null);
});

test('a run still building, or one that kept no checks time, is not counted', () => {
  const live = { build: { step: 'image_build', steps: [{ key: 'source_fetch', ms: 2000 }] }, checksMs: 5000 };
  const noChecks = { build: { step: 'done', steps: [{ key: 'health', ms: 2000 }] } };
  const e = estimate.estimateFrom([live, noChecks, run([1000], 4000), run([3000], 2000), run([2000], 3000)]);
  assert.deepEqual(e, { buildMs: 2000, checksMs: 3000, runs: 3 });
});

test('a build block with no step times falls back to its total', () => {
  assert.equal(estimate.buildMsOf({ build: { step: 'done', steps: [], totalMs: 42000 } }), 42000);
  assert.equal(estimate.buildMsOf({ build: { step: 'clone', steps: [], totalMs: 42000 } }), null);
});

test('an even count takes the middle two', () => {
  assert.equal(estimate.median([4, 1, 3, 2]), 3);
  assert.equal(estimate.median([]), null);
});

test('only the most recent runs are read', () => {
  const runs = Array.from({ length: 40 }, (_, i) => run([1000 * (i + 1)], 1000));
  assert.equal(estimate.estimateFrom(runs).runs, estimate.RECENT_RUNS);
});

test('a failed read is no estimate, and the answer is cached per app', async () => {
  let reads = 0;
  const pool = { query: async () => { reads += 1; return { rows: [run([1000], 2000), run([1000], 2000), run([1000], 2000)].map((p) => ({ checks_progress: p })) }; } };
  assert.deepEqual(await estimate.forApp(pool, 77001), { buildMs: 1000, checksMs: 2000, runs: 3 });
  await estimate.forApp(pool, 77001);
  assert.equal(reads, 1);
  const broken = { query: async () => { throw new Error('down'); } };
  assert.equal(await estimate.forApp(broken, 77002), null);
  assert.equal(await estimate.forApp(pool, 0), null);
});

test('both change-page reads carry the estimate', () => {
  const votes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'votes.js'), 'utf8');
  const sessions = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'sessions.js'), 'utf8');
  assert.match(votes, /proposal\.checks_estimate = await require\('\.\.\/services\/checks-estimate'\)\.forApp\(pool, gatedApp\.id\)/);
  assert.match(sessions, /detail\.checks_estimate = await require\('\.\.\/services\/checks-estimate'\)\.forApp\(pool, session\.app_id\)/);
});
