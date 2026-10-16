'use strict';

// Two CI reliability fixes.
//
//   1. "Re-run checks" rebuilds a preview that is of ANOTHER COMMIT than the
//      head it is about to judge. A clean platform sync of main carries the
//      checks verdict forward without a rebuild (sync-main, carryChecks), so
//      the preview stays at the pre-sync commit while the branch tip and its
//      dapp.json move on; a recheck then tested the new head's checks against
//      the old build and reported failures that were not the proposal's
//      (#1710 collected seven that way). The preview machine now stamps the
//      head it built on the row (staging_commit_sha) when it publishes, and
//      its recheck builds the head before it runs anything when what serves
//      is of another commit; a Preview click hands the row's own head pin to
//      stagingNeedsRebuild, which compares the two.
//   2. The preview's CPU ceiling is 4, on both runtimes: docker read
//      STAGING_CPUS (2) and kubernetes ignored it with a hard-coded 1.
//
// Run with: node --test tests/recheck-rebuilds-stale-preview.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function stubModule(id, exports) {
  const original = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: original ? original.paths : [] };
  return original;
}

// A fresh staging-recovery bound to a stubbed docker (the same shape
// tests/ensure-staging.test.js uses).
function loadRecovery(inspectContainer, extra = {}) {
  const dockerPath = require.resolve('../src/services/docker');
  const recPath = require.resolve('../src/services/staging-recovery');
  const original = stubModule(dockerPath, { inspectContainer, ...extra });
  delete require.cache[recPath];
  const subject = require('../src/services/staging-recovery');
  const restore = () => {
    if (original) require.cache[dockerPath] = original; else delete require.cache[dockerPath];
    delete require.cache[recPath];
  };
  return { subject, restore };
}

const running = async () => ({ status: 'running', labels: {} });
const LIVE = { id: 1, staging_url: 'https://x.example', staging_container_id: 'c1' };

// ── 1a. the comparison ──────────────────────────────────────────────────

test('a running preview of another commit than the head needs a rebuild', async () => {
  const { subject, restore } = loadRecovery(running);
  try {
    const built = { ...LIVE, staging_commit_sha: 'aaaa1111' };
    assert.equal(await subject.stagingNeedsRebuild(built, { headSha: 'bbbb2222' }), true);
    assert.equal(await subject.stagingNeedsRebuild(built, { headSha: 'AAAA1111' }), false, 'case-insensitive: same commit');
  } finally { restore(); }
});

test('without a known pair the comparison says nothing (legacy previews, liveness-only callers)', async () => {
  const { subject, restore } = loadRecovery(running);
  try {
    assert.equal(await subject.stagingNeedsRebuild({ ...LIVE, staging_commit_sha: null }, { headSha: 'bbbb2222' }), false,
      'a preview built before the column existed keeps the old answer');
    assert.equal(await subject.stagingNeedsRebuild({ ...LIVE, staging_commit_sha: 'aaaa1111' }, {}), false,
      'no head handed in: liveness only');
    assert.equal(await subject.stagingNeedsRebuild({ ...LIVE, staging_commit_sha: 'aaaa1111' }), false);
  } finally { restore(); }
});

test('liveness still wins: a stopped container rebuilds regardless, an unreadable daemon never does', async () => {
  const stopped = loadRecovery(async () => ({ status: 'exited', labels: {} }));
  try {
    assert.equal(await stopped.subject.stagingNeedsRebuild({ ...LIVE, staging_commit_sha: 'aaaa' }, { headSha: 'aaaa' }), true);
  } finally { stopped.restore(); }
  const dead = loadRecovery(async () => null);
  try {
    assert.equal(await dead.subject.stagingNeedsRebuild({ ...LIVE, staging_commit_sha: 'aaaa' }, { headSha: 'bbbb' }), false,
      'a docker hiccup must not read as stale, whatever the commits say');
  } finally { dead.restore(); }
});

test('kubernetes previews get the same comparison once they are running', async () => {
  const artPath = require.resolve('../src/services/application-runtime');
  const original = stubModule(artPath, { inspect: async () => ({ status: 'running', labels: {} }) });
  const recPath = require.resolve('../src/services/staging-recovery');
  delete require.cache[recPath];
  try {
    const subject = require('../src/services/staging-recovery');
    const row = { id: 2, staging_url: 'https://x', staging_runtime_kind: 'kubernetes', staging_runtime_name: 'app--s2', staging_commit_sha: 'aaaa' };
    assert.equal(await subject.stagingNeedsRebuild(row, { headSha: 'bbbb' }), true);
    assert.equal(await subject.stagingNeedsRebuild(row, { headSha: 'aaaa' }), false);
  } finally {
    if (original) require.cache[artPath] = original; else delete require.cache[artPath];
    delete require.cache[recPath];
  }
});

test('previewIsOfAnotherCommit and recheckHeadSha read the row pins', () => {
  const rec = require('../src/services/staging-recovery');
  assert.equal(rec.previewIsOfAnotherCommit({ staging_commit_sha: ' AAA ' }, 'aaa'), false);
  assert.equal(rec.previewIsOfAnotherCommit({ staging_commit_sha: 'aaa' }, 'bbb'), true);
  assert.equal(rec.previewIsOfAnotherCommit({ staging_commit_sha: '' }, 'bbb'), false);
  assert.equal(rec.recheckHeadSha({ source: 'imported', imported_pr_head_sha: 'imp', checks_commit_sha: 'chk' }), 'imp');
  assert.equal(rec.recheckHeadSha({ source: 'native', checks_commit_sha: 'chk', handoff_head_sha: 'h' }), 'chk');
  assert.equal(rec.recheckHeadSha({ source: 'cli_handoff', handoff_head_sha: 'h' }), 'h');
  assert.equal(rec.recheckHeadSha({}), null);
});

// ── 1b. the machine's recheck takes the rebuild branch ─────────────────
//
// recheckSessionChecks only hands the recheck over
// (tests/staging-recovery-checks-verdicts.test.js); the machine decides,
// in its recheck transition (src/workflow/preview/machine.ts), between a
// build of the head and a run against what serves.

const { preview, WORK } = require('../src/workflow/preview/machine.ts');
const machine = preview({ maxRetries: 5, retireAfterMs: 60000 });
const SYNC = 'b'.repeat(40);
const PRE_SYNC = 'a'.repeat(40);

function settledOn(servingHead) {
  return {
    name: 'settled',
    data: {
      sessionId: 1, appId: 9, appSlug: 'app', userId: 3, seed: 100, head: SYNC, trigger: 'commit-push', last: 1,
      preparing: null,
      serving: { n: 1, head: servingHead, db: 'app_app_staging_s1_aaaaaa', url: 'https://x.example',
        runtimeKind: 'kubernetes', runtimeName: 'sv-preview-9-s1', containerId: null, imageRef: null, buildRef: null },
      run: null, verdict: 'passing', failure: null, platformFault: false, streak: 0, firstFailureAt: null,
      episode: 0, retiring: [], exit: null, pending: null, closedAt: null, operations: [],
    },
  };
}
const ctx = { machine: 'preview', key: 'session:1', appId: 9, version: 4, now: new Date('2026-10-15T12:00:00Z') };
const recheck = (state) => {
  const entry = machine.entryFor(state.name, 'RecheckRequested');
  const event = { id: 7, type: 'RecheckRequested', payload: { reason: 'manual-recheck', trigger: 'manual-recheck' }, source: { kind: 'route' } };
  return entry.to(state, event, { session: null, app: null, alive: new Set() }, ctx);
};

test('the machine\'s recheck rebuilds a stale preview at the head, and re-runs a current preview directly', () => {
  // A clean sync carried the head to the merge commit; what serves is
  // still the commit before it. The head is built before anything runs.
  const stale = recheck(settledOn(PRE_SYNC));
  assert.equal(stale.next.name, 'preparing');
  assert.deepEqual(stale.work.filter((w) => w.kind === WORK.prepare).map((w) => w.input.head), [SYNC]);
  assert.equal(stale.work.filter((w) => w.kind === WORK.run).length, 0, 'the old build is not tested');
  // Same commit: the healthy preview is re-run directly.
  const current = recheck(settledOn(SYNC));
  assert.equal(current.next.name, 'checking');
  assert.deepEqual(current.work.map((w) => [w.kind, w.input.head]), [[WORK.run, SYNC]]);
  assert.equal(current.work.filter((w) => w.kind === WORK.prepare).length, 0);
});

// ── 1c. the stamp ──────────────────────────────────────────────────────

test('publishing stamps the built head on the row and unpublishing clears it', () => {
  const machineSrc = read('src/workflow/preview/machine.ts');
  assert.match(machineSrc, /staging_runtime_kind = \$6, staging_runtime_name = \$7, staging_commit_sha = \$8\n\s+WHERE id = \$1`,\n\s+\[w\.sessionId, w\.served\.url, w\.served\.containerId, w\.served\.imageRef, w\.served\.buildRef,\n\s+w\.served\.runtimeKind, w\.served\.runtimeName, w\.served\.head\]/);
  assert.match(machineSrc, /staging_runtime_kind = NULL, staging_runtime_name = NULL, staging_commit_sha = NULL\n\s+WHERE id = \$1`/);
  assert.match(read('src/services/staging.js'), /commitSha: resolvedRevision \|\| null,/, 'the build hands back the commit it cloned');
  assert.match(read('src/db/schema.sql'), /ALTER TABLE chat_sessions\s+ADD COLUMN IF NOT EXISTS staging_commit_sha VARCHAR\(64\);/);
  // A Preview click judges the preview against the head the row is about.
  assert.match(read('src/routes/sessions.js'),
    /const headSha = stagingRecovery\.recheckHeadSha\(session\);\n\s+if \(await stagingRecovery\.stagingNeedsRebuild\(session, \{ config, headSha \}\)\)/);
});

// ── 2. the CPU ceiling reaches both runtimes ───────────────────────────

test('the preview ceiling is four CPUs on docker and the same figure on kubernetes', () => {
  const docker = require('../src/services/docker');
  assert.equal(docker.STAGING_CPUS, '4');
  assert.match(read('src/services/application-runtime.js'), /kubernetes\.deployApplication\(config, \{[\s\S]*app, environment, sessionId, imageRef, env, cpus, labels, runtimeName, internalOnly,[\s\S]*\}\)/);
  const k8s = read('src/services/kubernetes.js');
  assert.match(k8s, /async function deployApplication\(config, \{[\s\S]*runtimeName = null, internalOnly = false,[\s\S]*\}\)/);
  assert.match(k8s, /limits: \{ cpu: String\(cpus \|\| '1'\), memory: '1Gi' \}/, 'production apps pass nothing and keep 1');
  assert.match(read('src/services/staging.js'), /cpus: docker\.STAGING_CPUS,/, 'staging passes the ceiling on every runtime');
});
