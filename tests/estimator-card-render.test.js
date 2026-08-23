// Render smoke test for the progress-estimator accuracy card (#892).
//
// The sibling tests in estimator-accuracy.test.js are source guards — they
// prove the right strings exist in the right files. They cannot catch the
// failure mode this change is most exposed to: the card grew three new
// nested blocks (the v1-vs-v2 comparison, the baselines row, the priors
// freshness strip), and a bad interpolation in any of them throws at RENDER
// time while every grep still passes.
//
// So this actually RENDERS the card against the staging demo payload — the
// same payload a PR preview renders, since progress_estimates is
// staging:private and therefore empty in a cloned staging DB.
//
// ── The card is React now (#1120 slice 14) ─────────────────────────────
//
// This file used to evaluate the browser IIFE in a `vm` with a DOM shim and
// call `renderEstimator` through a hoisted reference. JSX is not evaluable
// JavaScript, so that trick is gone; tests/lib/render-tsx.js bundles the
// module with esbuild and renders `<EstimatorCard/>` with
// renderToStaticMarkup instead. Every assertion below is unchanged — the card
// is still EXECUTED against the real payload, which is the whole point of the
// file. Two of them got weaker on their own and are noted where they sit:
// React cannot leave a `${` in the output or stringify an object into it,
// because neither is expressible any more.
//
// Run with: node --test tests/estimator-card-render.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const analyticsDemo = require('../src/services/analytics-demo.js');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx.js');

const ENTRY = 'frontend/src/features/admin/admin-estimator.tsx';

// Bundled once: esbuild is the slow part, and the component is pure.
const { EstimatorCard } = loadTsx(ENTRY);

/**
 * Render and return `{ html, err }` rather than letting a throw escape — a
 * component that dies on a payload is exactly what this file exists to
 * report, and the message is more useful than a stack from the runner.
 */
function render(payload) {
  try {
    return { html: renderToHtml(createElement(EstimatorCard, { e: payload })), err: null };
  } catch (e) {
    return { html: '', err: e };
  }
}

test('#892: the estimator card renders the demo payload without throwing', () => {
  const { html, err } = render(analyticsDemo.estimatorAccuracy());
  assert.equal(err, null, err && `EstimatorCard threw: ${err.stack || err.message}`);

  assert.ok(html.length > 500, 'the card must actually render content');
  // Nothing unresolved may leak into the output. `undefined` is the one of the
  // three that is still reachable — React renders it as nothing, but a
  // template literal built from an absent field still says "undefined".
  assert.ok(!/undefined/.test(html), 'no "undefined" may reach the rendered card');
  assert.ok(!/\[object Object\]/.test(html), 'no object may be stringified into the card');
  assert.ok(!/\$\{/.test(html), 'no template placeholder may survive into the output');
});

test('#892: the rendered card shows the version split, baselines and priors', () => {
  const { html } = render(analyticsDemo.estimatorAccuracy());

  assert.match(html, /Prompt generation/, 'the v1-vs-v2 comparison must render');
  assert.match(html, /candidate/, 'the candidate generation must be marked');
  assert.match(html, /Baselines to beat/, 'the baselines row must render');
  assert.match(html, /Elapsed-only oracle/, 'the oracle baseline must be named');
  assert.match(html, /Run-length figures given to the model/, 'the priors strip must render');
  // The demo payload is seeded stale on one bucket, so a PR preview
  // exercises the state a reviewer most needs to recognise on sight.
  assert.match(html, /Priors stale/, 'the stale-priors state must render');
  assert.match(html, /Finish pushed later/, 'the treadmill tile must render');
  assert.match(html, /Countdown went backwards/, 'the backwards-countdown tile must render');
  assert.match(html, /Unearned/, 'the completion-claim tile must render');
});

test('#892: the card renders the not-yet verdict off the demo payload', () => {
  // The demo v2 clears the bias bar but sits just under the 45% in-band bar,
  // so a PR preview must show the amber "stays experimental" path rather
  // than a green light nobody has earned off mock data.
  const { html } = render(analyticsDemo.estimatorAccuracy());
  assert.match(html, /Stays experimental/, 'the demo must not render a green verdict');
  assert.doesNotMatch(html, /Ready to leave experimental/,
    'mock data must never claim the feature is ready');
});

test('#892: the verdict is judged on the candidate version, not the pooled window', () => {
  // Pooling v1 in would drag the answer toward the prompt this change
  // replaces — the card would answer the wrong question.
  const payload = analyticsDemo.estimatorAccuracy();
  // Make v2 unambiguously pass while the pooled 30-day window still fails.
  payload.byPromptVersion = payload.byPromptVersion.map((v) => (
    v.promptVersion === 2
      ? { ...v, scored: 400, runs: 80, users: 6, medianAbsErrS: 150, withinBand: 0.52, medianBiasS: 5 }
      : v
  ));
  payload.monotonicity.displayed.laterRate = 0.10;
  payload.monotonicity.displayed.increasedRate = 0.01;
  payload.completionClaims.overFiveMinLeftRate = 0.04;
  const { html, err } = render(payload);
  assert.equal(err, null, err && String(err.stack));
  assert.match(html, /Ready to leave experimental/,
    'a passing candidate must be recognised even though the pooled window fails');
  // And the headline tiles must describe v2, not the 30-day pool.
  assert.match(html, /Scored guesses \(v2\)/,
    'the tiles must be labelled with the version they describe');
});

test('#892: a candidate that only fails the display gates is still held back', () => {
  // A countdown that walks backwards is a failure even when its numbers are
  // good — that is the whole reason the guard metrics are part of the bar.
  const payload = analyticsDemo.estimatorAccuracy();
  payload.byPromptVersion = payload.byPromptVersion.map((v) => (
    v.promptVersion === 2
      ? { ...v, scored: 400, runs: 80, users: 6, medianAbsErrS: 150, withinBand: 0.52, medianBiasS: 5 }
      : v
  ));
  payload.completionClaims.overFiveMinLeftRate = 0.04;
  payload.monotonicity.displayed.laterRate = 0.60;   // the treadmill is back
  payload.monotonicity.displayed.increasedRate = 0.01;
  const { html, err } = render(payload);
  assert.equal(err, null, err && String(err.stack));
  assert.match(html, /Stays experimental/, 'good numbers must not excuse a moving finish line');
  assert.match(html, /finish pushed later too often/, 'the verdict must name what failed');
});

test('#892: the card survives a payload with the new sections absent', () => {
  // A server mid-deploy (or an older one) can answer without
  // byPromptVersion / baselines / priors. The card must degrade, not throw.
  const legacy = analyticsDemo.estimatorAccuracy();
  for (const k of ['byPromptVersion', 'baselines', 'priors', 'monotonicity', 'completionClaims']) {
    delete legacy[k];
  }
  const { html, err } = render(legacy);
  assert.equal(err, null, err && `threw on a legacy payload: ${err.stack}`);
  assert.ok(html.length > 200, 'the card must still render');
});

test('#892: an empty payload renders the empty state rather than throwing', () => {
  for (const payload of [null, undefined, {}, { allTime: { ticks: 0 } }]) {
    const { html, err } = render(payload);
    assert.equal(err, null, err && `threw on ${JSON.stringify(payload)}: ${err.stack}`);
    assert.match(html, /Not enough data yet/);
  }
});
