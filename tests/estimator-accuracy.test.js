// Tests for the Progress estimator accuracy admin surface (#891).
//
// `progress_estimates` has been recording every guess and its backfilled
// ground truth since #50, with nothing anywhere reading it back — so nobody
// could answer "should the estimator leave experimental?". This covers the
// read surface that answers it: the /estimator analytics endpoint, its
// staging demo payload, and the Analytics-section card.
//
// Source guards (the house style for this repo — the endpoint needs a live
// admin session + Postgres to exercise end to end) plus real unit tests for
// the demo generator, which is pure and requireable.
//
// Run with: node --test tests/estimator-accuracy.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const analyticsDemo = require('../src/services/analytics-demo.js');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// Slice out the /estimator handler so assertions can't accidentally match a
// sibling endpoint's SQL.
function estimatorHandler() {
  const src = read('src/routes/dashboard.js');
  const start = src.indexOf(`router.get('/api/admin/analytics/estimator'`);
  assert.ok(start !== -1, 'the /estimator endpoint must exist');
  const end = src.indexOf('return router;', start);
  return src.slice(start, end === -1 ? src.length : end);
}

// ── 1. The endpoint ─────────────────────────────────────────────────────

test('#891: /estimator sits behind the admin-gated analytics prefix', () => {
  const src = read('src/routes/dashboard.js');
  // One router.use covers every /api/admin/analytics/* route.
  assert.match(src, /router\.use\('\/api\/admin\/analytics', adminMiddleware\)/,
    'the analytics prefix must be admin-gated');
  const gateAt = src.indexOf(`router.use('/api/admin/analytics', adminMiddleware)`);
  const routeAt = src.indexOf(`router.get('/api/admin/analytics/estimator'`);
  assert.ok(routeAt > gateAt, '/estimator must be registered after the gate');
});

test('#891: /estimator computes the named accuracy metrics', () => {
  const fn = estimatorHandler();
  // Ground truth vs prediction, in seconds. Signed so bias has a direction.
  assert.match(fn, /predicted_remaining_seconds - actual_remaining_ms \/ 1000\.0/,
    'error must be predicted minus actual remaining');
  assert.match(fn, /percentile_cont\(0\.5\) WITHIN GROUP \(ORDER BY abs\(\$\{ERR\}\)\)/,
    'median absolute error must use percentile_cont');
  assert.match(fn, /percentile_cont\(0\.5\) WITHIN GROUP \(ORDER BY \$\{ERR\}\)/,
    'median signed bias must use percentile_cont');
  assert.match(fn, /abs\(\$\{ERR\}\) <= 60/, 'the within-60s share must be computed');
  // The half-to-double band: predicted between actual/2 and actual*2.
  assert.match(fn, /actual_remaining_ms \/ 2000\.0/, 'band lower bound must be actual/2');
  assert.match(fn, /actual_remaining_ms \/ 500\.0/, 'band upper bound must be actual*2');
  assert.match(fn, /unresolvedRate/, 'the data-health unresolved rate must be reported');
  assert.match(fn, /usersEnabled/, 'the opted-in user count must be reported');
  assert.match(fn, /FROM users WHERE ai_progress_estimate/,
    'usersEnabled must count the per-user toggle');
});

test('#891: /estimator scores only resolved, predicted, positive-remaining ticks', () => {
  const fn = estimatorHandler();
  assert.match(fn, /actual_total_ms IS NOT NULL/, 'unresolved ticks must be excluded from scoring');
  assert.match(fn, /predicted_remaining_seconds IS NOT NULL/,
    'ticks where the model declined a number must be excluded from scoring');
  // Ratio metrics divide by the actual remaining time, so a run that outlived
  // its own estimate must not be scored — but must still be counted.
  assert.match(fn, /actual_remaining_ms > 0/,
    'ratio metrics must exclude non-positive remaining time');
  assert.match(fn, /AS ran_past/, 'runs that outlived the estimate must be counted separately');
});

test('#891: /estimator reports both windows plus the breakdowns', () => {
  const fn = estimatorHandler();
  assert.match(fn, /last30d:/, 'the 30-day window must be reported');
  assert.match(fn, /allTime:/, 'the all-time window must be reported');
  assert.match(fn, /INTERVAL '30 days'/, 'the windowed query must scope to 30 days');
  assert.match(fn, /byElapsed:/, 'the elapsed-bucket breakdown must be reported');
  assert.match(fn, /byOutcome:/, 'the outcome breakdown must be reported');
  assert.match(fn, /daily:/, 'the daily error series must be reported');
  // Elapsed buckets from the spec.
  for (const b of ["'<2m'", "'2-5m'", "'5-10m'", "'10m\\+'"]) {
    assert.match(fn, new RegExp(b), `elapsed bucket ${b} must exist`);
  }
});

test('#891: /estimator deliberately ignores the includeAdmins filter', () => {
  const fn = estimatorHandler();
  // The estimator is opt-in and default-OFF, so its population is tiny and
  // admin-heavy — applying the sibling endpoints' adminFilter() would leave
  // the card permanently empty.
  assert.doesNotMatch(fn, /adminFilter\(/,
    '/estimator must not apply the admin-exclusion filter');
  assert.doesNotMatch(fn, /wantsAdmins\(/,
    '/estimator must not read the includeAdmins flag');
});

// ── 2. Staging demo substitution ────────────────────────────────────────

test('#891: analytics-demo exports estimatorAccuracy with the payload shape', () => {
  assert.equal(typeof analyticsDemo.estimatorAccuracy, 'function');
  const d = analyticsDemo.estimatorAccuracy();
  for (const k of ['last30d', 'allTime', 'usersEnabled', 'byElapsed', 'byOutcome', 'daily']) {
    assert.ok(k in d, `demo payload must carry ${k}`);
  }
  for (const k of ['ticks', 'scored', 'runs', 'users', 'medianAbsErrS', 'medianBiasS',
    'within60s', 'withinBand', 'unresolvedRate', 'ranPast', 'coverage']) {
    assert.ok(k in d.last30d, `demo last30d must carry ${k}`);
  }
  assert.ok(Array.isArray(d.daily) && d.daily.length === 30,
    'the demo daily series must cover 30 days');
  assert.ok(d.byElapsed.length && d.byOutcome.length, 'breakdowns must be populated');
  // Rates are shares, not percentages.
  for (const v of [d.last30d.withinBand, d.last30d.within60s, d.last30d.unresolvedRate]) {
    assert.ok(v >= 0 && v <= 1, `expected a 0..1 share, got ${v}`);
  }
});

test('#891: the demo payload is deterministic', () => {
  const a = analyticsDemo.estimatorAccuracy();
  const b = analyticsDemo.estimatorAccuracy();
  assert.deepEqual(a, b, 'two staging builds must render identical demo numbers');
});

test('#891: /estimator substitutes the demo only when genuinely empty', () => {
  const fn = estimatorHandler();
  assert.match(fn, /wantsDemo\(req\) && !payload\.allTime\.ticks/,
    'demo substitution must require both ?demo=1 and a genuinely empty result');
  assert.match(fn, /analyticsDemo\.estimatorAccuracy\(\)/,
    'the demo generator must be the substituted payload');
  // wantsDemo is itself IS_STAGING-gated, so this is a no-op in production.
  const src = read('src/routes/dashboard.js');
  assert.match(src, /function wantsDemo\(req\) \{\s*\n\s*return analyticsDemo\.IS_STAGING && req\.query\.demo === '1';/,
    'wantsDemo must be staging-gated');
});

test('#891: progress_estimates stays staging:private (so the demo is needed)', () => {
  const schema = read('src/db/schema.sql');
  assert.match(schema, /COMMENT ON TABLE progress_estimates IS 'staging:private'/,
    'the table must stay private — which is why the card needs demo data');
});

// ── 3. The card ─────────────────────────────────────────────────────────

test('#891: the Analytics section renders the estimator card', () => {
  const js = read('public/js/admin-analytics.js');
  assert.match(js, /<div id="estimator"><\/div>/, 'the card must have a mount point');
  assert.match(js, /Progress estimator accuracy/, 'the card must be titled');
  assert.match(js, /data-info="estimator"/, 'the card must carry a (?) info icon');
  assert.match(js, /function renderEstimator\(e\)/, 'a render function must exist');
  assert.match(js, /renderEstimator\(estimator\)/, 'loadAll must render the card');
  assert.match(js, /getJSON\(withAdmins\('\/api\/admin\/analytics\/estimator'\)\)/,
    'loadAll must fetch the endpoint');
});

test('#891: the card states the leave-experimental bar', () => {
  const js = read('public/js/admin-analytics.js');
  // The thresholds live in one constant driving both the tiles and the verdict.
  assert.match(js, /const ESTIMATOR_BAR = \{ scored: 200, runs: 50, users: 5, medianAbsErrS: 90, withinBand: 0\.6, biasS: 60 \}/,
    'the decision thresholds must be a single named constant');
  assert.match(js, /function estimatorVerdict\(w\)/, 'the card must compute a verdict');
  assert.match(js, /Ready to leave experimental/, 'the verdict must have a ready state');
  assert.match(js, /Stays experimental/, 'the verdict must have a not-ready state');
  // "Not enough data yet" must be distinguishable from "failed the bar".
  assert.match(js, /not enough data yet/, 'insufficient data must read differently from a miss');
  // The (?) definition repeats the bar so it is visible in the UI.
  assert.match(js, /estimator: 'Predicted-vs-actual/, 'the info map must define the card');
  assert.match(js, /Leaves experimental when/, 'the info copy must state the bar');
  assert.match(js, /always includes admins/, 'the info copy must flag the admin-inclusion caveat');
});

test('#891: withAdmins carries the page ?demo=1 through to the endpoints', () => {
  const js = read('public/js/admin-analytics.js');
  // Without this the whole section's demo substitution never fires, so the
  // new card (and every existing chart) is blank in a staging preview.
  assert.match(js, /const DEMO = new URLSearchParams\(location\.search\)\.get\('demo'\) === '1'/,
    'the page-level demo flag must be read from location.search');
  const fnStart = js.indexOf('function withAdmins(url) {');
  assert.ok(fnStart !== -1, 'withAdmins must exist');
  const fnBody = js.slice(fnStart, js.indexOf('\n  }', fnStart));
  assert.match(fnBody, /includeAdmins=\$\{includeAdmins\}/, 'the admin flag must still ride along');
  assert.match(fnBody, /\$\{DEMO \? '&demo=1' : ''\}/, 'demo=1 must ride along when present');
});

test('#891: a server without the endpoint does not blank the page', () => {
  const js = read('public/js/admin-analytics.js');
  // The card is new; a stale server must degrade to an empty card, not throw
  // out of Promise.all and gate the whole section behind the error screen.
  assert.match(js, /getJSON\(withAdmins\('\/api\/admin\/analytics\/estimator'\)\)\.catch\(\(\) => null\)/,
    'the estimator fetch must tolerate failure');
  const fnStart = js.indexOf('function renderEstimator(e) {');
  const fnBody = js.slice(fnStart, fnStart + 600);
  assert.match(fnBody, /if \(!e \|\| !all \|\| !all\.ticks\) \{/,
    'renderEstimator must handle a null/empty payload');
  assert.match(fnBody, /EMPTY_MSG/, 'an empty payload must render the shared empty state');
});

test('#891: the card formats durations without a 60-second carry bug', () => {
  const js = read('public/js/admin-analytics.js');
  const fnStart = js.indexOf('const fmtSecs = (v) => {');
  assert.ok(fnStart !== -1, 'fmtSecs must exist');
  const fnBody = js.slice(fnStart, js.indexOf('\n  };', fnStart));
  // Rounding the m/s parts independently renders 119.5s as "1m 60s".
  assert.match(fnBody, /const total = Math\.round\(Math\.abs\(n\)\)/,
    'fmtSecs must round to whole seconds before splitting into m/s');
  assert.doesNotMatch(fnBody, /Math\.round\(a % 60\)/,
    'the remainder must not be rounded independently');
  // Reimplement the guarded shape to pin the actual boundary behaviour.
  const fmt = (n) => {
    const sign = n < 0 ? '-' : '';
    const total = Math.round(Math.abs(n));
    if (total < 60) return `${sign}${total}s`;
    return `${sign}${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
  };
  assert.equal(fmt(119.5), '2m 00s');
  assert.equal(fmt(59.6), '1m 00s');
  assert.equal(fmt(78.4), '1m 18s');
  assert.equal(fmt(-22.6), '-23s');
});
