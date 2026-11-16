// #937: the pure decisions behind "stopping actually stops".
//
// Background: pressing Stop during a coding agent's spin-up used to do
// nothing at all. POST /stop fired ONE in-container kill; during spin-up
// there was no turn process to match, so it exited 0 while logging "Stop
// signal sent", and the agent then started and ran to completion —
// production session 2974 kept working for 17m51s after the click.
//
// Three rules fix that, and they're pure precisely so they can be pinned
// here without a docker daemon or a live turn (same pattern as
// services/turn-watchdog.js):
//
//   1. stopPendingFor       — the pre-dispatch gate, consulted between the
//      dispatch and the exec that starts the agent.
//   2. classifyStopProbe    — the confirm loop's verdict. The route no
//      longer assumes one kill worked; it probes and re-issues.
//   3. classifyStopRequest  — what POST /stop does with one request,
//      including the guard that keeps Force stop strictly second-order.
//
// Run with: node --test tests/stop-pending-gate.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STOP_PROBE_INTERVAL_MS,
  STOP_CONFIRM_TIMEOUT_MS,
  STOP_MAX_KILL_ATTEMPTS,
  classifyStopProbe,
} = require('../src/workflow/rules/worker-interrupt.ts');
const {
  classifyStopRequest,
  stopPendingFor,
} = require('../src/services/stop-policy');

// ── The pre-dispatch gate ───────────────────────────────────────────────

test('stopPendingFor: a stopped handle gates the dispatch', () => {
  assert.equal(stopPendingFor({ stopped: true, stoppedBy: 'evan' }), true);
});

test('stopPendingFor: a live handle does not', () => {
  assert.equal(stopPendingFor({ stopped: false, phase: 'cc' }), false);
});

test('stopPendingFor: a missing handle never gates', () => {
  // A turn may run without a stop handle. Gating it on an absent object
  // would break every such run — the failure mode this tolerance exists to
  // prevent.
  assert.equal(stopPendingFor(null), false);
  assert.equal(stopPendingFor(undefined), false);
});

test('stopPendingFor: only the boolean flag counts, not the phase', () => {
  // The gate deliberately ignores `phase`: a stop landing in the awaited
  // gap before setPhase('cc') is still a stop, and that gap is exactly
  // where stops used to be dropped entirely.
  assert.equal(stopPendingFor({ stopped: true, phase: 'mayor1' }), true);
  assert.equal(stopPendingFor({ stopped: true, phase: 'cc' }), true);
});

// ── The confirm loop's verdict ──────────────────────────────────────────

test('classifyStopProbe: a definite idle confirms the stop', () => {
  assert.equal(
    classifyStopProbe({ executing: false, attempts: 1, elapsedMs: 2000 }),
    'confirmed'
  );
});

test('classifyStopProbe: a live turn process re-issues the kill', () => {
  // THE case from the bug: the first kill found nothing because the agent
  // had not started yet, and the agent then appeared. Probing catches it.
  assert.equal(
    classifyStopProbe({ executing: true, attempts: 1, elapsedMs: 2000 }),
    'retry'
  );
});

test('classifyStopProbe: an unobservable probe re-issues too', () => {
  // null = the probe itself failed. After a stop request that is more
  // likely a wedged container than a healthy one, so lean toward killing
  // again rather than declaring success we cannot see.
  assert.equal(
    classifyStopProbe({ executing: null, attempts: 1, elapsedMs: 2000 }),
    'retry'
  );
});

test('classifyStopProbe: gives up once the kill attempts are spent', () => {
  assert.equal(
    classifyStopProbe({
      executing: true, attempts: STOP_MAX_KILL_ATTEMPTS, elapsedMs: 5000,
    }),
    'giveup'
  );
});

test('classifyStopProbe: gives up past the deadline', () => {
  assert.equal(
    classifyStopProbe({
      executing: true, attempts: 1, elapsedMs: STOP_CONFIRM_TIMEOUT_MS,
    }),
    'giveup'
  );
  assert.equal(
    classifyStopProbe({
      executing: null, attempts: 1, elapsedMs: STOP_CONFIRM_TIMEOUT_MS + 1,
    }),
    'giveup'
  );
});

test('classifyStopProbe: a late-landing stop still reads as confirmed', () => {
  // Ordering invariant: `executing === false` outranks BOTH bounds. A stop
  // that lands on the very last probe is a success, not a give-up — the
  // give-up log line is meant to name genuinely stuck workers only, so it
  // stays diagnostic rather than noisy.
  assert.equal(
    classifyStopProbe({
      executing: false,
      attempts: STOP_MAX_KILL_ATTEMPTS + 5,
      elapsedMs: STOP_CONFIRM_TIMEOUT_MS * 10,
    }),
    'confirmed'
  );
});

test('classifyStopProbe: the loop terminates from any starting state', () => {
  // Drive the real decision the way the route does — every 'retry' costs
  // one attempt and one interval — and assert it always halts. A policy
  // that could return 'retry' forever would pile docker execs onto a
  // wedged container indefinitely.
  for (const executing of [true, null]) {
    let attempts = 1;
    let elapsedMs = 0;
    let verdict;
    let guard = 0;
    do {
      elapsedMs += STOP_PROBE_INTERVAL_MS;
      verdict = classifyStopProbe({ executing, attempts, elapsedMs });
      if (verdict === 'retry') attempts += 1;
      assert.ok(++guard < 1000, 'policy must terminate');
    } while (verdict === 'retry');
    assert.equal(verdict, 'giveup');
    assert.ok(
      attempts <= STOP_MAX_KILL_ATTEMPTS,
      `sent ${attempts} kills — never more than ${STOP_MAX_KILL_ATTEMPTS}`
    );
  }
});

test('the confirm window outlasts the client wait that precedes Force stop', () => {
  // The client offers Force stop at 40s. The server must have finished
  // trying by then, or the user is handed an escape hatch while the
  // ordinary path is still working — two teardown routes racing on one
  // container.
  assert.ok(STOP_CONFIRM_TIMEOUT_MS <= 40000);
  assert.ok(STOP_PROBE_INTERVAL_MS < STOP_CONFIRM_TIMEOUT_MS);
});

// ── What POST /stop does with one request ───────────────────────────────

test('classifyStopRequest: an ordinary stop on a live turn', () => {
  assert.equal(
    classifyStopRequest({ handle: { phase: 'cc', stopped: false } }),
    'stop'
  );
});

test('classifyStopRequest: no handle means no active turn', () => {
  assert.equal(classifyStopRequest({ handle: null }), 'no_active_turn');
  assert.equal(classifyStopRequest({ handle: undefined }), 'no_active_turn');
});

test('classifyStopRequest: force is refused unless a stop is already pending', () => {
  // THE guard on the escape hatch. Force destroys the worker container, so
  // it may only ever be the second thing that happens — never the first.
  assert.equal(
    classifyStopRequest({ handle: { phase: 'cc', stopped: false }, force: true }),
    'force_without_stop'
  );
});

test('classifyStopRequest: force is honoured once a stop is pending', () => {
  assert.equal(
    classifyStopRequest({ handle: { phase: 'cc', stopped: true }, force: true }),
    'force'
  );
});

test('classifyStopRequest: force with no handle cleans up an orphan', () => {
  // The turn already ended but its bookkeeping (active_turn, activeWorkers,
  // the container) may not have. There is no ordinary stop to precede the
  // force here, so the guard above must not apply.
  assert.equal(classifyStopRequest({ handle: null, force: true }), 'force_orphan');
});
