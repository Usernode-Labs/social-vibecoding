'use strict';

// Change 4930 was promoted with its checks never started: a recovered build
// that deployed fresh staging marked the verdict pending and stopped, and the
// promote kick trusted that pending verdict. These pin both halves, and the
// board-change hook that leaked a preview run's guarded pool into a timer.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('a recovered turn that deploys fresh staging starts the checks against it', () => {
  const start = SERVER_SRC.indexOf("log.info('server', 'Orphan finalized'");
  assert.ok(start > 0, 'the fresh-staging recovery branch exists');
  const end = SERVER_SRC.indexOf('describeStagingFailure', start);
  const branch = SERVER_SRC.slice(start, end);
  assert.match(branch,
    /visuals\.captureForSession\(config, session, app, result\.sha, stagingResult, \{ send: \(\) => \{\}, trigger: 'boot-reconcile' \}\)/);
  assert.match(branch, /\.catch\(/, 'a capture failure never fails the recovery');
});

test('the Workshop board-change hook arms its reconcile outside any preview run', () => {
  assert.match(SERVER_SRC,
    /ws\.onBoardChange\(\(info\) => previewLifecycle\.detach\(\(\) => workshopThemes\.noteBoardChange\(getPool\(config\), info\)\)\)/);
});

test('the promote kick re-runs a pending verdict that nothing will settle', () => {
  const { strandedPendingChecks } = require('../src/routes/votes');
  const idle = {
    visuals: { hasInFlightCapture: () => false },
    activeWorkers: { hasSessionOperation: () => false, activeWorkers: new Map() },
  };
  const pending = { id: 4930, check_state: 'pending', check_phase: 'building' };
  assert.equal(strandedPendingChecks(pending, idle), true);

  assert.equal(strandedPendingChecks({ ...pending, check_state: 'passed' }, idle), false);
  assert.equal(strandedPendingChecks({ ...pending, check_state: null }, idle), false, 'no verdict is the existing kick');
  assert.equal(strandedPendingChecks({ ...pending, check_phase: 'deferred' }, idle), false,
    'a conflict-deferred verdict waits for the head to measure clean');
  assert.equal(strandedPendingChecks(pending, { ...idle, visuals: { hasInFlightCapture: (id) => id === 4930 } }), false,
    'a capture running or queued will settle it');
  assert.equal(strandedPendingChecks(pending, {
    ...idle, activeWorkers: { hasSessionOperation: (id) => id === 4930, activeWorkers: new Map() },
  }), false, 'an operation holding the change settles it');
  assert.equal(strandedPendingChecks(pending, {
    ...idle, activeWorkers: { hasSessionOperation: () => false, activeWorkers: new Map([[4930, {}]]) },
  }), false, 'a turn\'s tail runs its own capture');
});

test('the promote kick consults the stranded-pending rule', () => {
  const votesSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'votes.js'), 'utf8');
  assert.match(votesSrc, /let needsKick = !session\.check_state \|\| strandedPendingChecks\(session\);/);
});

test('no visual-evidence run on a change reads as none', () => {
  const orchestrator = require('../src/services/visual-evidence-orchestrator');
  assert.equal(orchestrator.inFlightRunFor(987654), null);
});
