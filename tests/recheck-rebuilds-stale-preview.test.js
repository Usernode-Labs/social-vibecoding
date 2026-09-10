'use strict';

// Two CI reliability fixes.
//
//   1. "Re-run checks" rebuilds a preview that is of ANOTHER COMMIT than the
//      head it is about to judge. A clean platform sync of main carries the
//      checks verdict forward without a rebuild (sync-main, carryChecks), so
//      the preview stays at the pre-sync commit while the branch tip and its
//      dapp.json move on; a recheck then tested the new head's checks against
//      the old build and reported failures that were not the proposal's
//      (#1710 collected seven that way). The build now stamps the clone's
//      HEAD on the row (staging_commit_sha), and the recheck path hands the
//      row's own head pin to stagingNeedsRebuild, which compares the two.
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

// ── 1b. the recheck path takes the rebuild branch ──────────────────────

test('recheckSessionChecks rebuilds a preview a clean sync left behind, and re-runs directly otherwise', async () => {
  const { subject, restore } = loadRecovery(running);
  const visuals = require('../src/services/visuals');
  const saved = {
    setChecksPending: visuals.setChecksPending,
    notifyChecksPending: visuals.notifyChecksPending,
    captureForSession: visuals.captureForSession,
    storeChecksSkipped: visuals.storeChecksSkipped,
    maybeAutoMergeAfterChecks: visuals.maybeAutoMergeAfterChecks,
  };
  let captured = 0;
  let skippedReason = null;
  visuals.setChecksPending = async () => true;
  visuals.notifyChecksPending = () => {};
  visuals.captureForSession = async () => { captured += 1; };
  visuals.storeChecksSkipped = async (_pool, _id, _sha, reason) => { skippedReason = reason; return true; };
  visuals.maybeAutoMergeAfterChecks = () => {};
  const pool = { query: async () => ({ rows: [], rowCount: 1 }) };
  try {
    // The sync carried checks_commit_sha to the merge commit; the preview is
    // still of the commit before it. No repo_url, so the rebuild branch
    // short-circuits to 'skipped' — which is how we see it was taken.
    const behind = { ...LIVE, app_id: 9, app_slug: 'app', status: 'promoted', source: 'native',
      staging_commit_sha: 'pre-sync', checks_commit_sha: 'sync-commit' };
    assert.equal(await subject.recheckSessionChecks({ config: null, pool, session: behind, reason: 'manual-recheck' }), 'skipped');
    assert.equal(captured, 0, 'the old build was not tested');
    assert.match(String(skippedReason), /GitHub is not configured/);
    // Same commit: the healthy preview is re-run directly, as before.
    const current = { ...behind, staging_commit_sha: 'sync-commit' };
    assert.equal(await subject.recheckSessionChecks({ config: null, pool, session: current, reason: 'manual-recheck' }), 'rechecked');
    assert.equal(captured, 1);
  } finally {
    Object.assign(visuals, saved);
    restore();
  }
});

// ── 1c. the stamp ──────────────────────────────────────────────────────

test('the build stamps the clone HEAD on the row and teardown clears it', () => {
  const staging = read('src/services/staging.js');
  assert.match(staging, /staging_runtime_kind = \$3, staging_runtime_name = \$4,\n\s+staging_commit_sha = \$6 WHERE id = \$5`,\n\s+\[build\.imageRef, build\.buildRef, deployed\.runtimeKind, deployed\.runtimeName, session\.id,\n\s+resolvedRevision \|\| null\]/);
  assert.match(staging, /commitSha: resolvedRevision \|\| null,/, 'and hands it back to the caller');
  assert.match(staging, /staging_runtime_kind = NULL, staging_runtime_name = NULL,\n\s+staging_commit_sha = NULL WHERE id = \$1`/);
  assert.match(read('src/db/schema.sql'), /ALTER TABLE chat_sessions\s+ADD COLUMN IF NOT EXISTS staging_commit_sha VARCHAR\(64\);/);
  assert.match(read('src/services/staging-recovery.js'), /stagingNeedsRebuild\(session, \{ config, headSha: recheckHeadSha\(session\) \}\)/);
});

// ── 2. the CPU ceiling reaches both runtimes ───────────────────────────

test('the preview ceiling is four CPUs on docker and the same figure on kubernetes', () => {
  const docker = require('../src/services/docker');
  assert.equal(docker.STAGING_CPUS, '4');
  assert.match(read('src/services/application-runtime.js'), /kubernetes\.deployApplication\(config, \{ app, environment, sessionId, imageRef, env, cpus, labels \}\)/);
  const k8s = read('src/services/kubernetes.js');
  assert.match(k8s, /async function deployApplication\(config, \{ app, environment, sessionId, imageRef, env, cpus = null, labels: extraLabels = \{\} \}\)/);
  assert.match(k8s, /limits: \{ cpu: String\(cpus \|\| '1'\), memory: '1Gi' \}/, 'production apps pass nothing and keep 1');
  assert.match(read('src/services/staging.js'), /cpus: docker\.STAGING_CPUS,/, 'staging passes the ceiling on every runtime');
});
