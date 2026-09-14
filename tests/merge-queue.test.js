// The integration queue (#2038), which replaced the two-phase conflict drain.
//
// What survives from the drain and is asserted here:
//   - app-level single-flight, so concurrent triggers coalesce into one pass
//     instead of N parallel worker syncs against the same main;
//   - eligibility, so a worker turn is only ever spent on a proposal the
//     group has actually approved;
//   - highest-voted-first ordering.
//
// What changed and is asserted here:
//   - a proposal that cannot be resolved LEAVES the queue instead of being
//     carried into a second phase, because holding the app's queue open for
//     something only its author can fix blocks every sibling behind it;
//   - no GitHub mergeability polling happens at all. The old path could spend
//     fourteen reads and ~30s asking a lazily-computed field a question the
//     mirror answers exactly, before the call.
//
// Collaborators are stubbed through require.cache, the house pattern, so
// nothing real (GitHub, the worker, docker) spins up.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { mergeGate: realMergeGate } = require('../src/services/active-users');

function stub(relPath, exports) {
  const full = require.resolve(path.join(__dirname, '..', relPath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
  return exports;
}
function unstub(relPath) {
  delete require.cache[require.resolve(path.join(__dirname, '..', relPath))];
}

function makePool(rowsBySql) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [re, rows] of rowsBySql) {
        if (re.test(sql)) return { rows: typeof rows === 'function' ? rows(params) : rows };
      }
      return { rows: [] };
    },
    issued(re) { return calls.some((c) => re.test(c.sql)); },
  };
}

// A promoted candidate at or above threshold on a 2-active-user app.
function candidate(id, yes, extra = {}) {
  return {
    id, yes_count: yes, no_count: 0,
    promoted_at: new Date(2026, 0, id), created_at: new Date(2026, 0, id),
    requires_explicit_approval: false,
    integration_behind_by: 1, integration_merges_clean: true, check_state: 'passing',
    ...extra,
  };
}

function setup({
  candidates, syncResult = 'clean', budgetError = null, merged = true,
  measurement = { behindBy: 1, mergesClean: true, conflictPaths: [] },
  // What checkAndMerge answers for each session, when `merged` is not the
  // whole story: id -> result object.
  mergeResults = {},
}) {
  const events = { syncs: [], merges: [], measures: [], budget: 0, broadcasts: [] };

  const pool = makePool([
    // Honour the query's own exclusions, or the queue would be handed the
    // same candidate forever — which is exactly the spin the production loop
    // now guards against independently.
    [/FROM chat_sessions cs\s+JOIN apps a ON a\.id = cs\.app_id\s+WHERE cs\.app_id/, (p) => {
      const excludeId = p[1];
      const attempted = new Set(p[2] || []);
      return candidates.filter((c) => c.id !== excludeId && !attempted.has(c.id));
    }],
    [/SELECT cs\.\*, a\.slug AS app_slug/, (p) => {
      const row = candidates.find((c) => c.id === p[0]);
      return row ? [{
        ...row, app_id: 7, status: 'promoted', app_slug: 'demo',
        repo_url: 'https://github.com/o/r', pr_number: 100 + row.id, branch_name: `b${row.id}`,
      }] : [];
    }],
    [/approval_epoch/, []],
  ]);

  stub('src/db/pool.js', { getPool: () => pool });
  stub('src/services/github.js', { isEnabled: () => true });
  stub('src/services/limits.js', {
    async checkSystemBudget() { events.budget++; return { error: budgetError }; },
  });
  stub('src/services/ws.js', {
    pushVoteUpdate(u) { events.broadcasts.push(u); }, pushSessionUpdate() {}, async sendSystemMessage() {},
  });
  stub('src/services/sync-main.js', {
    async runSyncMain(config, pool_, id) {
      events.syncs.push(id);
      await new Promise((r) => setTimeout(r, 5));
      return { ok: syncResult !== 'conflict', syncResult, sha: 'a'.repeat(40), pushOk: true };
    },
  });
  stub('src/services/integration.js', {
    async measureDeduped({ session }, opts = {}) {
      events.measures.push({ id: session.id, blockReason: opts.blockReason, opts });
      return measurement;
    },
    readIntegration: () => ({}),
    async setBlockReasons(pool_, id, reasons) {
      events.measures.push({ id, blockReason: (reasons || [])[0], write: reasons || [] });
    },
  });
  stub('src/services/governance.js', {
    async getGovernance() { return { approverPolicy: 'anyone', approvalsRequired: null }; },
    async getElectorate() { return { active: 2, approverIds: null }; },
    computeGate(gov, active, yes, no, openedAt, now) {
      return realMergeGate(active, yes, no, openedAt, now || new Date(2027, 0, 1));
    },
    async qualifiedCountsBatch() { return new Map(); },
  });
  stub('src/routes/votes.js', {
    async checkAndMerge(config, pool_, session) {
      events.merges.push(session.id);
      if (mergeResults[session.id]) return mergeResults[session.id];
      return { merged, blockReason: merged ? undefined : 'checks' };
    },
  });

  unstub('src/services/merge-queue.js');
  // eslint-disable-next-line global-require
  const queue = require('../src/services/merge-queue');
  return { queue, pool, events };
}

function teardown() {
  for (const p of [
    'src/db/pool.js', 'src/services/github.js', 'src/services/limits.js',
    'src/services/ws.js', 'src/services/sync-main.js', 'src/services/integration.js',
    'src/services/governance.js', 'src/routes/votes.js', 'src/services/merge-queue.js',
  ]) unstub(p);
}

test('an eligible proposal is integrated, then merged', async () => {
  const { queue, events } = setup({ candidates: [candidate(1, 2)] });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [1], 'the behind proposal gets exactly one worker sync');
    assert.deepEqual(events.merges, [1]);
  } finally { teardown(); }
});

test('a below-threshold proposal never costs a worker turn', async () => {
  // The queue spends real tokens. Measurement is universal and free; only
  // INTEGRATION is gated on the group having actually approved the change.
  const { queue, events } = setup({ candidates: [candidate(1, 0)] });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [], 'no sync for a proposal nobody approved');
    assert.deepEqual(events.merges, []);
  } finally { teardown(); }
});

test('concurrent triggers for one app coalesce into a single pass', async () => {
  const { queue, events } = setup({ candidates: [candidate(1, 2)] });
  try {
    await Promise.all([queue.enqueue({}, 7), queue.enqueue({}, 7), queue.enqueue({}, 7)]);
    assert.equal(events.syncs.length, 1,
      'three triggers must not become three worker syncs against the same main');
  } finally { teardown(); }
});

test('the highest-voted eligible proposal goes first', async () => {
  const { queue, events } = setup({ candidates: [candidate(1, 2), candidate(2, 5)] });
  try {
    await queue.enqueue({}, 7);
    assert.equal(events.syncs[0], 2, 'the group’s strongest preference is integrated first');
  } finally { teardown(); }
});

test('an unresolvable conflict leaves the queue instead of holding it open', async () => {
  const { queue, events } = setup({
    candidates: [candidate(1, 2), candidate(2, 5)], syncResult: 'conflict',
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [2, 1],
      'the blocked proposal must not stop its sibling being attempted');
    assert.deepEqual(events.merges, [], 'neither merges, but both were tried');
    // The queue does NOT restate the conflict. It is derivable by the card
    // from merge_conflict_state, which the sync turn just wrote — and the
    // server only reports what the browser cannot work out for itself.
    assert.ok(events.measures.some((m) => m.blockReason === 'integrating'),
      'it announced it was working on it');
    assert.ok(!events.measures.some((m) => m.blockReason === 'conflict'),
      'and did not duplicate a reason the card derives itself');
  } finally { teardown(); }
});

test('an exhausted system budget skips the sync and records why', async () => {
  const { queue, events } = setup({
    candidates: [candidate(1, 2)], budgetError: 'system token budget exhausted',
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [], 'no worker turn is dispatched over the cap');
    assert.ok(events.measures.some((m) => m.blockReason === 'budget'),
      'the card should say the platform is out of budget, not that nothing is wrong');
  } finally { teardown(); }
});

test('a proposal already on main skips straight to the merge', async () => {
  const { queue, events } = setup({
    candidates: [candidate(1, 2, { integration_behind_by: 0 })],
    measurement: { behindBy: 0, mergesClean: true, conflictPaths: [] },
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [], 'nothing to integrate, so nothing to spend');
    assert.deepEqual(events.merges, [1]);
  } finally { teardown(); }
});

// ── #2100 / #2095 ─────────────────────────────────────────────────────

test('a pass stops after a merge: the siblings are re-measured against the NEW main', async () => {
  // Carrying on was the thundering herd: one merge, then every sibling
  // synced and rebuilt in a row, each to be synced and rebuilt again once
  // the next one landed. finalizeMerge re-kicks the queue; that fresh pass
  // sees the moved main.
  const { queue, events } = setup({ candidates: [candidate(1, 2), candidate(2, 5), candidate(3, 3)] });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [2], 'exactly one worker turn per landed merge');
    assert.deepEqual(events.merges, [2]);
  } finally { teardown(); }
});

test('a pass stops while a check run is in flight for the current candidate', async () => {
  // Nothing merges before that run reports, and the checks finalizer
  // enqueues the app the moment it does. Syncing the next candidate now
  // would only put it behind whatever this one merges.
  const { queue, events } = setup({
    candidates: [candidate(1, 2), candidate(2, 5)],
    mergeResults: { 2: { merged: false, blockReason: 'checks', checkState: 'pending' } },
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [2]);
    assert.deepEqual(events.merges, [2]);
  } finally { teardown(); }
});

test('a candidate refused for a reason a person must fix does not stop the pass', async () => {
  const { queue, events } = setup({
    candidates: [candidate(1, 2), candidate(2, 5)],
    mergeResults: {
      2: { merged: false, blockReason: 'checks', checkState: 'failing' },
      1: { merged: false, blockReason: 'approvals' },
    },
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [2, 1], 'the sibling still gets its turn');
    assert.deepEqual(events.merges, [2, 1]);
  } finally { teardown(); }
});

test('a locked app with no admin yes is not worth a worker turn', async () => {
  // The lock gate is the admin's say-so; integrating ahead of it spends
  // tokens on a change that may never merge, and the admin's own vote
  // enqueues the app when it lands.
  const { queue, events } = setup({
    candidates: [
      candidate(1, 2, { app_locked: true, admin_yes: false }),
      candidate(2, 5, { app_locked: true, admin_yes: true }),
    ],
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [2], 'only the admin-approved one is integrated');
  } finally { teardown(); }
});

test('checks that failed against the pinned commit are not worth a worker turn either', async () => {
  const head = 'h'.repeat(40);
  const { queue, events } = setup({
    candidates: [
      // Failing on THIS commit: a merge of main into it changes nothing.
      candidate(1, 5, { check_state: 'failing', checks_commit_sha: head, reviewed_head: head }),
      // Failing on an OLDER commit: the pinned head still needs its rebuild,
      // which the checks gate kicks — so the sync goes ahead.
      candidate(2, 4, { check_state: 'failing', checks_commit_sha: 'o'.repeat(40), reviewed_head: head }),
      candidate(3, 3, { check_state: 'error', checks_commit_sha: head, reviewed_head: head }),
    ],
    mergeResults: { 2: { merged: false, blockReason: 'checks', checkState: 'pending' } },
  });
  try {
    await queue.enqueue({}, 7);
    assert.deepEqual(events.syncs, [2]);
  } finally { teardown(); }
});

test("'integrating' is cleared the moment the sync is over, whatever the merge attempt decides", async () => {
  // checkAndMerge only clears it on a successful claim, so a row whose merge
  // then stopped at approvals kept a card that said "syncing with main"
  // long after the sync had finished — the UI half of #2100.
  const { queue, events } = setup({
    candidates: [candidate(1, 2)],
    mergeResults: { 1: { merged: false, blockReason: 'approvals' } },
  });
  try {
    await queue.enqueue({}, 7);
    const writes = events.measures.filter((m) => m.id === 1 && m.write).map((m) => m.write);
    assert.deepEqual(writes, [['integrating'], []],
      'announced, then cleared again — before the row is handed to the merge attempt');
    const remeasure = events.measures.filter((m) => m.id === 1 && m.opts).pop();
    assert.deepEqual(remeasure.opts.blockReasons, [],
      'and the post-sync measurement does not carry the stale reason forward');
    assert.deepEqual(events.merges, [1]);
    const last = events.broadcasts.filter((b) => b.sessionId === 1 && 'integrating' in b).pop();
    assert.equal(last.integrating, false, 'the card is told the sync is over');
  } finally { teardown(); }
});

test('no GitHub mergeability polling happens anywhere in a pass', async () => {
  // The deleted loops were the single largest source of latency in the old
  // path: up to fourteen reads and ~30s of sleeping per cycle.
  const { queue } = setup({ candidates: [candidate(1, 2)] });
  try {
    const github = require('../src/services/github');
    assert.equal(typeof github.getOctokit, 'undefined',
      'the stub exposes no octokit, so any polling attempt would throw');
    await queue.enqueue({}, 7);
  } finally { teardown(); }
});
