// #846 — the import-time checks kick (services/pr-import-sync
// kickImportedChecks), extracted out of the POST /pr-import route so it can
// be exercised on its own. The kick builds nothing itself: it hands the
// pinned head to the preview machine (services/preview-workflow.js), which
// builds the preview, checks it, and narrates the build into the proposal's
// thread (src/workflow/preview/machine.ts). Covers:
//   - the real-GitHub path: one `revision` hand-off pinned to the imported
//     head, and nothing written or pushed here;
//   - the mock-GitHub (staging preview) branch hands the machine a
//     gate-passing 'skipped' verdict instead, and tells the before & after
//     shots why they never started;
//   - a hand-off that fails never throws out of the (un-awaited) call.
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
const fakeWs = fakeModule('../src/services/ws', {
  sendSystemMessage: async () => {},
  pushVoteUpdate: () => {},
  pushSessionUpdate: () => {},
  broadcastGlobal: () => {},
});
const fakeWorkflow = fakeModule('../src/services/preview-workflow', {
  revision: async () => {},
  skipped: async () => true,
});
const fakeShots = fakeModule('../src/services/shots-orchestrator', {
  noteNotStarted: async () => {},
});

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
function makeTrace({ revisionImpl } = {}) {
  const trace = [];
  const queries = [];
  fakeWorkflow.revision = revisionImpl || (async (args) => { trace.push(['revision', args]); });
  fakeWorkflow.skipped = async (args) => { trace.push(['skipped', args]); return true; };
  fakeShots.noteNotStarted = async (pool, id, reason) => { trace.push(['noteNotStarted', id, reason]); };
  fakeWs.broadcastGlobal = (payload) => { trace.push(['broadcastGlobal', payload.event]); };
  fakeWs.pushSessionUpdate = (payload) => { trace.push(['pushSessionUpdate', payload.action]); };
  fakeWs.sendSystemMessage = async () => { trace.push(['note']); };
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
  return { trace, queries, pool };
}

const names = (trace) => trace.map((t) => t[0]);

test('kickImportedChecks hands the pinned head to the preview machine', async () => {
  process.env.USERNODE_ENV = 'production';
  const { trace, queries, pool } = makeTrace();

  await prImportSync.kickImportedChecks({
    config: {}, pool, session: { ...SESSION }, app: APP, headSha: HEAD,
  });

  assert.deepEqual(names(trace), ['revision'], 'one hand-off, and nothing else');
  const [, args] = trace[0];
  assert.equal(args.head, HEAD, 'the machine builds the exact imported head');
  assert.equal(args.source, 'imported');
  assert.equal(args.trigger, 'pr-import');
  assert.equal(args.session.id, SESSION.id);
  assert.equal(args.pool, pool);

  // The machine's own writes say a build started, landed or failed; the kick
  // posts no note, pushes nothing and writes no row (an imported proposal
  // has no transcript surface either).
  assert.deepEqual(queries, [], 'no query from the kick itself');
});

test('kickImportedChecks (mock GitHub) records skipped checks and why the shots never started', async () => {
  process.env.USERNODE_ENV = 'staging';
  try {
    const { trace, pool } = makeTrace();

    await prImportSync.kickImportedChecks({
      config: {}, pool, session: { ...SESSION }, app: APP, headSha: HEAD,
    });

    assert.deepEqual(names(trace), ['skipped', 'noteNotStarted'],
      'mock mode hands the machine a skipped verdict and builds nothing');
    const [, args] = trace[0];
    assert.equal(args.head, HEAD);
    assert.match(args.reason, /mock GitHub preview/i, 'skip reason recorded');
    assert.deepEqual(trace[1].slice(1), [SESSION.id, 'no_staging_preview']);
  } finally {
    process.env.USERNODE_ENV = 'production';
  }
});

test('kickImportedChecks never throws when the hand-off fails', async () => {
  process.env.USERNODE_ENV = 'production';
  const { trace, pool } = makeTrace({
    revisionImpl: async () => { throw new Error('workflow store unavailable'); },
  });

  // The route calls this un-awaited, so an escaping rejection would be an
  // unhandled rejection in the request's shadow.
  await prImportSync.kickImportedChecks({
    config: {}, pool, session: { ...SESSION }, app: APP, headSha: HEAD,
  });

  assert.deepEqual(names(trace), [], 'nothing else happens after the failed hand-off');
});

test('kickImportedChecks with no head sha leaves the head to the machine to resolve', async () => {
  process.env.USERNODE_ENV = 'production';
  const { trace, pool } = makeTrace();

  await prImportSync.kickImportedChecks({
    config: {}, pool, session: { ...SESSION }, app: APP, headSha: null,
  });

  // preview-workflow.revision resolves a missing head from the row's pin
  // (imported_pr_head_sha) and hands nothing off when it cannot.
  assert.deepEqual(names(trace), ['revision']);
  assert.equal(trace[0][1].head, null);
});
