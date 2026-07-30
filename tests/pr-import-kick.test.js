// #846 — the import-time checks kick (services/pr-import-sync
// kickImportedChecks), extracted out of the POST /pr-import route so it can
// be exercised on its own. Covers:
//   - the real-GitHub sequence: setChecksPending → notifyChecksPending →
//     buildAndDeployStaging → UPDATE staging_url → warmStagingCert →
//     staging_ready broadcast + pushSessionUpdate → captureForSession, in
//     that order (the broadcast MUST come after the staging_url persist —
//     Caddy's on-demand TLS gate only approves a host once the column
//     matches it);
//   - the mock-GitHub (staging preview) branch short-circuits to a
//     gate-passing 'skipped' verdict with no build and no staging_ready;
//   - a build failure records a terminal boot-failure verdict, emits no
//     staging_ready, and never throws out of the (un-awaited) call.
//
// Run with: node --test tests/pr-import-kick.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// Same module-cache interception as tests/pr-import-sync.test.js: the worker
// unit env ships a minimal node_modules, and pr-import-sync pulls its heavy
// collaborators lazily, so pre-seed controllable fakes before requiring it.
function fakeModule(relPath, exports) {
  const p = require.resolve(relPath);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
  return exports;
}

fakeModule('../src/services/github', {
  isEnabled: () => true,
  getPR: async () => ({}),
});
fakeModule('../src/services/ws', {
  sendSystemMessage: async () => {},
  pushVoteUpdate: () => {},
  pushSessionUpdate: () => {},
  broadcastGlobal: () => {},
});
fakeModule('../src/services/visuals', {
  setChecksPending: async () => {},
  notifyChecksPending: () => {},
  storeChecksSkipped: async () => {},
  captureForSession: async () => {},
});
fakeModule('../src/services/staging', {
  buildAndDeployStaging: async () => ({ containerId: 'c1', stagingUrl: 'https://s.example', hostname: 'h' }),
  warmStagingCert: async () => {},
});
fakeModule('../src/services/staging-recovery', {
  recordStagingBootFailure: async () => {},
});

const fakeVisuals = require('../src/services/visuals');
const fakeStaging = require('../src/services/staging');
const fakeWs = require('../src/services/ws');
const fakeRecovery = require('../src/services/staging-recovery');
const prImportSync = require('../src/services/pr-import-sync');

const SESSION = {
  id: 777, app_id: 10, app_slug: 'selfapp', user_id: 1,
  branch_name: 'contrib/feature', pr_number: 9401, source: 'imported',
  repo_url: 'https://github.com/o/r', staging_url: null,
};
const APP = { id: 10, slug: 'selfapp', name: 'Self App', repo_url: 'https://github.com/o/r' };
const HEAD = 'abc123abc123abc123abc123abc123abc123abcd';

// Record every observable side effect into one ordered trace, so the test can
// assert sequence (not just occurrence).
function makeTrace({ buildImpl } = {}) {
  const trace = [];
  const queries = [];
  fakeVisuals.setChecksPending = async (pool, id, sha) => { trace.push(['setChecksPending', id, sha]); };
  fakeVisuals.notifyChecksPending = (id, sha) => { trace.push(['notifyChecksPending', id, sha]); };
  fakeVisuals.storeChecksSkipped = async (pool, id, sha, reason) => {
    trace.push(['storeChecksSkipped', id, sha, reason]);
  };
  fakeVisuals.captureForSession = async () => { trace.push(['captureForSession']); };
  fakeStaging.buildAndDeployStaging = buildImpl || (async (cfg, s, app, commit) => {
    trace.push(['build', commit]);
    return { containerId: 'c1', stagingUrl: 'https://s.example', hostname: 'h' };
  });
  fakeStaging.warmStagingCert = async (s, host, url) => { trace.push(['warmStagingCert', url]); };
  fakeWs.broadcastGlobal = (payload) => { trace.push(['broadcastGlobal', payload.event, payload.url]); };
  fakeWs.pushSessionUpdate = (payload) => { trace.push(['pushSessionUpdate', payload.action, payload.appSlug]); };
  fakeRecovery.recordStagingBootFailure = async ({ commitHash }) => {
    trace.push(['recordStagingBootFailure', commitHash]);
  };
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/UPDATE chat_sessions SET staging_container_id/.test(sql)) {
        trace.push(['persistStagingUrl', params[1]]);
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { trace, queries, pool };
}

const names = (trace) => trace.map((t) => t[0]);

test('kickImportedChecks runs the full sequence and broadcasts staging_ready after the persist', async () => {
  process.env.USERNODE_ENV = 'production';
  const { trace, pool } = makeTrace();

  await prImportSync.kickImportedChecks({
    config: {}, pool, session: { ...SESSION }, app: APP, headSha: HEAD,
  });

  assert.deepEqual(names(trace), [
    'setChecksPending',
    'notifyChecksPending',
    'build',
    'persistStagingUrl',
    'warmStagingCert',
    'broadcastGlobal',
    'pushSessionUpdate',
    'captureForSession',
  ], 'ordered import-time checks sequence');

  // Checks are stamped pending against the PINNED head, not 'latest'.
  assert.equal(trace[0][2], HEAD, 'pending stamped against the pinned head');
  assert.equal(trace[1][2], HEAD, 'pending notify carries the pinned head');
  assert.equal(trace[2][1], HEAD, 'staging built at the exact head sha');

  // The broadcast lands AFTER the staging_url column is written — Caddy's
  // on-demand TLS gate depends on that ordering.
  const persistAt = names(trace).indexOf('persistStagingUrl');
  const broadcastAt = names(trace).indexOf('broadcastGlobal');
  assert.ok(persistAt < broadcastAt, 'staging_url persisted before staging_ready');

  const [, event, url] = trace[broadcastAt];
  assert.equal(event, 'staging_ready');
  assert.equal(url, 'https://s.example', 'broadcast carries the live preview URL');
  const [, action, appSlug] = trace[names(trace).indexOf('pushSessionUpdate')];
  assert.equal(action, 'staging_ready');
  assert.equal(appSlug, 'selfapp');
});

test('kickImportedChecks does not write a session transcript row', async () => {
  process.env.USERNODE_ENV = 'production';
  const { queries, pool } = makeTrace();

  await prImportSync.kickImportedChecks({
    config: {}, pool, session: { ...SESSION }, app: APP, headSha: HEAD,
  });

  // Unlike staging-recovery, the import path posts no "Staging preview
  // rebuilt" row: an imported proposal has no transcript surface to show it.
  assert.ok(!queries.some((q) => /INSERT INTO chat_session_messages/.test(q.sql)),
    'no chat_session_messages insert');
});

test('kickImportedChecks (mock GitHub) records skipped checks with no build or broadcast', async () => {
  process.env.USERNODE_ENV = 'staging';
  try {
    const { trace, pool } = makeTrace();

    await prImportSync.kickImportedChecks({
      config: {}, pool, session: { ...SESSION }, app: APP, headSha: HEAD,
    });

    assert.deepEqual(names(trace), [
      'setChecksPending', 'notifyChecksPending', 'storeChecksSkipped',
    ], 'mock mode short-circuits after the skipped verdict');
    assert.match(trace[2][3], /mock GitHub preview/i, 'skip reason recorded');
    assert.ok(!names(trace).includes('build'), 'no staging build in mock mode');
    assert.ok(!names(trace).includes('broadcastGlobal'), 'no staging_ready in mock mode');
  } finally {
    process.env.USERNODE_ENV = 'production';
  }
});

test('kickImportedChecks records a boot failure and never throws', async () => {
  process.env.USERNODE_ENV = 'production';
  const { trace, pool } = makeTrace({
    buildImpl: async () => { throw new Error('docker build failed'); },
  });

  // The route calls this un-awaited, so an escaping rejection would be an
  // unhandled rejection in the request's shadow.
  await prImportSync.kickImportedChecks({
    config: {}, pool, session: { ...SESSION }, app: APP, headSha: HEAD,
  });

  assert.deepEqual(names(trace), [
    'setChecksPending', 'notifyChecksPending', 'recordStagingBootFailure',
  ], 'terminal error verdict recorded, nothing further');
  assert.equal(trace[2][1], HEAD, 'boot failure recorded against the pinned head');
  assert.ok(!names(trace).includes('broadcastGlobal'), 'no staging_ready on a failed build');
});

test('kickImportedChecks falls back to "latest" when no head sha is known', async () => {
  process.env.USERNODE_ENV = 'production';
  const { trace, pool } = makeTrace();

  await prImportSync.kickImportedChecks({
    config: {}, pool, session: { ...SESSION }, app: APP, headSha: null,
  });

  assert.equal(trace[2][1], 'latest', 'build falls back to latest');
  assert.equal(trace[0][2], null, 'pending stamped with a null sha');
});
