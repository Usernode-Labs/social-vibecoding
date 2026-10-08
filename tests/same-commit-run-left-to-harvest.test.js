'use strict';

// A path that would start a checks run for a commit leaves a run of that
// commit still on the cluster to the harvest (services/check-harvest.js
// runToCollect), and the preview lifecycle spares it under its lock
// (tests/preview-lifecycle.test.js has that half, against Postgres).
//
// #4319 taught the stale sweep to ask the cluster first. Every other path
// still started a run without asking, and under the preview lifecycle a new
// run cancelled every check Job of the session: a manual "Re-run checks", a
// promote-time or vote-time kick, the sweeper's preview heal, a recheck that
// needed a rebuild. One that was running was cancelled mid-run, and one that
// had finished was never read. Only a run whose inputs changed (new capture
// routes or shots) still replaces it.
//
// Run with: node --test tests/same-commit-run-left-to-harvest.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const harvest = require('../src/services/check-harvest');
const visuals = require('../src/services/visuals');
const lifecycle = require('../src/services/preview-lifecycle');
const stagingRecovery = require('../src/services/staging-recovery');
const docker = require('../src/services/docker');
const log = require('../src/services/logger');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function stub(t, mod, patch) {
  const saved = {};
  for (const [k, v] of Object.entries(patch)) { saved[k] = mod[k]; mod[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) mod[k] = v; });
}

const RUN = { runId: 'f7895663', owner: 'old-pod:1:exited', capture: 'running', unitSuite: 'succeeded' };

// A healthy docker preview of the commit, so recheckSessionChecks takes its
// direct re-run branch (config null: liveness only, as in
// tests/recheck-rebuilds-stale-preview.test.js).
const session = {
  id: 7014, app_id: 9, app_slug: 'demo', app_name: 'Demo', repo_url: 'https://github.com/o/r',
  status: 'promoted', source: 'native', check_state: 'pending', check_phase: 'testing',
  checks_commit_sha: 'abc123', staging_commit_sha: 'abc123',
  staging_url: 'https://preview.example', staging_container_id: 'c1',
};

function recheckHarness(t, { onCluster }) {
  const calls = [];
  stub(t, harvest, {
    runToCollect: async (_config, _pool, sessionId, commitSha) => {
      calls.push(['runToCollect', sessionId, commitSha]);
      return onCluster ? RUN : null;
    },
  });
  stub(t, visuals, {
    setChecksPending: async (_pool, sessionId, commitSha, phase) => { calls.push(['setChecksPending', sessionId, commitSha, phase]); return true; },
    notifyChecksPending: () => {},
    captureForSession: async (_config, s, _app, commitSha, _result, opts) => {
      calls.push(['captureForSession', s.id, commitSha, { force: opts.force, replaceRun: opts.replaceRun }]);
    },
  });
  stub(t, docker, { inspectContainer: async () => ({ status: 'running', labels: {} }) });
  stub(t, log, { info: () => {} });
  return calls;
}

const pool = { query: async () => ({ rows: [], rowCount: 0 }) };

// ── recheckSessionChecks: promote kick, vote kick, manual, conflict ─────

for (const reason of ['promote-kick', 'stale-pending-vote-kick', 'manual-recheck', 'conflict-resolved', 'stuck-checks-sweep']) {
  test(`a ${reason} recheck leaves a run of the commit still on the cluster: no stamp, no rebuild, no run`, async (t) => {
    const calls = recheckHarness(t, { onCluster: true });
    const out = await stagingRecovery.recheckSessionChecks({ config: null, pool, session, reason });
    assert.equal(out, 'collecting');
    assert.deepEqual(calls, [['runToCollect', 7014, 'abc123']],
      'asked before the pending stamp, which would set a run that is testing back to "building"');
  });
}

test('with nothing on the cluster a recheck runs as before; a manual one is forced', async (t) => {
  const calls = recheckHarness(t, { onCluster: false });
  assert.equal(await stagingRecovery.recheckSessionChecks({ config: null, pool, session, reason: 'manual-recheck' }), 'rechecked');
  assert.deepEqual(calls, [
    ['runToCollect', 7014, 'abc123'],
    ['setChecksPending', 7014, 'abc123', 'building'],
    ['captureForSession', 7014, 'abc123', { force: true, replaceRun: false }],
  ]);
});

for (const reason of ['testing-update', 'shots-update']) {
  test(`a ${reason} recheck replaces a run of the same commit: its routes or shots answer the old question`, async (t) => {
    const calls = recheckHarness(t, { onCluster: true });
    assert.equal(await stagingRecovery.recheckSessionChecks({ config: null, pool, session, reason }), 'rechecked');
    assert.equal(calls.find((c) => c[0] === 'runToCollect'), undefined, 'not asked');
    const capture = calls.find((c) => c[0] === 'captureForSession');
    assert.deepEqual(capture[3], { force: reason === 'testing-update', replaceRun: true });
  });
}

// ── captureForSession: every other caller ──────────────────────────────

function captureHarness(t, { onCluster }) {
  const calls = [];
  stub(t, lifecycle, {
    enabled: () => true,
    run: async (_config, s, commitHash, phase, _fn, opts) => {
      calls.push(['lifecycle.run', s.id, commitHash, phase, { force: opts.force }]);
      return undefined;
    },
  });
  stub(t, harvest, {
    runToCollect: async (_config, _pool, sessionId, commitSha) => {
      calls.push(['runToCollect', sessionId, commitSha]);
      return onCluster ? RUN : null;
    },
  });
  stub(t, log, { info: () => {} });
  return calls;
}

const config = { captureRuntime: 'kubernetes', appRuntime: 'kubernetes', databaseUrl: 'postgres://nobody@127.0.0.1:1/none' };
const app = { id: 9, slug: 'demo', name: 'Demo', repo_url: 'https://github.com/o/r' };

test('under the lifecycle a capture of a commit still on the cluster is not requested, forced or not', async (t) => {
  const calls = captureHarness(t, { onCluster: true });
  for (const opts of [{ trigger: 'boot-reconcile' }, { trigger: 'promote-kick', force: true }, { trigger: 'manual-recheck', force: true }]) {
    assert.equal(await visuals.captureForSession(config, session, app, 'abc123', null, opts), undefined);
  }
  assert.deepEqual(calls, [
    ['runToCollect', 7014, 'abc123'], ['runToCollect', 7014, 'abc123'], ['runToCollect', 7014, 'abc123'],
  ], 'asked before the request: a forced one queues the row, which aborts the harvest');
});

test('a capture with nothing to collect, or one that replaces the run, goes to the lifecycle as before', async (t) => {
  let calls = captureHarness(t, { onCluster: false });
  await visuals.captureForSession(config, session, app, 'abc123', null, { trigger: 'commit-push' });
  assert.deepEqual(calls, [['runToCollect', 7014, 'abc123'], ['lifecycle.run', 7014, 'abc123', 'capture', { force: false }]]);

  calls.length = 0;
  stub(t, harvest, { runToCollect: async () => { calls.push(['runToCollect']); return RUN; } });
  await visuals.captureForSession(config, session, app, 'abc123', null, { trigger: 'manual-recheck', replaceRun: true });
  assert.deepEqual(calls, [['lifecycle.run', 7014, 'abc123', 'capture', { force: true }]],
    'not asked, and forced: the lifecycle cancels the run it replaces');
});

// ── Wiring ──────────────────────────────────────────────────────────────

test('the preview heals ask the cluster before they rebuild, as the stale sweeps do', () => {
  const server = read('server.js');
  const pass3 = server.slice(server.indexOf('// Pass 3: staging heal.'), server.indexOf('// Pass 4: stuck-check reconcile'));
  const ask = pass3.indexOf("checkRunLeftToHarvest(config, pool, session, 'heal')");
  const stamp = pass3.indexOf('stagingHealAttempts.set(session.id, Date.now());');
  const rebuild = pass3.indexOf("rebuildSessionStaging({ config, pool, session, reason: 'heal' })");
  assert.ok(ask > 0 && stamp > ask && rebuild > stamp, 'Pass 3 asks before it stamps its cooldown and rebuilds');

  const recover = server.slice(server.indexOf('async function recoverSessions(config) {'));
  const askBoot = recover.indexOf("checkRunLeftToHarvest(config, pool, session, 'startup')");
  const rebuildBoot = recover.indexOf("rebuildSessionStaging({ config, pool, session, reason: 'startup' })");
  assert.ok(askBoot > 0 && rebuildBoot > askBoot, 'boot recovery asks before it rebuilds');
});

test('a capture asks before the lifecycle request; a recheck asks before its stamp and its rebuild', () => {
  const src = read('src/services/visuals.js');
  const capture = src.slice(src.indexOf('async function captureForSession('));
  const ask = capture.indexOf("require('./check-harvest').runToCollect(");
  const request = capture.indexOf("lifecycle.run(config, session, commitHash, 'capture'");
  assert.ok(ask > 0 && request > ask);
  assert.match(capture, /\{ force: opts\.force \|\| !!opts\.replaceRun, onError:/);

  const recovery = read('src/services/staging-recovery.js');
  const recheck = recovery.slice(recovery.indexOf('async function recheckSessionChecks('));
  const askRecheck = recheck.indexOf("require('./check-harvest').runToCollect(");
  const stamp = recheck.indexOf('visuals.setChecksPending(');
  const needs = recheck.indexOf('stagingNeedsRebuild(session');
  assert.ok(askRecheck > 0 && stamp > askRecheck && needs > stamp);
  assert.match(recovery, /const REPLACING_RECHECK_REASONS = new Set\(\['testing-update', 'shots-update'\]\);/);
  const rebuild = recovery.slice(recovery.indexOf('async function rebuildSessionStaging('));
  assert.match(rebuild, /replaceRun: REPLACING_RECHECK_REASONS\.has\(reason\),/,
    'a rebuild for new routes replaces the run too, where the lifecycle is off and the build cancelled nothing');
});

test('the manual button and recheck_change say a run was left to finish rather than claim a new one', () => {
  const routes = read('src/routes/sessions.js');
  const route = routes.slice(routes.indexOf("router.post('/api/sessions/:id/recheck'"));
  const ask = route.indexOf("require('../services/check-harvest').runToCollect(config, pool, sessionId, session.checks_commit_sha || null)");
  const stamp = route.indexOf('setChecksPending(pool, sessionId');
  assert.ok(ask > 0 && stamp > ask, 'asked before the pending stamp');
  assert.match(route, /return res\.json\(\{ status: 'running', checkState: 'pending', collecting: true \}\);/);

  const tools = read('src/services/mcp-tools.js');
  const recheck = tools.slice(tools.indexOf("server.registerTool('recheck_change'"), tools.indexOf("server.registerTool('start_change'"));
  assert.match(recheck, /if \(body\.collecting\) \{\s*return toolResult\(\{\s*changeId,\s*started: false,\s*checkState: 'pending',/);

  const client = read('public/js/app-view.js');
  const cast = client.slice(client.indexOf('async castRecheck(sessionId, btn) {'));
  assert.match(cast.slice(0, 3000), /if \(data\.collecting\) PlatformUI\.toast\('These checks are still running, so they were not started again\./);
});
