// Render smoke test for the progress-estimator accuracy card (#892).
//
// The sibling tests in estimator-accuracy.test.js are source guards — they
// prove the right strings exist in the right files. They cannot catch the
// failure mode this change is most exposed to: the card grew three new
// nested-template blocks (the v1-vs-v2 comparison, the baselines row, the
// priors freshness strip), and a bad interpolation in any of them throws at
// RENDER time while every grep still passes.
//
// So this actually EXECUTES renderEstimator against the staging demo payload
// — the same payload a PR preview renders, since progress_estimates is
// staging:private and therefore empty in a cloned staging DB.
//
// The module is a browser IIFE, so it runs in a `vm` with a DOM shim just
// large enough for the estimator path. renderEstimator is closure-private,
// so the source is evaluated with one appended line hoisting it onto the
// sandbox global — the SHIPPED code runs, unmodified apart from that hook.
//
// Run with: node --test tests/estimator-card-render.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const analyticsDemo = require('../src/services/analytics-demo.js');

// #1082 chunk E moved the module into the React bundle. Same IIFE, same
// templates — only the directory changed, plus the AdminUI import at the top,
// which the extraction below stands in for.
const ADMIN_DIR = path.join(__dirname, '..', 'frontend', 'src', 'features', 'admin');

const SRC = fs.readFileSync(path.join(ADMIN_DIR, 'admin-estimator.js'), 'utf8')
  // The one line the vm cannot evaluate: a bare `import` statement. The
  // registry it names is supplied by ADMIN_UI_SRC below, exactly as the
  // bundler supplies it in the browser.
  .replace(/^import \{ AdminUI \} from '\.\/admin-console\.js';$/m, '');

// The module reads AdminUI's recipes from its templates. Mirror the binding the
// bundler gives it by evaluating the registry block on its own — same
// extraction as tests/admin-ui-registry.test.js.
const ADMIN_UI_SRC = (() => {
  const consoleSrc = fs.readFileSync(path.join(ADMIN_DIR, 'admin-console.js'), 'utf8');
  const m = consoleSrc.match(/export const AdminUI = Object\.freeze\(\{[\s\S]*?\n\}\);/);
  assert.ok(m, 'admin-console.js defines the AdminUI registry');
  return m[0].replace(/^export const/, 'var');
})();

// ── A DOM shim: enough for the estimator card, no more ──────────────────
function makeElement(id) {
  return {
    id,
    innerHTML: '',
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    remove() {},
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
  };
}

function loadCard() {
  const elements = new Map();
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  const document = {
    getElementById: byId,
    createElement: (tag) => makeElement(tag),
    body: makeElement('body'),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const sandbox = {
    document,
    window: { addEventListener() {}, removeEventListener() {} },
    console,
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    setTimeout,
    clearTimeout,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { hash: '', search: '' },
    navigator: { language: 'en-US' },
    requestAnimationFrame: (fn) => fn(),
    URLSearchParams,
    URL,
  };
  sandbox.window.document = document;
  vm.createContext(sandbox);
  // Bind AdminUI in the module's scope, as the bundler's import does. `var` at
  // the top level of a vm context IS the sandbox global, so the module body
  // resolves the bare identifier without any further wiring.
  vm.runInContext(ADMIN_UI_SRC, sandbox, { filename: 'admin-console.js#AdminUI' });
  assert.equal(typeof sandbox.AdminUI, 'object', 'the AdminUI registry must be bound');

  // The only edit to the shipped source: hoist the private renderer so the
  // test can call it. Everything it touches is the real module's closure.
  // Inserted BEFORE the IIFE's `return` — after it the statement would be
  // unreachable and the hook would silently never run.
  const hoisted = SRC.replace(
    "\n  return {",
    "\n  globalThis.__renderEstimator = renderEstimator;\n  return {"
  );
  assert.notEqual(hoisted, SRC, 'the IIFE tail must be found for hoisting');
  vm.runInContext(hoisted, sandbox, { filename: 'admin-estimator.js' });
  assert.equal(typeof sandbox.__renderEstimator, 'function',
    'renderEstimator must be reachable');
  return { sandbox, byId };
}

// Render and return the thrown error, if any, rather than letting it escape
// the vm — a thrown template is exactly what this file exists to report.
function render(sandbox, payload) {
  sandbox.__payload = payload;
  vm.runInContext(
    'globalThis.__err = null; try { __renderEstimator(__payload); }'
    + ' catch (e) { globalThis.__err = e; }',
    sandbox
  );
  return sandbox.__err;
}

test('#892: the estimator card renders the demo payload without throwing', () => {
  const { sandbox, byId } = loadCard();
  const err = render(sandbox, analyticsDemo.estimatorAccuracy());
  assert.equal(err, null, err && `renderEstimator threw: ${err.stack || err.message}`);

  const html = byId('admin-estimator-card').innerHTML;
  assert.ok(html.length > 500, 'the card must actually render content');
  // Nothing unresolved may leak into the output.
  assert.ok(!/undefined/.test(html), 'no "undefined" may reach the rendered card');
  assert.ok(!/\[object Object\]/.test(html), 'no object may be stringified into the card');
  assert.ok(!/\$\{/.test(html), 'no template placeholder may survive into the output');
});

test('#892: the rendered card shows the version split, baselines and priors', () => {
  const { sandbox, byId } = loadCard();
  assert.equal(render(sandbox, analyticsDemo.estimatorAccuracy()), null);
  const html = byId('admin-estimator-card').innerHTML;

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
  const { sandbox, byId } = loadCard();
  assert.equal(render(sandbox, analyticsDemo.estimatorAccuracy()), null);
  const html = byId('admin-estimator-card').innerHTML;
  assert.match(html, /Stays experimental/, 'the demo must not render a green verdict');
  assert.doesNotMatch(html, /Ready to leave experimental/,
    'mock data must never claim the feature is ready');
});

test('#892: the verdict is judged on the candidate version, not the pooled window', () => {
  // Pooling v1 in would drag the answer toward the prompt this change
  // replaces — the card would answer the wrong question.
  const { sandbox, byId } = loadCard();
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
  assert.equal(render(sandbox, payload), null);
  const html = byId('admin-estimator-card').innerHTML;
  assert.match(html, /Ready to leave experimental/,
    'a passing candidate must be recognised even though the pooled window fails');
  // And the headline tiles must describe v2, not the 30-day pool.
  assert.match(html, /Scored guesses \(v2\)/,
    'the tiles must be labelled with the version they describe');
});

test('#892: a candidate that only fails the display gates is still held back', () => {
  // A countdown that walks backwards is a failure even when its numbers are
  // good — that is the whole reason the guard metrics are part of the bar.
  const { sandbox, byId } = loadCard();
  const payload = analyticsDemo.estimatorAccuracy();
  payload.byPromptVersion = payload.byPromptVersion.map((v) => (
    v.promptVersion === 2
      ? { ...v, scored: 400, runs: 80, users: 6, medianAbsErrS: 150, withinBand: 0.52, medianBiasS: 5 }
      : v
  ));
  payload.completionClaims.overFiveMinLeftRate = 0.04;
  payload.monotonicity.displayed.laterRate = 0.60;   // the treadmill is back
  payload.monotonicity.displayed.increasedRate = 0.01;
  assert.equal(render(sandbox, payload), null);
  const html = byId('admin-estimator-card').innerHTML;
  assert.match(html, /Stays experimental/, 'good numbers must not excuse a moving finish line');
  assert.match(html, /finish pushed later too often/, 'the verdict must name what failed');
});

test('#892: the card survives a payload with the new sections absent', () => {
  // A server mid-deploy (or an older one) can answer without
  // byPromptVersion / baselines / priors. The card must degrade, not throw.
  const { sandbox, byId } = loadCard();
  const legacy = analyticsDemo.estimatorAccuracy();
  for (const k of ['byPromptVersion', 'baselines', 'priors', 'monotonicity', 'completionClaims']) {
    delete legacy[k];
  }
  const err = render(sandbox, legacy);
  assert.equal(err, null, err && `threw on a legacy payload: ${err.stack}`);
  assert.ok(byId('admin-estimator-card').innerHTML.length > 200, 'the card must still render');
});

test('#892: an empty payload renders the empty state rather than throwing', () => {
  const { sandbox, byId } = loadCard();
  for (const payload of [null, undefined, {}, { allTime: { ticks: 0 } }]) {
    const err = render(sandbox, payload);
    assert.equal(err, null, err && `threw on ${JSON.stringify(payload)}: ${err.stack}`);
    assert.match(byId('admin-estimator-card').innerHTML, /Not enough data yet/);
  }
});
