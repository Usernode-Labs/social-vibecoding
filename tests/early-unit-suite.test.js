'use strict';

// services/early-unit-suite.js — the repo unit suite, started with the
// preview build instead of after it.
//
// The unit suite clones the repo itself and never touches the preview, yet
// it waited about 70s for the preview's build and boot before it started,
// in front of a 168s suite that was already the longest part of every run
// on the platform's own app (8–10 Oct 2026). Pinned here:
//
//   * it starts only for a head whose checks are pending, on Kubernetes,
//     while fewer unit suites run than the checks queue lets runs go;
//   * one per session: the same head joins it, a newer head stops it;
//   * the checks run that follows takes it over, once, and hears its
//     progress; a run cancelled under it stops it;
//   * nobody taking it over in time stops it, and stopping deletes its Job,
//     which the preview lifecycle does not do for it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
delete process.env.EARLY_UNIT_SUITE;

const early = require('../src/services/early-unit-suite');
const kubernetes = require('../src/services/kubernetes');

const SHA = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const config = { workerRuntime: 'kubernetes', kubernetes: { workerNamespace: 'w' } };
const app = { id: 10, repo_url: 'https://github.com/Usernode-Labs/social-vibecoding' };
const session = { id: 7652, source: 'cli_handoff' };

function poolFor(row = {}) {
  return {
    async query() {
      return { rows: [{ id: 7652, status: 'active', check_state: 'pending', checks_commit_sha: SHA, source: 'cli_handoff', pr_number: 4667, ...row }] };
    },
  };
}

function setup(t, { running = 0, unitEnabled = true } = {}) {
  early._runs.clear();
  const deleted = [];
  const started = [];
  const resolvers = [];
  t.mock.method(kubernetes, 'deleteCheckJob', async (cfg, name) => { deleted.push(name); return true; });
  t.mock.method(kubernetes, 'countRunningUnitSuiteJobs', async () => running);
  const unitSuite = {
    isEnabled: () => unitEnabled,
    // As the real one: an aborted run rejects with its signal's reason.
    maybeRunUnitSuite: (args) => {
      started.push(args);
      return new Promise((resolve, reject) => {
        resolvers.push(resolve);
        args.signal.addEventListener('abort', () => reject(args.signal.reason), { once: true });
      });
    },
  };
  const deps = { unitSuite, kubernetes, checksQueue: { maxConcurrentRuns: () => 4 } };
  t.after(() => early._runs.clear());
  return { deleted, started, resolvers, deps };
}

test('starts for a head whose checks are pending, under a Job name of its own', async (t) => {
  const { started, deps } = setup(t);
  const entry = await early.maybeStart(config, { session, app, commitHash: SHA, pool: poolFor(), deps });
  assert.ok(entry);
  assert.equal(started.length, 1);
  const args = started[0];
  assert.equal(args.ref, SHA, 'a hand-off is checked at its exact commit');
  assert.equal(args.repoOwner, 'Usernode-Labs');
  assert.equal(args.repoName, 'social-vibecoding');
  assert.equal(args.prNumber, 4667);
  assert.equal(args.jobNamePrefix, 'sv-unit-early');
  assert.equal(args.previewRunId, entry.runId);
  assert.ok(args.signal instanceof AbortSignal);
  assert.equal(early.jobName(7652, entry.runId), `sv-unit-early-s7652-${entry.runId}`);
});

test('does not start where it should not', async (t) => {
  const { started, deps } = setup(t);
  const cases = [
    [{ ...config, workerRuntime: 'docker' }, poolFor(), SHA, 'a docker run has no Job to start early'],
    [config, poolFor(), 'latest', 'an unresolved head'],
    [config, poolFor({ check_state: 'passing' }), SHA, 'checks not pending'],
    [config, poolFor({ checks_commit_sha: NEXT }), SHA, 'checks pinned to another head'],
    [config, poolFor({ status: 'archived' }), SHA, 'a session that cannot be judged'],
  ];
  for (const [cfg, pool, commitHash, why] of cases) {
    assert.equal(await early.maybeStart(cfg, { session, app, commitHash, pool, deps }), null, why);
  }
  process.env.EARLY_UNIT_SUITE = '0';
  try {
    assert.equal(await early.maybeStart(config, { session, app, commitHash: SHA, pool: poolFor(), deps }), null, 'switched off');
  } finally { delete process.env.EARLY_UNIT_SUITE; }
  assert.equal(started.length, 0);
});

test('does not start while the cluster already runs as many unit suites as the queue lets runs go', async (t) => {
  for (const running of [4, 9, null]) {
    const { started, deps } = setup(t, { running });
    assert.equal(await early.maybeStart(config, { session, app, commitHash: SHA, pool: poolFor(), deps }), null, String(running));
    assert.equal(started.length, 0);
  }
  const { started, deps } = setup(t, { running: 3 });
  assert.ok(await early.maybeStart(config, { session, app, commitHash: SHA, pool: poolFor(), deps }));
  assert.equal(started.length, 1);
});

test('one per session: the same head joins it, a newer head stops it and starts its own', async (t) => {
  const { started, deleted, deps } = setup(t);
  const first = await early.maybeStart(config, { session, app, commitHash: SHA, pool: poolFor(), deps });
  const again = await early.maybeStart(config, { session, app, commitHash: SHA, pool: poolFor(), deps });
  assert.equal(again, first);
  assert.equal(started.length, 1);
  const next = await early.maybeStart(config, { session, app, commitHash: NEXT, pool: poolFor({ checks_commit_sha: NEXT }), deps });
  assert.ok(next && next !== first);
  assert.equal(started[0].signal.aborted, true, 'the old head\'s run is aborted');
  assert.deepEqual(deleted, [early.jobName(7652, first.runId)], 'and its Job deleted');
  assert.equal(started.length, 2);
});

test('the checks run takes it over once, hears its progress, and stops it when cancelled', async (t) => {
  const { started, deleted, resolvers, deps } = setup(t);
  const entry = await early.maybeStart(config, { session, app, commitHash: SHA, pool: poolFor(), deps });
  started[0].onProgress({ phase: 'running', ran: 100 });
  assert.equal(early.adopt(config, 7652, NEXT, NEXT), null, 'another head');
  assert.equal(early.adopt(config, 7652, SHA, 'dev/some-branch'), null, 'another ref');
  const heard = [];
  const controller = new AbortController();
  const taken = early.adopt(config, 7652, SHA, SHA, { onProgress: (s) => heard.push(s), signal: controller.signal });
  assert.equal(taken.runId, entry.runId);
  assert.deepEqual(heard, [{ phase: 'running', ran: 100 }], 'the last snapshot at once');
  started[0].onProgress({ phase: 'running', ran: 200 });
  assert.equal(heard.length, 2, 'and every one after');
  assert.equal(early.adopt(config, 7652, SHA, SHA), null, 'taken once');
  controller.abort(new Error('newer head'));
  assert.equal(started[0].signal.aborted, true);
  assert.deepEqual(deleted, [early.jobName(7652, entry.runId)]);
  resolvers[0]({ row: { status: 'pass' } });
  assert.equal(await taken.promise, null, 'an aborted run settles to no row');
});

test('a run taken over resolves to the suite\'s outcome, and leaves its Job for the run to release', async (t) => {
  const { deleted, resolvers, deps } = setup(t);
  await early.maybeStart(config, { session, app, commitHash: SHA, pool: poolFor(), deps });
  const taken = early.adopt(config, 7652, SHA, SHA);
  const outcome = { row: { status: 'pass' } };
  resolvers[0](outcome);
  assert.equal(await taken.promise, outcome);
  assert.equal(deleted.length, 0);
  assert.equal(early._runs.size, 0, 'gone from the table once settled');
});

test('nobody taking it over in time stops it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { started, deleted, deps } = setup(t);
  const entry = await early.maybeStart(config, { session, app, commitHash: SHA, pool: poolFor(), deps });
  t.mock.timers.tick(early.ADOPT_WITHIN_MS - 1);
  assert.equal(deleted.length, 0);
  t.mock.timers.tick(1);
  assert.equal(started[0].signal.aborted, true);
  assert.deepEqual(deleted, [early.jobName(7652, entry.runId)]);
  assert.equal(early.adopt(config, 7652, SHA, SHA), null);
});

test('cancel stops the session\'s run of that head, never a newer head\'s', async (t) => {
  const { started, deleted, deps } = setup(t);
  const entry = await early.maybeStart(config, { session, app, commitHash: SHA, pool: poolFor(), deps });
  early.cancel(config, 7652, 'an older head\'s run ended', { commitHash: NEXT });
  assert.equal(started[0].signal.aborted, false, 'another head: left alone');
  early.cancel(config, 7652, 'the verdict is deferred', { commitHash: SHA });
  assert.equal(started[0].signal.aborted, true);
  assert.deepEqual(deleted, [early.jobName(7652, entry.runId)]);
  early.cancel(config, 7652, 'nothing left', { commitHash: SHA });
  assert.equal(deleted.length, 1);
});

test('a run taken over can be stopped by the run that took it, and by nothing else', async (t) => {
  const { started, deleted, deps } = setup(t);
  const first = await early.maybeStart(config, { session, app, commitHash: SHA, pool: poolFor(), deps });
  const taken = early.adopt(config, 7652, SHA, SHA);
  const next = await early.maybeStart(config, { session, app, commitHash: NEXT, pool: poolFor({ checks_commit_sha: NEXT }), deps });
  taken.stop('the checks run ended without a verdict');
  assert.equal(started[0].signal.aborted, true);
  assert.equal(started[1].signal.aborted, false, 'the newer head\'s run goes on');
  assert.deepEqual(deleted, [early.jobName(7652, first.runId)]);
  assert.ok(next);
});

test('the build starts it, detached; the checks run takes it over and records where it is', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'services', f), 'utf8');
  const staging = read('staging.js');
  const build = staging.slice(staging.indexOf('async function buildAndDeployStaging'), staging.indexOf('function reportBuildStep'));
  assert.match(build, /if \(commitHash && commitHash !== 'latest'\) \{\s+lifecycle\.detach\(\(\) => require\('\.\/early-unit-suite'\)\.maybeStart\(config, \{ session, app, commitHash \}\)\);/);
  assert.ok(build.indexOf('early-unit-suite') < build.indexOf('_stagingBuilds.get(key)'), 'before the build, not after it');

  const visuals = read('visuals.js');
  const run = visuals.slice(visuals.indexOf('async function captureForSession'), visuals.indexOf('async function settleCaptureRun'));
  assert.match(run, /earlyUnit = require\('\.\/early-unit-suite'\)\.adopt\(config, session\.id, commitHash, gitRef, \{\s+onProgress: progress\.observeUnit, signal: operation\?\.signal,/);
  assert.ok(run.indexOf('.adopt(config') < run.indexOf('await checkRuns.record(operation?.cleanupPool || pool, {'), 'taken over before the manifest is written');
  assert.match(run, /\.\.\.\(earlyUnit \? \{ unitRunId: earlyUnit\.runId \} : \{\}\),/);
  assert.match(run, /const unitSuitePromise = shotsOnly \? Promise\.resolve\(null\) : earlyUnit \? earlyUnit\.promise : unitSuite\.maybeRunUnitSuite\(\{/);
  assert.match(run, /require\('\.\/early-unit-suite'\)\.cancel\(config, session\.id, 'the verdict is deferred', \{ commitHash \}\);/);
  assert.match(run, /require\('\.\/early-unit-suite'\)\.cancel\(config, session\.id, 'the checks for this commit already passed', \{ commitHash \}\);/);
  assert.match(run, /if \(harvestable && settledRun && earlyUnit\) releaseCheckJobs\(config, session\.id, earlyUnit\.runId\);/);
  assert.match(run, /if \(earlyUnit && !settledRun\) earlyUnit\.stop\('the checks run ended without a verdict'\);/);
});
