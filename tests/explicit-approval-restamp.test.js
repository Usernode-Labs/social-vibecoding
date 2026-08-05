// Tests for the #788 follow-up RE-STAMP paths — the two mechanisms that
// keep a stored explicit-approval flag from going stale:
//
//   1. sweepExplicitApproval (services/app-admins.js) — the stale-PR
//      sweeper's per-row re-verify. Stored NULL is backfilled, stored
//      TRUE is re-verified (and cleared when the merge-base diff no
//      longer touches the admins block), stored FALSE is skipped with
//      ZERO GitHub calls.
//   2. runSyncMain (services/sync-main.js) — a successful sync push
//      changed the branch's contents, so promoted rows re-stamp.
//
// Run with: node --test tests/explicit-approval-restamp.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const BASE_SHA = 'basebasebasebasebasebasebasebasebasebase';

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// ── sweepExplicitApproval ─────────────────────────────────────────────

// GitHub stub scripting the merge-base compare + per-ref manifests, with
// call counters so the FALSE-skip case can assert zero API traffic.
function withGithub({ base, head, files = ['dapp.json'], mergeBaseSha = BASE_SHA, throws = false }, fn) {
  const key = require.resolve('../src/services/github');
  const original = require.cache[key];
  const counts = { compares: 0, fetches: 0 };
  stub(key, {
    isEnabled: () => true,
    compareRefs: async () => {
      counts.compares++;
      if (throws) throw new Error('GitHub is down');
      return { mergeBaseSha, files, filesComplete: true };
    },
    getFileContent: async (o, r, f, ref) => {
      counts.fetches++;
      return ref === BASE_SHA ? base : head;
    },
  });
  return Promise.resolve(fn(counts)).finally(() => {
    if (original) require.cache[key] = original;
    else delete require.cache[key];
  });
}

const appAdmins = require('../src/services/app-admins');
const json = (o) => JSON.stringify(o);

const SESSION = (flag) => ({
  id: 42, app_id: 5, branch_name: 'dev/old',
  repo_url: 'https://github.com/bot/chess',
  requires_explicit_approval: flag,
});

function capturePool() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; },
    stamps() {
      return calls
        .filter((c) => /requires_explicit_approval/.test(c.sql))
        .map((c) => c.params);
    },
  };
}

test('sweep: a stored TRUE whose diff no longer touches admins is CLEARED', () => withGithub({
  // The 2648 shape: the branch never touched dapp.json at all.
  files: ['server.js'],
}, async () => {
  const pool = capturePool();
  const out = await appAdmins.sweepExplicitApproval(pool, SESSION(true));
  assert.equal(out, false);
  assert.deepEqual(pool.stamps(), [[42, false, null]], 'the stale flag is stamped away');
}));

test('sweep: a stored TRUE that still changes admins STAYS flagged', () => withGithub({
  base: json({ admins: [] }),
  head: json({ admins: ['mallory'] }),
}, async () => {
  const pool = capturePool();
  const out = await appAdmins.sweepExplicitApproval(pool, SESSION(true));
  assert.equal(out, true);
  assert.deepEqual(pool.stamps(), [[42, true, 'admins']]);
}));

test('sweep: a stored FALSE is skipped with ZERO GitHub calls', () => withGithub({
  files: ['dapp.json'],
}, async (counts) => {
  const pool = capturePool();
  const out = await appAdmins.sweepExplicitApproval(pool, SESSION(false));
  assert.equal(out, false);
  assert.equal(counts.compares, 0, 'no compare for an unflagged row');
  assert.equal(counts.fetches, 0);
  assert.equal(pool.calls.length, 0, 'nothing re-stamped either');
}));

test('sweep: a stored NULL is backfilled with the fresh verdict', () => withGithub({
  base: json({ admins: [] }),
  head: json({ admins: ['alice'] }),
}, async () => {
  const pool = capturePool();
  const out = await appAdmins.sweepExplicitApproval(pool, SESSION(null));
  assert.equal(out, true);
  assert.deepEqual(pool.stamps(), [[42, true, 'admins']]);
}));

test('sweep: an INDETERMINATE detection keeps the stored TRUE (never un-flags blind)', () => withGithub({
  mergeBaseSha: null,
}, async () => {
  const pool = capturePool();
  const out = await appAdmins.sweepExplicitApproval(pool, SESSION(true));
  assert.equal(out, true, 'the stored flag survives');
  assert.equal(pool.stamps().length, 0, 'nothing stamped on an indeterminate result');
}));

test('sweep: a GitHub failure keeps the stored TRUE', () => withGithub({
  throws: true,
}, async () => {
  const pool = capturePool();
  const out = await appAdmins.sweepExplicitApproval(pool, SESSION(true));
  assert.equal(out, true);
  assert.equal(pool.stamps().length, 0);
}));

// ── runSyncMain re-stamp ──────────────────────────────────────────────

// Mirror of tests/conflict-resolver.test.js's loadSyncMainWithWorker,
// plus an app-admins stub capturing refreshExplicitApproval calls (the
// module is required lazily inside runSyncMain, so the cache stub binds).
function loadSyncMain(workerResult) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    worker: require.resolve('../src/services/worker'),
    ws: require.resolve('../src/services/ws'),
    // events/limits/merge-debug pull in db/pool (→ pg); stub them so the
    // suite runs without node_modules-heavy infra.
    events: require.resolve('../src/services/events'),
    limits: require.resolve('../src/services/limits'),
    mergeDebug: require.resolve('../src/services/merge-debug'),
    appAdmins: require.resolve('../src/services/app-admins'),
    subject: require.resolve('../src/services/sync-main'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const refreshCalls = [];
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.worker, {
    ensureWorkerImage: async () => {},
    ensureWorker: async () => {},
    // #937: runSyncMain retires any pending stop before its own dispatch
    // — a sync turn is a new turn, and it is not in stopRegistry, so
    // nothing else would ever clear a flag left by an earlier chat stop.
    clearPendingStop: () => {},
    execInWorker: async () => workerResult,
  });
  stub(ids.ws, { pushSessionUpdate() {}, broadcastGlobal() {} });
  stub(ids.events, { record: () => {}, EVENT_TYPES: { SYNC_MAIN: 'sync_main' } });
  stub(ids.limits, {
    checkSystemBudget: async () => ({ ok: true, remaining: 2500 }),
    recordSystemSpend: async () => {},
  });
  stub(ids.mergeDebug, { step: () => {}, startRun: async () => null, endRun: () => {} });
  stub(ids.appAdmins, {
    refreshExplicitApproval: async (pool, app, session) => {
      refreshCalls.push({ sessionId: session.id });
      return false;
    },
  });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, refreshCalls, restore };
}

const syncPool = () => ({ query: async () => ({ rows: [{ id: 1 }] }) });

test('runSyncMain: a successful push on a PROMOTED session re-stamps the flag', async () => {
  const { subject, refreshCalls, restore } = loadSyncMain({
    syncResult: 'resolved', behind: 0, sha: 'abc1234', pushOk: true, exitCode: 0,
  });
  try {
    const res = await subject.runSyncMain({ jwtSecret: 's' }, syncPool(), 7, {
      sessionRow: {
        id: 7, user_id: 3, status: 'promoted', app_slug: 'widget',
        branch_name: 'dev/x-1', repo_url: 'https://github.com/acme/widget',
      },
    });
    assert.equal(res.ok, true);
    assert.deepEqual(refreshCalls, [{ sessionId: 7 }], 'the pushed head is re-classified');
  } finally {
    restore();
  }
});

test('runSyncMain: an unresolved conflict (no push) does NOT re-stamp', async () => {
  const { subject, refreshCalls, restore } = loadSyncMain({
    syncResult: 'conflict', behind: 2, sha: '', pushOk: false, exitCode: 0,
  });
  try {
    await subject.runSyncMain({ jwtSecret: 's' }, syncPool(), 8, {
      sessionRow: {
        id: 8, user_id: 4, status: 'promoted', app_slug: 'w',
        branch_name: 'dev/y-2', repo_url: 'https://github.com/acme/w',
      },
    });
    assert.equal(refreshCalls.length, 0, 'the branch did not change; nothing to re-verify');
  } finally {
    restore();
  }
});

test('runSyncMain: a non-promoted (active) session does NOT re-stamp', async () => {
  const { subject, refreshCalls, restore } = loadSyncMain({
    syncResult: 'clean', behind: 0, sha: 'def5678', pushOk: true, exitCode: 0,
  });
  try {
    await subject.runSyncMain({ jwtSecret: 's' }, syncPool(), 9, {
      sessionRow: {
        id: 9, user_id: 5, status: 'active', app_slug: 'w',
        branch_name: 'dev/z-3', repo_url: 'https://github.com/acme/w',
      },
    });
    assert.equal(refreshCalls.length, 0, 'classification only matters once promoted');
  } finally {
    restore();
  }
});
