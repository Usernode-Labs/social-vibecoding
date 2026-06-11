// Tests for src/services/session-lifecycle.js — the reversible-archive
// surface added with the stale-promoted-PR policy.
//
// Like pr-metadata.test.js we stub the Docker/GitHub/WS collaborators via
// require.cache so nothing real spins up, then drive archiveSession /
// unarchiveSession / purgeArchivedCc against a mock pool and assert both
// the SQL the service issues and the side-effects it triggers.
//
// Run with: node --test tests/session-lifecycle.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Mock pool ───────────────────────────────────────────────────────────
// Matches each query() against a list of [regex, rows] handlers (first
// match wins) and records every call so tests can assert on the SQL.
function makePool(handlers) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [re, rows] of handlers) {
        if (re.test(sql)) {
          return { rows: typeof rows === 'function' ? rows(params) : rows };
        }
      }
      return { rows: [] };
    },
    // Returns true if any issued query matched `re`.
    issued(re) { return calls.some((c) => re.test(c.sql)); },
  };
}

// ── Collaborator stubs ────────────────────────────────────────────────────
// Install before requiring the subject; returns { subject, spies, restore }.
function loadWithStubs() {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    staging: require.resolve('../src/services/staging'),
    worker: require.resolve('../src/services/worker'),
    workerProgress: require.resolve('../src/services/worker-progress'),
    github: require.resolve('../src/services/github'),
    ws: require.resolve('../src/services/ws'),
    subject: require.resolve('../src/services/session-lifecycle'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const spies = {
    teardownStaging: [],
    destroyWorker: [],
    destroyCcVolume: [],
    workerProgressClear: [],
    closePR: [],
    reopenPR: [],
    reopenShouldThrow: false,
    pushSessionUpdate: [],
  };

  const stub = (id, exports) => {
    require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  };

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.staging, {
    teardownStaging: async (session, app) => { spies.teardownStaging.push({ session, app }); },
  });
  stub(ids.worker, {
    workerContainerName: (sessionId) => `usernode-worker-${sessionId}`,
    destroyWorker: async (name) => { spies.destroyWorker.push(name); },
    destroyCcVolume: async (sessionId) => { spies.destroyCcVolume.push(sessionId); },
    isInFlight: () => false,
  });
  stub(ids.workerProgress, {
    clear: (sessionId) => { spies.workerProgressClear.push(sessionId); },
  });
  stub(ids.github, {
    closePR: async (owner, repo, pr) => { spies.closePR.push({ owner, repo, pr }); },
    reopenPR: async (owner, repo, pr) => {
      spies.reopenPR.push({ owner, repo, pr });
      if (spies.reopenShouldThrow) throw new Error('branch deleted');
    },
  });
  stub(ids.ws, {
    pushSessionUpdate: (payload) => { spies.pushSessionUpdate.push(payload); },
  });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, spies, ids, restore };
}

const REPO = 'https://github.com/acme/widget';

test('archiveSession: keeps CC volume by default (reversible), closes PR, tears down', async () => {
  const { subject, spies, restore } = loadWithStubs();
  try {
    const pool = makePool([
      [/SET status = 'archived'/, [{ id: 7 }]],
      [/SELECT cs\.\*/, [{
        id: 7, app_slug: 'widget', repo_url: REPO,
        pr_number: 12, staging_container_id: 'sc-1', cc_purged: false,
      }]],
    ]);

    const res = await subject.archiveSession({ pool, sessionId: 7, userId: 3, reason: 'manual' });

    assert.equal(res.archived, true);
    assert.equal(res.appSlug, 'widget');
    // PR closed, worker destroyed, staging torn down...
    assert.deepEqual(spies.closePR, [{ owner: 'acme', repo: 'widget', pr: 12 }]);
    assert.deepEqual(spies.destroyWorker, ['usernode-worker-7']);
    assert.equal(spies.teardownStaging.length, 1);
    // ...but the CC volume is PRESERVED (the whole point of reversible archive).
    assert.deepEqual(spies.destroyCcVolume, []);
    assert.equal(pool.issued(/SET cc_purged = TRUE/), false);
    // Staging columns nulled, WS notified.
    assert.equal(pool.issued(/staging_container_id = NULL/), true);
    assert.equal(spies.pushSessionUpdate[0].action, 'archived');
  } finally {
    restore();
  }
});

test('archiveSession: ownerClause omitted for system calls (no userId)', async () => {
  const { subject, restore } = loadWithStubs();
  try {
    const pool = makePool([
      [/SET status = 'archived'/, [{ id: 9 }]],
      [/SELECT cs\.\*/, [{ id: 9, app_slug: 'w', repo_url: REPO, pr_number: null }]],
    ]);
    await subject.archiveSession({ pool, sessionId: 9, reason: 'stale-pr' });
    const upd = pool.calls.find((c) => /SET status = 'archived'/.test(c.sql));
    assert.ok(!/user_id = \$2/.test(upd.sql), 'system archive must not scope by user_id');
    assert.deepEqual(upd.params, [9]);
  } finally {
    restore();
  }
});

test('archiveSession: purgeCc=true destroys the CC volume immediately', async () => {
  const { subject, spies, restore } = loadWithStubs();
  try {
    const pool = makePool([
      [/SET status = 'archived'/, [{ id: 5 }]],
      [/SELECT cs\.\*/, [{ id: 5, app_slug: 'w', repo_url: REPO, pr_number: null }]],
    ]);
    await subject.archiveSession({ pool, sessionId: 5, purgeCc: true });
    assert.deepEqual(spies.destroyCcVolume, [5]);
    assert.equal(pool.issued(/SET cc_purged = TRUE/), true);
  } finally {
    restore();
  }
});

test('archiveSession: returns archived=false when no row matched', async () => {
  const { subject, spies, restore } = loadWithStubs();
  try {
    const pool = makePool([[/SET status = 'archived'/, []]]);
    const res = await subject.archiveSession({ pool, sessionId: 1, userId: 2 });
    assert.equal(res.archived, false);
    assert.deepEqual(spies.destroyWorker, []);
    assert.deepEqual(spies.closePR, []);
  } finally {
    restore();
  }
});

test('unarchiveSession: restores to paused and reopens the PR', async () => {
  const { subject, spies, restore } = loadWithStubs();
  try {
    const pool = makePool([
      [/SET status = 'paused', archived_at = NULL/, [{ id: 7 }]],
      [/SELECT cs\.\*/, [{ id: 7, app_slug: 'widget', repo_url: REPO, pr_number: 12, cc_purged: false }]],
    ]);
    const res = await subject.unarchiveSession({ pool, sessionId: 7, userId: 3 });
    assert.equal(res.unarchived, true);
    assert.equal(res.ccPurged, false);
    assert.equal(res.prReopened, true);
    assert.deepEqual(spies.reopenPR, [{ owner: 'acme', repo: 'widget', pr: 12 }]);
    assert.equal(spies.pushSessionUpdate[0].action, 'unarchived');
  } finally {
    restore();
  }
});

test('unarchiveSession: surfaces ccPurged and survives a failed PR reopen', async () => {
  const { subject, spies, restore } = loadWithStubs();
  try {
    spies.reopenShouldThrow = true;
    const pool = makePool([
      [/SET status = 'paused', archived_at = NULL/, [{ id: 8 }]],
      [/SELECT cs\.\*/, [{ id: 8, app_slug: 'w', repo_url: REPO, pr_number: 99, cc_purged: true }]],
    ]);
    const res = await subject.unarchiveSession({ pool, sessionId: 8 });
    assert.equal(res.unarchived, true);
    assert.equal(res.ccPurged, true, 'caller is told memory was already purged');
    assert.equal(res.prReopened, false, 'reopen failure is non-fatal');
    assert.equal(spies.pushSessionUpdate[0].action, 'unarchived');
  } finally {
    restore();
  }
});

test('unarchiveSession: returns unarchived=false for a non-archived row', async () => {
  const { subject, restore } = loadWithStubs();
  try {
    const pool = makePool([[/SET status = 'paused', archived_at = NULL/, []]]);
    const res = await subject.unarchiveSession({ pool, sessionId: 1, userId: 2 });
    assert.equal(res.unarchived, false);
  } finally {
    restore();
  }
});

// ── pauseSession ──────────────────────────────────────────────────────────
// The status predicate here is load-bearing for the per-user session cap
// (#193): the cap counts only status='active' rows precisely because
// pauseSession refuses to demote 'promoted' ones (their PR must stay up
// for the merge vote). If pauseSession ever started flipping promoted
// rows — or stopped being scoped to 'active' — the cap's accounting and
// the vote endpoints would both break.

test('pauseSession: pauses an active row, destroys worker, leaves staging up', async () => {
  const { subject, spies, restore } = loadWithStubs();
  try {
    const pool = makePool([
      [/SET status = 'paused'\s+WHERE/, [{ id: 7 }]],
      [/SELECT cs\.\*/, [{ id: 7, app_slug: 'widget', repo_url: REPO, pr_number: 12 }]],
    ]);
    const res = await subject.pauseSession({ pool, sessionId: 7, userId: 3, reason: 'manual' });
    assert.equal(res.paused, true);
    assert.equal(res.appSlug, 'widget');
    assert.deepEqual(spies.destroyWorker, ['usernode-worker-7']);
    assert.deepEqual(spies.workerProgressClear, [7]);
    // Staging is intentionally NOT torn down on pause (kept warm for resume).
    assert.equal(spies.teardownStaging.length, 0);
    assert.equal(spies.pushSessionUpdate[0].action, 'paused');
  } finally {
    restore();
  }
});

test('pauseSession: only targets status=active rows (promoted are refused)', async () => {
  const { subject, spies, restore } = loadWithStubs();
  try {
    // No handler returns a row for the UPDATE — same as the DB seeing a
    // 'promoted' (or already-paused/archived) row: zero rows match.
    const pool = makePool([[/SET status = 'paused'\s+WHERE/, []]]);
    const res = await subject.pauseSession({ pool, sessionId: 11, userId: 3, reason: 'manual' });
    assert.equal(res.paused, false);
    // Nothing torn down, nobody notified.
    assert.deepEqual(spies.destroyWorker, []);
    assert.deepEqual(spies.pushSessionUpdate, []);
    // The UPDATE itself must be scoped to status = 'active' — that's the
    // guarantee the cap predicate relies on.
    const upd = pool.calls.find((c) => /SET status = 'paused'/.test(c.sql));
    assert.ok(/status = 'active'/.test(upd.sql), "pause UPDATE must be scoped to status = 'active'");
  } finally {
    restore();
  }
});

test('purgeArchivedCc: destroys the volume and flips cc_purged', async () => {
  const { subject, spies, restore } = loadWithStubs();
  try {
    const pool = makePool([[/SET cc_purged = TRUE/, []]]);
    const res = await subject.purgeArchivedCc({ pool, sessionId: 42 });
    assert.equal(res.purged, true);
    assert.deepEqual(spies.destroyCcVolume, [42]);
    assert.equal(pool.issued(/SET cc_purged = TRUE/), true);
  } finally {
    restore();
  }
});
