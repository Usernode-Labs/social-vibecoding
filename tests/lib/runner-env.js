'use strict';

// What every test that runs a worker runner (worker/run-cc.sh,
// worker/run-codex-agent.sh) adds to its env. The runner pushes through
// usernode-push, which tries again after pauses that come to about two
// minutes when the platform cannot be reached (a restart). A test's
// PLATFORM_URL never answers, so without this each push waited the pauses
// out and the suite ran into its 180 s timeout. `0` is one pause of nothing
// (an empty value would mean the default pauses). The guard in
// tests/runner-env-guard.test.js holds every runner test to it.
module.exports = { RUNNER_TEST_ENV: Object.freeze({ USERNODE_PUSH_BACKOFF: '0' }) };
