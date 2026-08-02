// Tests for the progress-estimate orphan sweeper (#892).
//
// The live backfill that fills in a turn's actual outcome only exists inside
// runClaudeCodeTool's dispatch `finally`. A server restart, crash or deploy
// mid-run therefore strands that run's estimate rows with
// `actual_total_ms IS NULL` forever — measured in production at 482 rows
// across 100 distinct runs (about 10% of all runs), with the daily
// unresolved rate holding steady at 10-13%. This sweeper resolves them so
// the dashboard's v1-vs-v2 comparison has a clean denominator.
//
// Source guards rather than a live DB: the SQL's safety properties (the
// never-overwrite guard, the age threshold, the derived end time) are what
// matter and they are all statically checkable.
//
// Run with: node --test tests/estimate-backfill.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const sweeper = require('../src/services/estimate-backfill.js');
const SRC = read('src/services/estimate-backfill.js');

test('#892: the sweeper exports the poller surface', () => {
  assert.equal(typeof sweeper.start, 'function', 'server.js calls start(config)');
  assert.equal(typeof sweeper.sweep, 'function');
  assert.equal(typeof sweeper.sweepOnce, 'function', 'the pass itself must be unit-callable');
});

test('#892: the UPDATE is guarded so it can never race the live backfill', () => {
  // Whichever runs first wins and the other is a no-op. Without this guard
  // the sweeper could overwrite a real, precise duration with its estimate.
  const updateAt = SRC.indexOf('UPDATE progress_estimates');
  assert.ok(updateAt > 0, 'the sweeper must issue an UPDATE');
  const update = SRC.slice(updateAt, SRC.indexOf('`', updateAt));
  assert.match(update, /AND actual_total_ms IS NULL/,
    'the UPDATE must refuse to touch an already-resolved row');
  assert.match(update, /WHERE progress_message_id = \$2/,
    'the UPDATE must be scoped to one run');
});

test('#892: swept rows are marked unknown, not guessed into a real outcome', () => {
  // We know how long the run went; we do NOT know how it ended. Inventing
  // 'committed' would corrupt the byOutcome breakdown.
  const updateAt = SRC.indexOf('UPDATE progress_estimates');
  const update = SRC.slice(updateAt, SRC.indexOf('`', updateAt));
  assert.match(update, /outcome\s+= 'unknown'/, "swept rows must be marked 'unknown'");
  assert.doesNotMatch(update, /'committed'|'noop'|'stopped'|'error'/,
    'the sweeper must never invent a real outcome');
});

test('#892: per-tick ground truth is derived from that tick\'s own elapsed_ms', () => {
  // actual_remaining_ms is per-TICK: the run's total minus how far into the
  // run that particular guess was made. A single shared value would make
  // every tick in a run look equally wrong.
  const updateAt = SRC.indexOf('UPDATE progress_estimates');
  const update = SRC.slice(updateAt, SRC.indexOf('`', updateAt));
  assert.match(update, /actual_remaining_ms = \$1 - elapsed_ms/,
    'remaining must be total minus that row\'s own elapsed');
  assert.match(update, /resolved_at\s+= NOW\(\)/, 'the resolution must be stamped');
});

test('#892: only rows past the age threshold are eligible', () => {
  // A turn can legitimately run for well over an hour (the longest observed
  // was 1h45m), so the threshold sits past any plausible in-flight run.
  assert.equal(sweeper.ORPHAN_AGE_HOURS, 2);
  assert.match(SRC, /pe\.created_at < NOW\(\) - \(\$1 \|\| ' hours'\)::interval/,
    'the selection must exclude recent rows');
  assert.match(SRC, /pe\.actual_total_ms IS NULL/,
    'the selection must only consider unresolved rows');
});

test('#892: the sweep is bounded per pass and ordered oldest-first', () => {
  // A large historical backlog is worked through over several ticks rather
  // than in one long transaction.
  assert.ok(sweeper.MAX_RUNS_PER_SWEEP > 0 && sweeper.MAX_RUNS_PER_SWEEP <= 1000);
  assert.match(SRC, /ORDER BY MAX\(pe\.created_at\)/, 'oldest orphans first');
  assert.match(SRC, /LIMIT \$2/, 'each pass must be bounded');
});

test('#892: the run end is derived from the session, with a bounded fallback', () => {
  assert.match(SRC, /cs\.active_turn IS NOT TRUE/,
    'a finished session\'s own stamp is the best available end time');
  assert.match(SRC, /o\.last_elapsed_ms \+ 60000/,
    'the fallback bounds the run at the last tick plus one estimator cadence');
  assert.match(SRC, /GREATEST\(/,
    'the derived total must never come out below the last tick\'s own elapsed');
});

test('#892: the sweeper is grouped per run, not per row', () => {
  assert.match(SRC, /GROUP BY pe\.progress_message_id/,
    'orphans must be resolved a run at a time — every tick in a run shares one total');
});

test('#892: the sweeper is registered on boot', () => {
  const server = read('server.js');
  assert.match(server, /require\('\.\/src\/services\/estimate-backfill'\)\.start\(config\)/,
    'server.js must start the sweeper alongside the other pollers');
});

test('#892: the interval never holds the process open', () => {
  // Same posture as the other pollers — an un-unref\'d timer would stop the
  // process exiting cleanly on SIGTERM.
  const timers = SRC.match(/setTimeout\(|setInterval\(/g) || [];
  const unrefs = SRC.match(/\.unref\?\.\(\)/g) || [];
  assert.equal(timers.length, unrefs.length,
    'every timer must be unref\'d');
});

test('#892: schema documents the unknown outcome the sweeper writes', () => {
  const schema = read('src/db/schema.sql');
  assert.match(schema, /plus 'unknown' set by the/,
    'the outcome vocabulary comment must mention the swept value');
});
