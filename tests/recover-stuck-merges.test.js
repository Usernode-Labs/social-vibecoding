// Tests for the boot-time GitHub-reconciliation sweep (recoverStuckMerges).
// It must:
//   1. Heal a 'promoted'/'merging' session that GitHub reports as merged →
//      flip it to 'merged' (this is what un-sticks whiteboard #41/#44/#52/#54).
//   2. Demote a 'merging' session GitHub never merged (crash mid-merge) back
//      to 'promoted' so the next vote/retry can redrive.
//   3. Leave a genuinely-open 'promoted' session (not merged on GitHub) alone.
//
// server.js only boots when run as the entry point (require.main guard), so
// requiring it here exposes recoverStuckMerges without starting servers. The
// db/pool + github modules are required lazily inside the function, so we
// stub them via require.cache right before invoking it.
//
// Run with: node --test tests/recover-stuck-merges.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// loadConfig() (module level in server.js) hard-exits when these are missing.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
// config.load() requires the four separated platform keys (REQUIRED_PROD).
require('./platform-keys').setPlatformKeys();

// Auto-unref any housekeeping timers scheduled during the require so this
// process can exit.
const origSetInterval = global.setInterval;
const origSetTimeout = global.setTimeout;
global.setInterval = (...args) => { const t = origSetInterval(...args); if (t && t.unref) t.unref(); return t; };
global.setTimeout = (...args) => { const t = origSetTimeout(...args); if (t && t.unref) t.unref(); return t; };
let recoverStuckMerges;
try {
  ({ recoverStuckMerges } = require('../server'));
} finally {
  global.setInterval = origSetInterval;
  global.setTimeout = origSetTimeout;
}

const poolId = require.resolve('../src/db/pool');
const githubId = require.resolve('../src/services/github');

function stub(id, exports) {
  const prev = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  return prev;
}

// Builds a fake pool over a set of open-PR rows. Records UPDATEs so the test
// can assert the status transitions. The 'merged' UPDATE returns rowCount 1
// (the function logs a heal only when a row actually transitioned).
function makePool(rows) {
  const updates = [];
  return {
    updates,
    async query(sql, params = []) {
      const s = String(sql);
      if (/SELECT cs\.id[\s\S]*FROM chat_sessions cs/i.test(s) && /status IN \('promoted', 'merging'\)/.test(s)) {
        return { rows, rowCount: rows.length };
      }
      if (/SET\s+status = 'merged'/.test(s)) {
        updates.push({ to: 'merged', id: params[0], mergedAt: params[1], sha: params[2] });
        return { rows: [], rowCount: 1 };
      }
      if (/SET status = 'promoted'/.test(s)) {
        if (/WHERE id = \$1/.test(s)) {
          // Per-row demote (GitHub-aware path).
          updates.push({ to: 'promoted', id: params[0] });
          return { rows: [], rowCount: 1 };
        }
        // Bulk demote of all 'merging' rows (no-GitHub-auth fallback).
        const ids = rows.filter((r) => r.status === 'merging').map((r) => r.id);
        updates.push({ to: 'promoted', bulk: true, ids });
        return { rows: ids.map((id) => ({ id })), rowCount: ids.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const ROWS = [
  // merged on GitHub but stuck promoted → must heal
  { id: 1, status: 'promoted', pr_number: 52, merge_commit_sha: null, repo_url: 'https://github.com/acme/whiteboard' },
  // crash mid-merge, GitHub never merged → must demote
  { id: 2, status: 'merging', pr_number: 99, merge_commit_sha: null, repo_url: 'https://github.com/acme/widget' },
  // genuinely open proposal → leave alone
  { id: 3, status: 'promoted', pr_number: 39, merge_commit_sha: null, repo_url: 'https://github.com/acme/whiteboard' },
];

// GitHub truth keyed by PR number.
const GH = {
  52: { merged: true, merged_at: '2026-06-13T14:40:19Z', merge_commit_sha: 'sha52' },
  99: { merged: false },
  39: { merged: false },
};

function withStubs(pool, githubExports, fn) {
  const prevPool = stub(poolId, { getPool: () => pool });
  const prevGithub = stub(githubId, githubExports);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prevPool) require.cache[poolId] = prevPool; else delete require.cache[poolId];
      if (prevGithub) require.cache[githubId] = prevGithub; else delete require.cache[githubId];
    });
}

test('recoverStuckMerges heals merged-on-GitHub rows, demotes stuck merging, leaves open promoted', async () => {
  const pool = makePool(ROWS.map((r) => ({ ...r })));
  const getPRCalls = [];
  await withStubs(pool, {
    isEnabled: () => true,
    getPR: async (owner, repo, prNumber) => {
      getPRCalls.push(prNumber);
      return GH[prNumber];
    },
  }, () => recoverStuckMerges({}));

  // Row 1 healed to merged, carrying GitHub's merged_at + sha.
  const heal = pool.updates.find((u) => u.id === 1);
  assert.ok(heal && heal.to === 'merged', 'merged-on-GitHub row flipped to merged');
  assert.equal(heal.sha, 'sha52');
  assert.equal(heal.mergedAt, '2026-06-13T14:40:19Z');

  // Row 2 (merging, not merged on GitHub) demoted to promoted.
  const demote = pool.updates.find((u) => u.id === 2);
  assert.ok(demote && demote.to === 'promoted', 'stuck merging row demoted to promoted');

  // Row 3 (open promoted) untouched.
  assert.ok(!pool.updates.some((u) => u.id === 3), 'genuinely-open promoted row left alone');

  // Every row with a pr_number was checked against GitHub.
  assert.deepEqual(getPRCalls.sort(), [39, 52, 99]);
});

test('recoverStuckMerges without GitHub auth only demotes merging rows', async () => {
  const pool = makePool(ROWS.map((r) => ({ ...r })));
  await withStubs(pool, {
    isEnabled: () => false,
    getPR: async () => { throw new Error('should not be called'); },
  }, () => recoverStuckMerges({}));

  // Fallback path: a single bulk flip of 'merging' rows (id 2); promoted
  // rows (1, 3) are left untouched because we can't ask GitHub the truth.
  assert.deepEqual(pool.updates, [{ to: 'promoted', bulk: true, ids: [2] }]);
});
