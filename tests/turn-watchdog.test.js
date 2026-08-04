// Tests for the stuck-at-"Pushing" fixes (sessions 2391/2386 incident):
//
//   1. Unit tests for the pure stale active_turn watchdog policy
//      (src/services/turn-watchdog.js) — reap/skip decisions and the
//      terminal progress-line append helper.
//   2. Unit tests for the shared busy predicate
//      (active-workers.isSessionBusy) — a session registered in
//      activeWorkers must read busy even when the warm-registry
//      inFlight flag is off (that gap is what let the auto-pause
//      sweeper destroy workers mid-wrap-up).
//   3. Source guards — the sweepers in server.js must use the shared
//      predicate + the active_turn SQL guard, run-cc.sh must emit the
//      terminal phase markers, and the push-failure path in
//      routes/sessions.js must heal-then-error instead of warning.
//
// Run with: node --test tests/turn-watchdog.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  STALE_TURN_MIN_AGE_MS,
  TERMINAL_PROGRESS_LINES,
  classifyStaleTurn,
  appendTerminalLine,
} = require('../src/services/turn-watchdog');

const {
  activeWorkers,
  beginSessionOperation,
  getActiveWorkerCount,
  isSessionBusy,
} = require('../src/services/active-workers');
const worker = require('../src/services/worker');

// ── 1a. classifyStaleTurn policy ────────────────────────────────────────

const NOW = Date.parse('2026-07-17T12:00:00Z');
const OLD = new Date(NOW - STALE_TURN_MIN_AGE_MS - 1000).toISOString();
const FRESH = new Date(NOW - 30 * 1000).toISOString();

test('classifyStaleTurn: no active_turn row is a no-op', () => {
  assert.equal(
    classifyStaleTurn({ activeTurn: null, nowMs: NOW, busy: false, executing: false }),
    'skip_no_turn'
  );
});

test('classifyStaleTurn: fresh rows are skipped (boot/dispatch race guard)', () => {
  assert.equal(
    classifyStaleTurn({ activeTurn: { startedAt: FRESH }, nowMs: NOW, busy: false, executing: false }),
    'skip_fresh'
  );
});

test('classifyStaleTurn: a busy session is never reaped, however old the row', () => {
  assert.equal(
    classifyStaleTurn({ activeTurn: { startedAt: OLD }, nowMs: NOW, busy: true, executing: false }),
    'skip_busy'
  );
});

test('classifyStaleTurn: a live detached exec is left for recovery', () => {
  assert.equal(
    classifyStaleTurn({ activeTurn: { startedAt: OLD }, nowMs: NOW, busy: false, executing: true }),
    'skip_executing'
  );
});

test('classifyStaleTurn: an unobservable probe (null) is treated conservatively', () => {
  assert.equal(
    classifyStaleTurn({ activeTurn: { startedAt: OLD }, nowMs: NOW, busy: false, executing: null }),
    'skip_executing'
  );
});

test('classifyStaleTurn: old + not busy + definitely idle → reap', () => {
  assert.equal(
    classifyStaleTurn({ activeTurn: { startedAt: OLD }, nowMs: NOW, busy: false, executing: false }),
    'reap'
  );
});

test('classifyStaleTurn: unparsable startedAt cannot prove freshness', () => {
  // Missing/garbage timestamps fall through to the busy/executing gates.
  assert.equal(
    classifyStaleTurn({ activeTurn: {}, nowMs: NOW, busy: false, executing: false }),
    'reap'
  );
  assert.equal(
    classifyStaleTurn({ activeTurn: { startedAt: 'not-a-date' }, nowMs: NOW, busy: true, executing: false }),
    'skip_busy'
  );
});

// ── 1b. appendTerminalLine ──────────────────────────────────────────────

test('appendTerminalLine: appends the marker and reports it did', () => {
  const lines = ['[commit]', '[push]'];
  assert.equal(appendTerminalLine(lines, '[done]'), true);
  assert.deepEqual(lines, ['[commit]', '[push]', '[done]']);
});

test('appendTerminalLine: dedups an identical trailing marker (new worker images emit their own)', () => {
  const lines = ['[push]', '[done]'];
  assert.equal(appendTerminalLine(lines, '[done]'), false);
  assert.deepEqual(lines, ['[push]', '[done]']);
});

test('appendTerminalLine: a healed push overwrites [push_failed] with [done]', () => {
  const lines = ['[push]', '[push_failed]'];
  assert.equal(appendTerminalLine(lines, '[done]'), true);
  assert.equal(lines[lines.length - 1], '[done]');
});

test('appendTerminalLine: non-array input is a safe no-op', () => {
  assert.equal(appendTerminalLine(null, '[done]'), false);
  assert.equal(appendTerminalLine(undefined, '[interrupted]'), false);
});

test('terminal markers all have a friendly label in cc-progress-summary', () => {
  const { ccPhaseLabel } = require('../public/js/cc-progress-summary.js');
  for (const marker of TERMINAL_PROGRESS_LINES) {
    const phase = marker.slice(1, -1);
    // Every terminal marker must map to a friendly label, not fall back
    // to the raw phase text.
    assert.notEqual(ccPhaseLabel(phase), phase, `no label mapping for ${marker}`);
  }
});

// ── 2. isSessionBusy (shared busy predicate) ────────────────────────────

test('isSessionBusy: activeWorkers membership alone means busy (wrap-up window)', () => {
  const sessionId = 990777;
  assert.equal(worker.isInFlight(sessionId), false, 'precondition: not in warm registry');
  assert.equal(isSessionBusy(sessionId), false);
  activeWorkers.add(sessionId);
  try {
    assert.equal(isSessionBusy(sessionId), true);
  } finally {
    activeWorkers.delete(sessionId);
  }
  assert.equal(isSessionBusy(sessionId), false);
});

test('isSessionBusy: a non-worker session operation blocks turns until its idempotent release', () => {
  const sessionId = 990778;
  const before = getActiveWorkerCount();
  const release = beginSessionOperation(sessionId);
  assert.equal(isSessionBusy(sessionId), true);
  assert.equal(getActiveWorkerCount(), before + 1);
  release();
  release();
  assert.equal(isSessionBusy(sessionId), false);
  assert.equal(getActiveWorkerCount(), before);
});

// ── 3. Source guards ────────────────────────────────────────────────────

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const sessionsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'sessions.js'), 'utf8');
const runCcSrc = fs.readFileSync(path.join(__dirname, '..', 'worker', 'run-cc.sh'), 'utf8');

test('server.js sweepers use the shared busy predicate, not bare isInFlight', () => {
  // Pass 1 (auto-pause) and Pass 2 (staging GC) both gate on it.
  const uses = serverSrc.match(/activeWorkersSvc\.isSessionBusy\(row\.id\)/g) || [];
  assert.ok(uses.length >= 2, `expected >=2 isSessionBusy(row.id) gates, found ${uses.length}`);
  assert.match(serverSrc,
    /stagingReap\.sweepStale\(config, \{ isInFlight: \(id\) => activeWorkersSvc\.isSessionBusy\(id\) \}\)/,
    'stale-preview cleanup also respects non-worker session operations');
  assert.match(serverSrc,
    /if \(activeWorkersSvc\.isSessionBusy\(row\.id\)\) continue;[\s\S]{0,300}archiveSession/,
    'stale proposal archival cannot race a session-owned sync/pipeline tail');
  // The auto-pause SQL must exclude sessions with a live detached-turn record.
  assert.ok(
    /status = 'active'\s*\n\s*AND active_turn IS NULL/.test(serverSrc),
    "Pass 1 SQL must carry AND active_turn IS NULL"
  );
});

test('server.js recovery flow registers in activeWorkers and bumps last_activity_at', () => {
  assert.ok(
    /activeWorkersSvc\.activeWorkers\.add\(sessionId\)/.test(serverSrc),
    'resumeDetachedTurn must add the session to activeWorkers'
  );
  assert.ok(
    /activeWorkersSvc\.activeWorkers\.delete\(sessionId\)/.test(serverSrc),
    'resumeDetachedTurn must remove the session from activeWorkers'
  );
});

test('server.js has the stale active_turn watchdog pass', () => {
  assert.ok(/Reaping orphaned active_turn/.test(serverSrc), 'watchdog reap log line missing');
  assert.ok(/classifyStaleTurn/.test(serverSrc), 'watchdog must use the pure policy helper');
  // #896: the reaped-turn message is the shared TURN_UNFINISHED_BREADCRUMB
  // now — one wording for every unresumable shape, with the shape kept in
  // metadata.recoveredReason instead of in the text the user reads.
  //
  // ...with ONE exception: a reaped TAIL row (the agent finished, the
  // platform-side wrap-up didn't) knows the commit is already pushed, so
  // asking for a resend would send the user to redo landed work. It gets
  // the code-landed wording instead.
  assert.ok(
    /: recoveryPills\.TURN_UNFINISHED_BREADCRUMB/.test(serverSrc),
    'watchdog must post the retry system message for an unresumable exec'
  );
  assert.ok(
    /recoveryPills\.buildCodeLandedBreadcrumb\(/.test(serverSrc),
    'a reaped tail whose commit landed must not ask for a resend'
  );
  assert.ok(
    /recoveredReason: reapCodeLanded \? 'watchdog_reap_tail' : 'watchdog_reap'/.test(serverSrc),
    'the reap is still distinguishable from other recoveries in SQL'
  );
});

test('run-cc.sh emits terminal phase markers on scout and build paths', () => {
  const doneMarkers = runCcSrc.match(/__USERNODE_PHASE__ done/g) || [];
  assert.ok(doneMarkers.length >= 2, 'expected done markers on both scout and build paths');
  assert.ok(/__USERNODE_PHASE__ push_failed/.test(runCcSrc), 'push_failed marker missing');
  // The build-path marker must precede the __USERNODE_RESULT__ line so
  // the journal's last phase is terminal.
  const buildResultIdx = runCcSrc.indexOf('mode=build');
  const pushFailedIdx = runCcSrc.indexOf('__USERNODE_PHASE__ push_failed');
  assert.ok(pushFailedIdx !== -1 && pushFailedIdx < buildResultIdx,
    'terminal marker must be emitted before the build result line');
});

test('sessions.js heals a failed push, then errors instead of warning', () => {
  // The heal helper re-pushes from the platform side...
  assert.ok(
    /worker\.execPushFromWorker\(session\.id, session\.branch_name\)/.test(sessionsSrc),
    'push heal must call worker.execPushFromWorker'
  );
  // ...and the terminal-failure branch sits BEFORE the headless/interactive
  // success branches, so PR creation and staging are skipped entirely.
  const healBranchIdx = sessionsSrc.indexOf("else if (!result.pushOk && !(await healPush()))");
  const headlessBranchIdx = sessionsSrc.indexOf('} else if (headless) {');
  assert.ok(healBranchIdx !== -1, 'terminal push-failure branch missing');
  assert.ok(headlessBranchIdx !== -1, 'headless branch missing');
  assert.ok(healBranchIdx < headlessBranchIdx,
    'push-failure branch must precede the PR/staging success branches');
  // The old soft warnings are gone.
  assert.ok(!/Warning: push reported a failure/.test(sessionsSrc),
    'the soft push-failure warning must be replaced by the terminal error');
  assert.ok(/Push to GitHub failed — your changes are committed/.test(sessionsSrc),
    'the visible push-failure error message must exist');
});

test('sessions.js bumps last_activity_at when turns finish', () => {
  const bumps = sessionsSrc.match(/SET last_activity_at = NOW\(\) WHERE id = \$1/g) || [];
  // runScoutTool finally + runClaudeCodeTool finally.
  assert.ok(bumps.length >= 2, `expected >=2 turn-end activity bumps, found ${bumps.length}`);
});
