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
  // Anchored FROM the build gate's own comment: runScoutTool now has its own
  // `const runLocally =` earlier in the file, so a bare indexOf would slice
  // backwards and silently match nothing.
  const at = sessions.indexOf('#907: is a coding agent on the user');
  const gate = sessions.slice(at, sessions.indexOf('const runLocally =', at));
  assert.match(gate, /if \(!headless && !isCodexSession\)/,
    'headless and OpenRouter turns both stay on their provider-owned worker path');
  assert.match(sessions, /const runLocally = !!lease;/);
});

test('an abandoned local turn is reported, not re-run on a worker', () => {
  // Since headless turns never run locally, the local build has no headless
  // retry to make: a branch for one could never run.
  const call = 'result = await dispatchLocalBuild();';
  const at = sessions.indexOf(call);
  assert.ok(at > 0, 'found the local build dispatch');
  const branch = sessions.slice(at + call.length, sessions.indexOf('} else {', at));
  assert.equal(branch.includes('shouldRetryHeadlessTurn'), false, 'no headless retry on the local path');
  assert.equal(branch.includes('dispatchLocalBuild'), false, 'the local build is dispatched once');
  // Nothing re-routes an abandoned turn to a worker container; its result is
  // the "disconnected before finishing" card, so no comment may promise one.
  const service = fs.readFileSync(path.join(root, 'src/services/local-agent.js'), 'utf8');
  assert.doesNotMatch(service, /re-routes an\s+(?:\/\/\s*)?abandoned turn/);
  assert.doesNotMatch(service, /platform-worker fallback/);
});

test('a lease lookup failure downgrades to a worker rather than failing the turn', () => {
  // Anchored FROM the build gate's own comment: runScoutTool now has its own
  // `const runLocally =` earlier in the file, so a bare indexOf would slice
  // backwards and silently match nothing.
  const at = sessions.indexOf('#907: is a coding agent on the user');
  const gate = sessions.slice(at, sessions.indexOf('const runLocally =', at));
  assert.match(gate, /catch \(err\)/);
  assert.match(gate, /using worker/i);
});

test('a local run skips the worker image, the container and the volume', () => {
  assert.match(sessions, /if \(!runLocally\) await worker\.ensureWorkerImage\(\);/);
  // The bootstrap catch (#1501) turned the ternary into a guarded block, so
  // the assertion moved with it. Same guarantee: no container is bootstrapped
  // for a run happening on the user's own machine.
  assert.match(sessions, /let containerName = null;\n  if \(!runLocally\) \{\n    try \{\n      containerName = await worker\.ensureWorker/);
  assert.match(sessions, /if \(!runLocally\) await worker\.syncUserAgentFiles/);
});

test('a lease that lapses between routing and dispatch is reported, not dereferenced', () => {
  assert.match(dispatch, /if \(!queued\)/);
  assert.match(dispatch, /disconnected before this turn started/);
});

test('outcomes the platform owns are explained in the user\'s own words', () => {
  // The live waiter and restart recovery shape a finished turn with the same
  // function (localAgent.buildTurnResult), so a recovered turn reaches the
  // tail exactly as a live one does.
  assert.match(dispatch, /localAgent\.buildTurnResult\(\{[\s\S]{0,200}mode: 'build'/);
  const { buildTurnResult } = require('../src/services/local-agent');
  const turn = { id: 11, error_detail: 'checkout is dirty', summary: '', head_sha: null };
  for (const [outcome, words] of [
    ['declined', "Evan's laptop declined this turn: checkout is dirty"],
    ['abandoned', "Evan's laptop disconnected before finishing this turn: checkout is dirty"],
    ['stopped', 'Stopped: checkout is dirty'],
    ['missing', 'The local turn record disappeared: checkout is dirty'],
    ['aborted', "Evan's laptop was interrupted: checkout is dirty"],
  ]) {
    const result = buildTurnResult({ turn, outcome, label: "Evan's laptop" });
    assert.equal(result.fatalError, words, `explains ${outcome}`);
    assert.equal(result.ccIsError, true);
  }
  // 'completed' and 'failed' deliberately fall through to the shared tail:
  // one needs no explanation and the other already carries the runtime's own
  // error text.
  for (const outcome of ['completed', 'failed']) {
    assert.equal(buildTurnResult({ turn, outcome, label: 'x' }).fatalError, null);
  }
  const built = buildTurnResult({
    turn: { id: 12, head_sha: 'a'.repeat(40), summary: 'Added it.' }, outcome: 'completed', label: 'x', behind: 3,
  });
  for (const field of [
    'sha', 'ahead', 'behind', 'pushOk', 'exitCode', 'ccIsError',
    'fatalError', 'lastResultText', 'rawStderr', 'sessionId',
    'initSessionId', 'markerlessCause',
  ]) {
    assert.ok(field in built, `missing ${field}`);
  }
  assert.deepEqual(
    [built.sha, built.ahead, built.behind, built.pushOk, built.exitCode, built.lastResultText, built.localTurnId],
    ['a'.repeat(40), 1, 3, true, 0, 'Added it.', '12'],
  );
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
    sessions.indexOf("if (action === 'force_orphan')"),
    sessions.indexOf("if (action === 'force_without_stop')")
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

// ── scout / read-only turns ────────────────────────────────────────────────

// The block of runScoutTool that dispatches a local scout turn.
const scoutDispatch = sessions.slice(
  sessions.indexOf('const dispatchLocalScout = async ()'),
  sessions.indexOf('let result;', sessions.indexOf('const dispatchLocalScout = async ()'))
);

test('the local scout dispatch returns every field the scout tail reads', () => {
  assert.ok(scoutDispatch.length > 200, 'found the dispatchLocalScout block');
  for (const field of [
    'exitCode', 'ccIsError', 'fatalError', 'lastResultText',
    'sessionId', 'initSessionId', 'markerlessCause',
  ]) {
    assert.match(scoutDispatch, new RegExp(`\\b${field}:`), `missing ${field}`);
  }
  assert.match(scoutDispatch, /mode: 'scout'/, 'the turn is enqueued as a scout turn');
});

test('both dispatches name the turn work item that waits for them, so its next claim carries them on', () => {
  // services/turns.js: a conversation's turn is one work item, and the local
  // turn it dispatched is taken over by that item's next claim when its
  // process goes (localAgent.takeOverOwnedTurn), never by the leader's pass.
  for (const [name, block] of [['build', dispatch], ['scout', scoutDispatch]]) {
    const enqueue = block.slice(block.indexOf('localAgent.enqueueTurn(pool, {'));
    assert.match(enqueue.slice(0, enqueue.indexOf('});')), /\n\s+owner,\n/, `the ${name} dispatch passes its owner`);
  }
  for (const fn of ['async function runClaudeCodeTool(', 'async function runScoutTool(']) {
    const head = sessions.slice(sessions.indexOf(fn), sessions.indexOf(') {', sessions.indexOf(fn)));
    assert.match(head, /\n\s+owner = null,\n/, `${fn} takes the owner its caller hands it`);
  }
});

test('a local scout invokes NONE of the commit or staging machinery', () => {
  // This is the read-only completion path stated as an absence. A scout turn
  // that reached any of these would be putting unreviewed code on the managed
  // branch, or building a preview of a commit that does not exist.
  //
  // Comments are stripped first: a comment EXPLAINING that a step is absent
  // must not read as the step being present.
  const code = scoutDispatch.split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  for (const forbidden of [
    'sha:', 'ahead:', 'pushOk:', 'head_sha',
    'runStaging', 'captureForSession', 'applyPrMetadata', 'createProposalCommit',
  ]) {
    assert.equal(
      code.includes(forbidden), false,
      `the scout dispatch must not touch ${forbidden}`
    );
  }
  // And it says so, so the absence reads as deliberate to the next person.
  assert.match(scoutDispatch, /read-only/);
});

test('a local scout writes the spec back exactly as a cloud scout does', () => {
  // Both venues feed the same receipt-backed publication helper. It writes
  // spec_md, snapshots a frozen version and gives the caller the metadata for
  // spec_updated; local execution only adds runner metadata to that receipt.
  assert.match(scoutDispatch, /localAgent\.buildTurnResult\(\{[\s\S]{0,120}mode: 'scout'/);
  const { buildTurnResult } = require('../src/services/local-agent');
  const scout = buildTurnResult({
    turn: { id: 13, spec_md: '# The spec', summary: 'closing words' }, outcome: 'completed', label: 'x', mode: 'scout',
  });
  assert.equal(scout.lastResultText, '# The spec', 'the spec is the result text, not the summary');
  // Read-only: a scout's result carries nothing the commit tail would act on.
  for (const field of ['sha', 'ahead', 'pushOk']) assert.equal(field in scout, false, `scout result has ${field}`);
  const publication = sessions.slice(
    sessions.indexOf('async function persistScoutPublication'),
    sessions.indexOf('// Copy the user\'s DEFAULT coding-agent backend')
  );
  assert.match(publication, /UPDATE chat_sessions SET spec_md = \$1/);
  assert.match(publication, /snapshotSessionSpec\(/);
  const scoutTail = sessions.slice(
    sessions.indexOf('async function runScoutTool'),
    sessions.indexOf('function describeMarkerlessExit')
  );
  assert.match(scoutTail, /persistScoutPublication\(\{[\s\S]{0,300}content: ccText/);
  assert.match(scoutTail, /localAgentLabel: runLocally \? lease\.label : null/);
});

test('a local scout skips the worker image, the container and the volume too', () => {
  const scout = sessions.slice(
    sessions.indexOf('async function runScoutTool'),
    sessions.indexOf('function describeMarkerlessExit')
  );
  assert.match(scout, /if \(!runLocally\) await worker\.ensureWorkerImage\(\);/);
  assert.match(scout, /let containerName = null;\n  if \(!runLocally\) \{\n    try \{\n      containerName = await worker\.ensureWorker/);
  assert.match(scout, /if \(!runLocally\) await worker\.syncUserAgentFiles/);
  // A local scout never gets prod-debug: the credential is cloud-only, so the
  // prompt must not advertise a helper the machine cannot authenticate.
  assert.match(scout, /if \(runLocally\) prodDebug = false;/);
  // …nor the worker-image-only issues helper.
  assert.match(scout, /const issueHelperNote = runLocally/);
});

test('a local scout is never routed for a headless run', () => {
  // Same reasoning as the build path: an unattended issue-triage run must not
  // wait out a 90-second offer timeout on a laptop nobody is watching.
  const scout = sessions.slice(
    sessions.indexOf('async function runScoutTool'),
    sessions.indexOf('function describeMarkerlessExit')
  );
  const gate = scout.slice(
    scout.indexOf('#907: a scout turn follows'),
    scout.indexOf('const runLocally =')
  );
  assert.match(gate, /if \(!headless && !isCodexSession\) \{/,
    'headless and OpenRouter scouts never delegate to a local Claude lease');
  assert.match(gate, /catch \(err\)/, 'and a lookup failure downgrades to a worker');
});

test('both scout and build report their mode, and both name the machine', () => {
  assert.match(sessions, /mode: 'scout',[\s\S]{0,200}recordTurnEvent|recordTurnEvent\(pool, \{[\s\S]{0,200}mode: 'scout'/);
  assert.match(sessions, /recordTurnEvent\(pool, \{[\s\S]{0,200}mode: 'build'/);
  // The transcript rows are how a reader tells the two apart months later,
  // and both state that the platform did not pay for the work.
  assert.match(sessions, /Drafted on \$\{localAgentLabel\}, so no Homeroom credits were used/);
  assert.match(sessions, /localAgentLabel: runLocally \? lease\.label : null/);
  assert.match(sessions, /Coding done on \$\{lease\.label\}, so no Homeroom credits were used/);
});

test('the local scout produces no cost at all, rather than a zeroed one', () => {
  // costUsd is simply absent from the local result, so the settle/usage block
  // is skipped entirely. A `runLocally ? 0 : cost` would still write an
  // llm_usage row claiming the platform spent nothing on a real call.
  assert.equal(/\bcostUsd:/.test(scoutDispatch), false);
  const scout = sessions.slice(
    sessions.indexOf('async function runScoutTool'),
    sessions.indexOf('function describeMarkerlessExit')
  );
  assert.match(scout, /if \(result\.costUsd\) \{/);
  assert.equal(/runLocally \? 0 :/.test(scout), false);
});

test('stopping a local scout uses the same cooperative signal as a build', () => {
  // stopHandle.localTurnId is what the stop route keys on, and it is
  // mode-agnostic — so scout inherits stop, abandon and the watchdog with no
  // second code path to keep in sync.
  assert.match(scoutDispatch, /stopHandle\.localTurnId = String\(turnId\)/);
  assert.match(dispatch, /stopHandle\.localTurnId = String\(turnId\)/);
});

test('the handoff pipeline is shared, not forked', () => {
  // Extracting it is the reason a local turn gets the same staging build and
  // proposal checks as an MCP handoff: both hand the commit to the preview
  // machine through it. If either caller grows its own copy, the two flows
  // drift.
  for (const fn of [
    'hasInFlightHandoffPipeline',
    'beginHandoffPipeline',
    'startHandoffPipeline',
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
