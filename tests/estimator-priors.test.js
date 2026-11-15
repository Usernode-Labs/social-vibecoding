'use strict';

// What the admin analytics estimator card reads, now that the experimental
// AI progress estimate (#50) is retired: the guesses it recorded
// (`progress_estimates`, kept private to staging copies) and the run-length
// priors the estimator was given (#892, llm.RUN_LENGTH_PRIORS), which the
// card shows beside the medians it measures. The card itself is pinned in
// tests/estimator-accuracy.test.js.
//
// Run with: node --test tests/estimator-priors.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const llm = require('../src/services/llm.js');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('schema adds the progress_estimates accuracy table (private)', () => {
  const schema = read('src/db/schema.sql');
  assert.match(
    schema,
    /CREATE TABLE IF NOT EXISTS progress_estimates/,
    'schema must create the progress_estimates table'
  );
  assert.match(
    schema,
    /progress_message_id\s+INTEGER REFERENCES chat_session_messages/,
    'progress_estimates must anchor on progress_message_id'
  );
  assert.match(
    schema,
    /COMMENT ON TABLE progress_estimates IS 'staging:private'/,
    'progress_estimates must be marked staging:private'
  );
});

test('#892: RUN_LENGTH_PRIORS covers every elapsed bucket with sane quantiles', () => {
  const priors = llm.RUN_LENGTH_PRIORS;
  assert.ok(priors && Array.isArray(priors.buckets), 'the priors table must be exported');
  assert.equal(priors.buckets.length, 5, 'all five measured elapsed buckets must be present');
  assert.deepEqual(
    priors.buckets.map((b) => b.key),
    ['<2m', '2-5m', '5-10m', '10-20m', '20m+'],
    'bucket keys must match the labels the dashboard SQL emits'
  );
  for (const b of priors.buckets) {
    assert.ok(b.p25 <= b.p50, `${b.key}: p25 must not exceed p50`);
    assert.ok(b.p50 <= b.p75, `${b.key}: p50 must not exceed p75`);
    assert.ok(b.p75 <= b.p90, `${b.key}: p75 must not exceed p90`);
    assert.ok(b.n > 0, `${b.key}: must record how many guesses it was measured over`);
  }
  // Bucket bounds must tile the line with no gap and no overlap.
  let prevMax = 0;
  for (const b of priors.buckets) {
    assert.equal(b.minS, prevMax, `${b.key}: bucket bounds must be contiguous`);
    prevMax = b.maxS == null ? Infinity : b.maxS;
  }
  assert.equal(prevMax, Infinity, 'the last bucket must be open-ended');

  const pop = priors.population;
  assert.ok(pop.p50TotalS < pop.p90TotalS && pop.p90TotalS < pop.p99TotalS,
    'population quantiles must be ordered');
  assert.ok(pop.maxTotalS >= pop.p99TotalS, 'the observed max must not be below p99');
});

test('#892: RUN_LENGTH_PRIORS_SNAPSHOT records where the numbers came from', () => {
  const snap = llm.RUN_LENGTH_PRIORS_SNAPSHOT;
  for (const k of ['generatedOn', 'windowStart', 'scoredTicks', 'runs', 'users']) {
    assert.ok(snap[k] != null, `the snapshot must record ${k}`);
  }
  assert.match(snap.generatedOn, /^\d{4}-\d{2}-\d{2}$/, 'generatedOn must be an absolute date');
  assert.match(snap.windowStart, /^\d{4}-\d{2}-\d{2}$/, 'windowStart must be an absolute date');
});

test('#892: the SQL that measured the priors is committed beside them', () => {
  // The priors are a committed constant, and the card lines them up against
  // what it measures from the recorded rows. That comparison only means
  // something if the query that produced them is right there.
  const src = read('src/services/llm.js');
  assert.match(src, /HOW THE NUMBERS WERE MEASURED/, 'the measuring procedure must be committed');
  assert.match(src, /percentile_cont\(0\.25\)/, 'the per-bucket quantile query must be present');
  assert.match(src, /percentile_cont\(0\.90\)/, 'the p90 the prompt quotes must be derivable');
  assert.match(src, /the SCORED predicate/, 'the refresh query must use the same scored predicate');
  assert.match(src, /Population facts \(one row per RUN/,
    'the population-quantile query must be present too');
});
