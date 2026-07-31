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
// #866 adds three more contracts to the same call:
//   - build start / ready / failure are narrated into the proposal's OWN
//     thread (sendSystemMessage targeted { type: 'session', ref: id }) —
//     the only surface an imported proposal has;
//   - a failed build also pushes a `staging_failed` session update so open
//     cards flip to "Preview unavailable" without a manual refresh;
//   - a proposal withdrawn WHILE the build ran gets the finished preview
//     torn down instead of persisted (no leaked container, no Preview
//     button on a closed proposal).
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
  summarizeBootFailure: (err) => (err && err.message ? err.message : 'unknown'),
});
fakeModule('../src/services/staging', {
  buildAndDeployStaging: async () => ({ containerId: 'c1', stagingUrl: 'https://s.example', hostname: 'h' }),
  warmStagingCert: async () => {},
  teardownStaging: async () => ({ removed: true }),
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
function makeTrace({ buildImpl, statusAfterBuild = 'promoted' } = {}) {
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
  fakeStaging.teardownStaging = async (s, app) => {
    trace.push(['teardownStaging', s.staging_container_id, s.staging_url, app && app.slug]);
    return { removed: true };
  };
  fakeWs.broadcastGlobal = (payload) => { trace.push(['broadcastGlobal', payload.event, payload.url]); };
  fakeWs.pushSessionUpdate = (payload) => { trace.push(['pushSessionUpdate', payload.action, payload.appSlug]); };
  // #866: the proposal-thread narration. Records the targeting too — an
  // imported proposal only ever sees { type: 'session', ref: <id> } rows.
  fakeWs.sendSystemMessage = async (pool, appId, text, kind, metadata, target) => {
    trace.push(['note', (metadata && metadata.stagingBuild) || null, text, target]);
  };
  fakeRecovery.recordStagingBootFailure = async ({ commitHash }) => {
    trace.push(['recordStagingBootFailure', commitHash]);
  };
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/UPDATE chat_sessions SET staging_container_id/.test(sql)) {
        trace.push(['persistStagingUrl', params[1]]);
      }
      // #866: the post-build "is this proposal still open?" re-read.
      if (/SELECT status FROM chat_sessions/.test(sql)) {
        trace.push(['statusRecheck', statusAfterBuild]);
        return { rows: [{ status: statusAfterBuild }], rowCount: 1 };
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
    'note',              // #866: "Building a staging preview…"
    'build',
    'statusRecheck',     // #866: still promoted?
    'persistStagingUrl',
    'warmStagingCert',
    'note',              // #866: "…preview is ready"
    'broadcastGlobal',
    'pushSessionUpdate',
    'captureForSession',
  ], 'ordered import-time checks sequence');

  // Checks are stamped pending against the PINNED head, not 'latest'.
  assert.equal(trace[0][2], HEAD, 'pending stamped against the pinned head');
  assert.equal(trace[1][2], HEAD, 'pending notify carries the pinned head');
  const buildAt = names(trace).indexOf('build');
  assert.equal(trace[buildAt][1], HEAD, 'staging built at the exact head sha');

  // #866: both notes land in the proposal's own thread, and the start note
  // is posted BEFORE the (minutes-long) build so it is actually news.
  const notes = trace.filter((t) => t[0] === 'note');
  assert.deepEqual(notes.map((n) => n[1]), ['started', 'ready']);
  for (const n of notes) {
    assert.deepEqual(n[3], { type: 'session', ref: SESSION.id },
      'narration targets the imported proposal thread');
  }
  assert.ok(names(trace).indexOf('note') < buildAt, 'start note precedes the build');
  assert.match(notes[0][2], /Building a staging preview for PR #9401/);
  assert.match(notes[1][2], /ready/i);

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
    // #866: and no "building a preview…" note for a build that never runs.
    assert.ok(!names(trace).includes('note'), 'no build narration in mock mode');
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
    'setChecksPending', 'notifyChecksPending',
    'note',                       // "Building a staging preview…"
    'recordStagingBootFailure',   // records the verdict AND narrates the
                                  // reason (imported-aware — see
                                  // tests/staging-recovery-checks-verdicts)
    'pushSessionUpdate',          // #866: flip open cards to unavailable
  ], 'terminal error verdict recorded plus the live flip, nothing further');
  const failAt = names(trace).indexOf('recordStagingBootFailure');
  assert.equal(trace[failAt][1], HEAD, 'boot failure recorded against the pinned head');
  assert.ok(!names(trace).includes('broadcastGlobal'), 'no staging_ready on a failed build');
  assert.ok(!names(trace).includes('persistStagingUrl'), 'nothing persisted on a failed build');

  // Exactly ONE note on this path: the start note. The failure reason is
  // narrated by recordStagingBootFailure (one post per failure streak), so
  // posting it here too would double up on every import-time failure.
  assert.deepEqual(trace.filter((t) => t[0] === 'note').map((n) => n[1]), ['started']);

  const push = trace[names(trace).indexOf('pushSessionUpdate')];
  assert.equal(push[1], 'staging_failed');
  assert.equal(push[2], 'selfapp');
});

// #866 — the withdrawn-mid-build case. A preview takes minutes; the proposal
// can be closed in that window. Persisting the finished container onto a
// non-open row would strand it (the idle-GC sweep skips closed statuses) and
// put a live Preview button back on a settled proposal.
test('kickImportedChecks tears down a preview whose proposal was withdrawn mid-build', async () => {
  process.env.USERNODE_ENV = 'production';
  const { trace, queries, pool } = makeTrace({ statusAfterBuild: 'archived' });

  await prImportSync.kickImportedChecks({
    config: {}, pool, session: { ...SESSION }, app: APP, headSha: HEAD,
  });

  assert.deepEqual(names(trace), [
    'setChecksPending', 'notifyChecksPending', 'note', 'build',
    'statusRecheck', 'teardownStaging',
  ], 'build discarded instead of published');
  assert.ok(!names(trace).includes('persistStagingUrl'),
    'staging_url never written onto a withdrawn proposal');
  assert.ok(!names(trace).includes('broadcastGlobal'), 'no staging_ready broadcast');
  assert.ok(!names(trace).includes('captureForSession'), 'no visuals capture');
  assert.ok(!queries.some((q) => /UPDATE chat_sessions SET staging_container_id/.test(q.sql)));

  // The teardown gets the FRESH container id + URL: teardownStaging derives
  // the staging DB name from staging_url, and the row never got one.
  const td = trace[names(trace).indexOf('teardownStaging')];
  assert.equal(td[1], 'c1', 'tears down the container the build just created');
  assert.equal(td[2], 'https://s.example', 'URL threaded through so the clone DB is dropped');
  assert.equal(td[3], 'selfapp');
});

// A merging proposal is mid-pipeline, not closed — its preview still backs
// the merge, so the build publishes normally.
test('kickImportedChecks publishes normally when the proposal reached merging', async () => {
  process.env.USERNODE_ENV = 'production';
  const { trace, pool } = makeTrace({ statusAfterBuild: 'merging' });

  await prImportSync.kickImportedChecks({
    config: {}, pool, session: { ...SESSION }, app: APP, headSha: HEAD,
  });

  assert.ok(names(trace).includes('persistStagingUrl'), 'preview published');
  assert.ok(!names(trace).includes('teardownStaging'), 'nothing torn down');
});

// The re-check must fail OPEN: a transient DB error during the status read
// should never throw away a preview that built successfully.
test('kickImportedChecks keeps the build when the status re-check fails', async () => {
  process.env.USERNODE_ENV = 'production';
  const { trace, pool } = makeTrace();
  const inner = pool.query;
  pool.query = async (sql, params) => {
    if (/SELECT status FROM chat_sessions/.test(sql)) throw new Error('db gone');
    return inner(sql, params);
  };

  await prImportSync.kickImportedChecks({
    config: {}, pool, session: { ...SESSION }, app: APP, headSha: HEAD,
  });

  assert.ok(names(trace).includes('persistStagingUrl'), 'preview still published');
  assert.ok(!names(trace).includes('teardownStaging'), 'nothing torn down');
});

test('kickImportedChecks falls back to "latest" when no head sha is known', async () => {
  process.env.USERNODE_ENV = 'production';
  const { trace, pool } = makeTrace();

  await prImportSync.kickImportedChecks({
    config: {}, pool, session: { ...SESSION }, app: APP, headSha: null,
  });

  assert.equal(trace[names(trace).indexOf('build')][1], 'latest', 'build falls back to latest');
  assert.equal(trace[0][2], null, 'pending stamped with a null sha');
});
