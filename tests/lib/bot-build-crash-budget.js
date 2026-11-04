'use strict';

// The crash suite's own clock (tests/bot-build-crash-postgres.test.js), and
// the room it leaves under the test runner's per-file limit (`npm test`'s
// --test-timeout=180000). Kept here so the suite and the test that pins the
// arithmetic read the same numbers.
//
// The budget is when the suite stops STARTING kill points; a build already
// under way may still go THIS LONG after that before it is called stuck and
// killed (the lanes' deadline). Teardown then stops the last child and drops
// each lane's database. Budget + grace + teardown must end well inside the
// runner's limit: a file cut off by the runner fails every change whose
// checks it is part of, whatever the change did.
const RUNNER_LIMIT_MS = 180000;
// 120 s of kill points, then 10 s for a stuck build to notice and stop.
const BUDGET_MS = 120000;
const GRACE_MS = 10000;
// lane.close (5 s stop grace) plus a FORCE drop of each lane's database and
// the schema template.
const TEARDOWN_MS = 20000;
// What the suite wants free under the runner's limit, at the least: it must
// never reach it, and the margin is what a busy machine eats.
const MIN_MARGIN_MS = 30000;

module.exports = {
  RUNNER_LIMIT_MS,
  BUDGET_MS,
  GRACE_MS,
  TEARDOWN_MS,
  MIN_MARGIN_MS,
};
