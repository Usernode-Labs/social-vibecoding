'use strict';

// services/boot-failure-sync.js: a promoted proposal whose preview will not
// start while it is behind main is synced by the platform, once per head,
// when it merges cleanly. #4186 (7 Oct 2026) was two commits behind #4172,
// whose schema change its own schema.sql could not run against production's
// database; its checks said the build needed fixing, and a sync was the fix.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function stubModule(id, exports) {
  const original = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: original ? original.paths : [] };
  return original;
}

const loggerPath = require.resolve('../src/services/logger');
const logs = [];
stubModule(loggerPath, {
  info: (scope, msg, meta) => logs.push({ level: 'info', msg, meta }),
  warn: (scope, msg, meta) => logs.push({ level: 'warn', msg, meta }),
  error: () => {},
  debug: () => {},
});
const subject = require('../src/services/boot-failure-sync');

const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);

function row(over = {}) {
  return {
    id: 6912, status: 'promoted', source: 'cli_handoff',
    branch_name: 'dev/cli-u1-test-phone-sign-ins-1007',
    repo_url: 'https://github.com/Usernode-Labs/social-vibecoding',
    app_slug: 'usernode-2d5619', checks_commit_sha: HEAD,
    boot_failure_sync_head: null, behind_main: 0,
    ...over,
  };
}

// A pool that answers the row read and the claim, and records every query.
function makePool({ current = row(), claimWins = true } = {}) {
  const queries = [];
  let state = current;
  return {
    queries,
    set(next) { state = next; },
    async query(sql, params) {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (/FROM chat_sessions cs JOIN apps a/.test(text)) return { rows: state ? [state] : [] };
      if (/SET boot_failure_sync_head = \$2/.test(text)) {
        return claimWins ? { rows: [{ id: params[0] }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function makeDeps({
  measured = { headSha: HEAD, behindBy: 2, mergesClean: true },
  busy = () => false,
  integrating = false,
  syncResult = { ok: true, syncResult: 'clean', pushOk: true, sha: NEW_HEAD },
  syncThrows = null,
} = {}) {
  const calls = { measure: [], sync: [], reconcile: [], sleeps: 0 };
  let clock = 0;
  const deps = {
    integration: {
      measure: async ({ session }, options) => {
        calls.measure.push({ session, options });
        if (measured instanceof Error) throw measured;
        return typeof measured === 'function' ? measured(calls.measure.length) : measured;
      },
    },
    syncMain: {
      runSyncMain: async (config, pool, id, opts) => {
        calls.sync.push({ id, opts });
        if (syncThrows) throw syncThrows;
        return syncResult;
      },
    },
    activeWorkers: { isSessionBusy: (id) => busy(id, calls) },
    mergeQueue: { isIntegratingSession: () => integrating },
    votes: () => ({
      reconcileNativeReviewedHead: async (args) => { calls.reconcile.push(args); return {}; },
    }),
    sleep: async (ms) => { calls.sleeps += 1; clock += ms; },
    now: () => clock,
  };
  return { deps, calls };
}

// ── plan: when the platform syncs, and what it says otherwise ────────────

test('a promoted proposal behind main that merges cleanly is synced', async () => {
  const pool = makePool();
  const { deps, calls } = makeDeps();
  const found = await subject.plan({ pool, sessionId: 6912, commitHash: HEAD }, deps);
  assert.equal(found.sync, true);
  assert.equal(found.behindBy, 2);
  assert.equal(calls.measure.length, 1);
  assert.deepEqual(calls.measure[0].options, { force: true }, 'measured now, not from a stale column');
});

test('a draft, an imported PR, or a head that has moved since is left alone, unmeasured', async () => {
  for (const [over, why] of [
    [{ status: 'active' }, 'not_promoted'],
    [{ source: 'imported' }, 'imported'],
    [{ checks_commit_sha: NEW_HEAD }, 'head_moved'],
    [{ branch_name: null }, 'no_branch'],
  ]) {
    const { deps, calls } = makeDeps();
    const found = await subject.plan({ pool: makePool({ current: row(over) }), sessionId: 6912, commitHash: HEAD }, deps);
    assert.deepEqual(found, { sync: false, why, behindBy: null }, why);
    assert.equal(calls.measure.length, 0, `${why}: nothing measured`);
  }
});

test('a proposal that already contains main failed on its own account', async () => {
  const { deps } = makeDeps({ measured: { headSha: HEAD, behindBy: 0, mergesClean: true } });
  const found = await subject.plan({ pool: makePool(), sessionId: 6912, commitHash: HEAD }, deps);
  assert.deepEqual(found, { sync: false, why: 'level', behindBy: 0 });
});

test('a conflict is the merge queue\'s, and a head already tried is a person\'s', async () => {
  let r = makeDeps({ measured: { headSha: HEAD, behindBy: 3, mergesClean: false } });
  assert.deepEqual(await subject.plan({ pool: makePool(), sessionId: 6912, commitHash: HEAD }, r.deps),
    { sync: false, why: 'conflict', behindBy: 3 });
  r = makeDeps();
  assert.deepEqual(
    await subject.plan({ pool: makePool({ current: row({ boot_failure_sync_head: HEAD }) }), sessionId: 6912, commitHash: HEAD }, r.deps),
    { sync: false, why: 'already_tried', behindBy: 2 },
    'still measured, so the note can say it is behind');
});

test('a measurement that fails, or reads another head, never syncs and never throws', async () => {
  for (const measured of [new Error('mirror down'), { error: 'branch not in the mirror' }, { skipped: 'incomplete_session' }]) {
    const { deps } = makeDeps({ measured });
    const found = await subject.plan({ pool: makePool(), sessionId: 6912, commitHash: HEAD }, deps);
    assert.deepEqual(found, { sync: false, why: 'unmeasured', behindBy: null });
  }
  const { deps } = makeDeps({ measured: { headSha: NEW_HEAD, behindBy: 2, mergesClean: true } });
  assert.equal((await subject.plan({ pool: makePool(), sessionId: 6912, commitHash: HEAD }, deps)).why, 'head_moved');
});

// ── run: wait, claim, sync, start the new head's run ─────────────────────

test('the sync claims the head, runs as the platform, and starts the new head\'s run', async () => {
  const pool = makePool();
  const { deps, calls } = makeDeps();
  const out = await subject.run({ config: { c: 1 }, pool, sessionId: 6912, commitHash: HEAD }, deps);
  assert.deepEqual(out, { synced: true, why: null, sha: NEW_HEAD });
  const claim = pool.queries.find((q) => /SET boot_failure_sync_head = \$2/.test(q.sql));
  assert.ok(claim, 'the head is claimed before the sync');
  assert.match(claim.sql, /status = 'promoted'/);
  assert.match(claim.sql, /checks_commit_sha = \$2/, 'only while the row still describes the failed head');
  assert.match(claim.sql, /boot_failure_sync_head IS DISTINCT FROM \$2/, 'once per head');
  assert.deepEqual(claim.params, [6912, HEAD]);
  assert.equal(calls.sync.length, 1);
  assert.equal(calls.sync[0].opts.trigger, 'boot_failure');
  assert.equal(calls.sync[0].opts.sessionRow.behind_main, 2,
    'the measured count, so the sync narrates in the timeline');
  assert.equal(calls.reconcile.length, 1, 'the merge queue\'s own follow-up: re-pin and run');
  assert.equal(calls.reconcile[0].fresh, true);
  assert.equal(calls.reconcile[0].notify, false);
  assert.equal(calls.measure.length, 2, 'measured before the claim and again for the pushed head');
});

test('a session in the middle of a turn is waited for, not interrupted', async () => {
  const pool = makePool();
  const { deps, calls } = makeDeps({ busy: (_id, c) => c.sleeps < 3 });
  const out = await subject.run({ config: {}, pool, sessionId: 6912, commitHash: HEAD }, deps);
  assert.equal(out.synced, true);
  assert.equal(calls.sleeps, 3);
  const never = makeDeps({ busy: () => true });
  const gaveUp = await subject.run({ config: {}, pool: makePool(), sessionId: 6912, commitHash: HEAD }, never.deps);
  assert.deepEqual(gaveUp, { synced: false, why: 'busy' });
  assert.equal(never.calls.sync.length, 0);
  assert.equal(never.calls.sleeps, Math.ceil(subject.IDLE_WAIT_MS / subject.IDLE_POLL_MS));
});

test('no sync when the merge queue holds it, the claim is lost, or the head moved while it waited', async () => {
  let r = makeDeps({ integrating: true });
  assert.deepEqual(await subject.run({ config: {}, pool: makePool(), sessionId: 6912, commitHash: HEAD }, r.deps),
    { synced: false, why: 'integrating' });
  assert.equal(r.calls.sync.length, 0);

  r = makeDeps();
  assert.deepEqual(await subject.run({ config: {}, pool: makePool({ claimWins: false }), sessionId: 6912, commitHash: HEAD }, r.deps),
    { synced: false, why: 'claimed' });
  assert.equal(r.calls.sync.length, 0);

  r = makeDeps();
  const pool = makePool({ current: row({ checks_commit_sha: NEW_HEAD }) });
  assert.deepEqual(await subject.run({ config: {}, pool, sessionId: 6912, commitHash: HEAD }, r.deps),
    { synced: false, why: 'head_moved' });
  assert.ok(!pool.queries.some((q) => /boot_failure_sync_head = \$2/.test(q.sql)), 'nothing claimed');
});

test('a sync that pushes nothing, or throws, starts no run', async () => {
  for (const syncResult of [
    { ok: false, syncResult: 'conflict', pushOk: false },
    { ok: true, syncResult: 'already_synced', pushOk: false },
    { ok: true, syncResult: 'clean', pushOk: false },
  ]) {
    const { deps, calls } = makeDeps({ syncResult });
    const out = await subject.run({ config: {}, pool: makePool(), sessionId: 6912, commitHash: HEAD }, deps);
    assert.equal(out.synced, false, syncResult.syncResult);
    assert.equal(calls.reconcile.length, 0);
  }
  const { deps, calls } = makeDeps({ syncThrows: new Error('system token budget exhausted') });
  assert.deepEqual(await subject.run({ config: {}, pool: makePool(), sessionId: 6912, commitHash: HEAD }, deps),
    { synced: false, why: 'sync_threw' });
  assert.equal(calls.reconcile.length, 0);
});

// ── afterBootFailure: the entry staging-recovery calls ───────────────────

test('only a preview that failed to START is considered, never a failed build', async () => {
  const pool = makePool();
  const { deps, calls } = makeDeps();
  for (const err of [new Error('Build failed'), { buildFailed: true }, null]) {
    assert.equal(await subject.afterBootFailure({ config: {}, pool, session: row(), commitHash: HEAD, err }, deps), null);
  }
  assert.equal(await subject.afterBootFailure({
    config: {}, pool, session: row({ source: 'imported' }), commitHash: HEAD, err: { healthcheckFailed: true },
  }, deps), null, 'imported PRs follow pr-import-sync');
  assert.equal(pool.queries.length, 0);
  assert.equal(calls.measure.length, 0);
});

test('a start failure that applies returns the plan at once and syncs in the background', async () => {
  const pool = makePool();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { deps, calls } = makeDeps();
  deps.syncMain.runSyncMain = async (config, p, id, opts) => {
    calls.sync.push({ id, opts });
    await gate;
    return { ok: true, syncResult: 'clean', pushOk: true, sha: NEW_HEAD };
  };
  const found = await subject.afterBootFailure({
    config: {}, pool, session: row(), commitHash: HEAD, err: { healthcheckFailed: true },
  }, deps);
  assert.deepEqual(found, { sync: true, why: null, behindBy: 2 }, 'the row stays inside the module');
  // A backoff retry while the first is still going does not start a second.
  await subject.afterBootFailure({
    config: {}, pool, session: row(), commitHash: HEAD, err: { healthcheckFailed: true },
  }, deps);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.sync.length, 1);
  assert.ok(subject._pending.has(6912));
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(!subject._pending.has(6912));
  assert.equal(calls.reconcile.length, 1);
});

// ── what the author reads ────────────────────────────────────────────────

test('the note says what main has to do with it, in words', () => {
  assert.match(subject.explain({ sync: true, behindBy: 2 }),
    /^This proposal is 2 commits behind main, .* so Homeroom is merging main into it and will build the preview again\.$/);
  assert.match(subject.explain({ sync: true, behindBy: 1 }), /1 commit behind main/);
  assert.equal(subject.explain({ sync: false, why: 'level', behindBy: 0 }),
    'It already includes everything on main, so the cause is in this change.');
  assert.equal(subject.explain({ sync: false, why: 'conflict', behindBy: 4 }),
    'It is 4 commits behind main; syncing it with main may fix this.');
  assert.equal(subject.explain({ sync: false, why: 'imported', behindBy: null }), '');
  assert.equal(subject.explain(null), '');
});

function loadRecovery(plan) {
  const paths = {
    visuals: require.resolve('../src/services/visuals'),
    ws: require.resolve('../src/services/ws'),
    dm: require.resolve('../src/services/homeroom-bot-dm'),
    notifications: require.resolve('../src/services/notifications'),
    sync: require.resolve('../src/services/boot-failure-sync'),
    subject: require.resolve('../src/services/staging-recovery'),
  };
  const asked = [];
  const originals = [
    [paths.visuals, stubModule(paths.visuals, {
      storeChecks: async () => true,
      summarizeBootFailure: () => '[not_ready] could not create unique index "idx_bot_config_versions_one_current"',
    })],
    [paths.ws, stubModule(paths.ws, { broadcastGlobal: () => {}, pushSessionUpdate: () => {}, sendSystemMessage: async () => {} })],
    [paths.dm, stubModule(paths.dm, { noteChangeStopped: async () => null })],
    [paths.notifications, stubModule(paths.notifications, {
      createCheckFailedNotification: async () => [], hydrateAndPush: async () => {},
    })],
    [paths.sync, stubModule(paths.sync, {
      afterBootFailure: async (args) => { asked.push(args); return plan; },
      explain: subject.explain,
    })],
  ];
  delete require.cache[paths.subject];
  const recovery = require('../src/services/staging-recovery');
  const restore = () => {
    for (const [id, original] of originals) {
      if (original) require.cache[id] = original; else delete require.cache[id];
    }
    delete require.cache[paths.subject];
  };
  return { recovery, asked, restore };
}

function streakPool() {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (/SELECT user_id, app_id, pr_number/.test(String(sql))) {
        return { rows: [{ user_id: 3, app_id: 10, pr_number: 4186, consecutive_check_failures: 1, check_error_notified_at: null }] };
      }
      return { rows: [], rowCount: 1 };
    },
  };
}

const posted = (pool) => String(pool.queries.find((q) => /INSERT INTO chat_session_messages/.test(q.sql)).params[1]);

test('#4186: the thread says main is being merged in, not that the build needs fixing', async () => {
  const { recovery, asked, restore } = loadRecovery({ sync: true, why: null, behindBy: 2 });
  const pool = streakPool();
  try {
    const err = Object.assign(new Error('not ready'), { healthcheckFailed: true });
    await recovery.recordStagingBootFailure({ config: {}, pool, session: row(), commitHash: HEAD, err });
    assert.equal(asked.length, 1);
    assert.equal(asked[0].commitHash, HEAD);
    assert.equal(asked[0].err, err);
    const text = posted(pool);
    assert.match(text, /^⚠️ Staging preview failed to start\. This proposal is 2 commits behind main/);
    assert.match(text, /Homeroom is merging main into it and will build the preview again\. Reason: \[not_ready\]/);
    assert.doesNotMatch(text, /can't merge yet/);
  } finally { restore(); }
});

test('a proposal level with main is told the cause is its own', async () => {
  const { recovery, restore } = loadRecovery({ sync: false, why: 'level', behindBy: 0 });
  const pool = streakPool();
  try {
    await recovery.recordStagingBootFailure({
      config: {}, pool, session: row(), commitHash: HEAD, err: { healthcheckFailed: true, message: 'x' },
    });
    assert.equal(posted(pool),
      '⚠️ Staging preview failed to start, so automated checks can\'t run and this proposal can\'t merge yet. '
      + 'It already includes everything on main, so the cause is in this change. '
      + 'Reason: [not_ready] could not create unique index "idx_bot_config_versions_one_current"');
  } finally { restore(); }
});

test('no plan leaves the note as it always read', async () => {
  const { recovery, restore } = loadRecovery(null);
  const pool = streakPool();
  try {
    await recovery.recordStagingBootFailure({
      config: {}, pool, session: row(), commitHash: HEAD, err: new Error('Build failed'),
    });
    assert.equal(posted(pool),
      '⚠️ Staging preview failed to start, so automated checks can\'t run and this proposal can\'t merge yet. '
      + 'Reason: [not_ready] could not create unique index "idx_bot_config_versions_one_current"');
  } finally { restore(); }
});

test('the fleet\'s own infrastructure failure is never a reason to sync', async () => {
  const { recovery, asked, restore } = loadRecovery({ sync: true, why: null, behindBy: 2 });
  try {
    await recovery.recordStagingBootFailure({
      config: {}, pool: streakPool(), session: row(), commitHash: HEAD,
      err: { healthcheckFailed: true, containerLogs: 'FATAL: sorry, too many clients already' },
    });
    assert.equal(asked.length, 0);
  } finally { restore(); }
});

// ── the column ───────────────────────────────────────────────────────────

test('the schema carries the once-per-head stamp the claim writes', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  assert.match(schema, /ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS boot_failure_sync_head TEXT;/);
});
