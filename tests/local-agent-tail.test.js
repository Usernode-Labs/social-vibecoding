// The platform half of a locally-run turn (#907).
//
// The promise this feature makes is that moving where the model call happens
// changes NOTHING else: the same push heal, PR metadata, staging build,
// checks, visuals, completion card and Mayor wrap-up run afterwards. That is
// only true because the local dispatch returns a result shaped exactly like
// execInWorker's, so the shared tail cannot tell the difference.
//
// This suite reads the wiring in src/routes/sessions.js and the extracted
// pipeline module rather than booting a worker, because what is being
// protected is the shape of the seam, not any single line's behaviour.
//
// Run with: node --test tests/local-agent-tail.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const sessions = fs.readFileSync(path.join(root, 'src/routes/sessions.js'), 'utf8');
const pipeline = fs.readFileSync(path.join(root, 'src/services/handoff-pipeline.js'), 'utf8');

// The block of runClaudeCodeTool that dispatches a local turn.
const dispatch = sessions.slice(
  sessions.indexOf('const dispatchLocalBuild = async ()'),
  sessions.indexOf('let result;', sessions.indexOf('const dispatchLocalBuild = async ()'))
);

test('the local dispatch returns every field the shared tail reads', () => {
  assert.ok(dispatch.length > 200, 'found the dispatchLocalBuild block');
  for (const field of [
    'sha', 'ahead', 'behind', 'pushOk', 'exitCode', 'ccIsError',
    'fatalError', 'lastResultText', 'rawStderr', 'sessionId',
    'initSessionId', 'markerlessCause',
  ]) {
    assert.match(dispatch, new RegExp(`\\b${field}:`), `missing ${field}`);
  }
});

test('pushOk is true because the commits already went through the GitHub App', () => {
  // A local agent has no push access by design: its commits reached the
  // branch via POST /api/cli/agent/turns/:id/commit, which the platform
  // reconstructs with its own App installation. Claiming a failed push here
  // would send the tail into the push-heal path with nothing to heal.
  assert.match(dispatch, /pushOk: true/);
});

test('a local turn is never routed for a headless run', () => {
  // A scheduled turn has nobody watching. Offering it to a machine that may
  // be asleep converts a reliable background build into a 90s offer timeout.
  const gate = sessions.slice(
    sessions.indexOf('#907: is a coding agent on the user'),
    sessions.indexOf('const runLocally =')
  );
  assert.match(gate, /if \(!headless\)/);
  assert.match(sessions, /const runLocally = !!lease;/);
});

test('a lease lookup failure downgrades to a worker rather than failing the turn', () => {
  const gate = sessions.slice(
    sessions.indexOf('#907: is a coding agent on the user'),
    sessions.indexOf('const runLocally =')
  );
  assert.match(gate, /catch \(err\)/);
  assert.match(gate, /using worker/i);
});

test('a local run skips the worker image, the container and the volume', () => {
  assert.match(sessions, /if \(!runLocally\) await worker\.ensureWorkerImage\(\);/);
  assert.match(sessions, /const containerName = runLocally \? null : await worker\.ensureWorker/);
  assert.match(sessions, /if \(!runLocally\) await worker\.syncUserAgentFiles/);
});

test('a lease that lapses between routing and dispatch is reported, not dereferenced', () => {
  assert.match(dispatch, /if \(!queued\)/);
  assert.match(dispatch, /disconnected before this turn started/);
});

test('outcomes the platform owns are explained in the user\'s own words', () => {
  for (const outcome of ['declined', 'abandoned', 'stopped', 'missing', 'aborted']) {
    assert.match(dispatch, new RegExp(`\\b${outcome}:`), `unexplained outcome ${outcome}`);
  }
  // 'completed' and 'failed' deliberately fall through to the shared tail:
  // one needs no explanation and the other already carries the runtime's own
  // error text.
  assert.equal(/\n\s+completed: /.test(dispatch), false);
});

test('progress from the machine goes through the same sink as the worker\'s', () => {
  // onAgentProgress is where the phase marker (#892), the estimator teardown
  // (#891) and the persisted progress log all live. A second sink would give
  // local runs a subtly different progress card.
  assert.match(dispatch, /onAgentProgress\(/);
  assert.match(sessions, /onProgress: onAgentProgress,/);
});

test('progress lines are streamed once, not re-sent on every poll', () => {
  assert.match(dispatch, /slice\(seenLocalLines\)/);
  assert.match(dispatch, /seenLocalLines = Math\.max\(seenLocalLines, lines\.length\)/);
});

test('stopping a local turn does not go hunting for a container that never existed', () => {
  const stop = sessions.slice(
    sessions.indexOf('if (handle.localTurnId) {'),
    sessions.indexOf('if (handle.localTurnId) {') + 900
  );
  assert.match(stop, /localAgent\.requestStop/);
  // confirmStopLanded would probe a container this turn never had, and log a
  // kill it never sent.
  assert.match(sessions, /if \(!handle\.localTurnId && stopPolicy\.killsWorkerInPhase/);
});

test('the force-orphan stop path also releases a local turn', () => {
  const orphan = sessions.slice(
    sessions.indexOf('force_orphan'),
    sessions.indexOf('force_orphan') + 2000
  );
  assert.match(orphan, /localAgent\.requestStop/);
});

test('every turn records where it ran, and a local one records an event', () => {
  assert.match(sessions, /localAgent\.recordTurnRunner\(/);
  assert.match(sessions, /runLocally \? 'local' : 'platform'/);
  assert.match(sessions, /if \(runLocally\) \{[\s\S]{0,200}recordTurnEvent/);
});

test('the status endpoint answers with the runner and the attached machine', () => {
  assert.match(sessions, /last_turn_runner/);
  assert.match(sessions, /localAgent\.publicLease\(await localAgent\.activeLease/);
  assert.match(sessions, /localAgentDemo\.isStagingDemo\(req\)/);
});

test('the handoff pipeline is shared, not forked', () => {
  // Extracting it is the reason a local turn gets the same staging build and
  // proposal checks as an MCP handoff. If either caller grows its own copy,
  // the two flows drift.
  for (const fn of [
    'serializeHandoffSubmission',
    'hasInFlightHandoffPipeline',
    'beginHandoffPipeline',
    'startHandoffPipeline',
    'discardHandoffStaging',
    'runStaging',
  ]) {
    assert.match(pipeline, new RegExp(`\\b${fn}\\b`), `pipeline must export ${fn}`);
  }
  const handoff = fs.readFileSync(path.join(root, 'src/routes/proposal-handoff.js'), 'utf8');
  assert.match(handoff, /require\('\.\.\/services\/handoff-pipeline'\)/,
    'proposal-handoff must consume the extracted module, not keep a copy');
});

test('the extracted pipeline still excludes imported sessions from ownership checks', () => {
  assert.match(pipeline, /source IS DISTINCT FROM 'imported'/);
});
