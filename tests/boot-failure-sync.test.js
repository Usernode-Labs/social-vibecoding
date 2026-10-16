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

// The sync itself (its once-per-head record written with its own work, the
// wait for nobody working on the session, the new head's run) is the
// proposal machine's: tests/workflow-merge-postgres.test.js M8.

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

test('a start failure that applies returns the plan, and starts nothing itself', async () => {
  const pool = makePool();
  const { deps, calls } = makeDeps();
  const found = await subject.afterBootFailure({
    config: {}, pool, session: row(), commitHash: HEAD, err: { healthcheckFailed: true },
  }, deps);
  assert.deepEqual(found, { sync: true, why: null, behindBy: 2 }, 'the row stays inside the module');
  assert.equal(calls.sync.length, 0, 'the preview machine asks the proposal machine for the sync');
  assert.ok(!pool.queries.some((q) => /boot_failure_sync_head = \$2/.test(q.sql)), 'nothing claimed here');
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

// The preview machine is the caller: its prepare work (WORK.prepare in
// src/workflow/preview/services.ts) asks for the plan when an attempt fails
// and returns it with the failure, and its prepareFailed domain write
// (src/workflow/preview/machine.ts) posts the once-per-streak note. Both
// halves run here, the build and the platform modules stubbed.
function loadPrepare(plan) {
  const paths = {
    staging: require.resolve('../src/services/staging'),
    visuals: require.resolve('../src/services/visuals'),
    sync: require.resolve('../src/services/boot-failure-sync'),
  };
  const asked = [];
  const build = { err: null };
  const originals = [
    [paths.staging, stubModule(paths.staging, {
      prepareAttempt: async () => { throw build.err; },
    })],
    [paths.visuals, stubModule(paths.visuals, {
      summarizeBootFailure: () => '[not_ready] could not create unique index "idx_bot_config_versions_one_current"',
    })],
    [paths.sync, stubModule(paths.sync, {
      afterBootFailure: async (args) => { asked.push(args); return plan; },
      explain: subject.explain,
    })],
  ];
  const { previewServices } = require('../src/workflow/preview/services.ts');
  const { preview, WORK } = require('../src/workflow/preview/machine.ts');
  const pool = { async query(sql) {
    if (/FROM chat_sessions cs JOIN apps/.test(String(sql))) return { rows: [row({ app_id: 10, user_id: 3, pr_number: 4186 })] };
    if (/FROM apps WHERE id/.test(String(sql))) return { rows: [{ id: 10, slug: 'usernode-2d5619' }] };
    return { rows: [] };
  } };
  const prepare = previewServices({ config: {}, pool })[WORK.prepare];
  const prepareFailed = preview({ maxRetries: 5, retireAfterMs: 60000 }).writes.get('prepareFailed');
  // One failed attempt, the way the machine sees it: the work's result,
  // then the domain write its transition makes of it (machine.ts).
  const fail = async (err, tx) => {
    build.err = err;
    const r = await prepare.run({
      input: { sessionId: 6912, appId: 10, n: 1, head: HEAD, db: 'app_usernode_2d5619_staging_s6912_aaaaaa' },
      key: 'prepare:1', attempt: 1, resumeFrom: null, signal: new AbortController().signal, checkpoint: async () => {},
    });
    assert.equal(r.ok, false);
    if (tx) {
      await prepareFailed(tx, {
        type: 'prepareFailed', sessionId: 6912, appId: 10, userId: 3, head: HEAD,
        detail: r.detail, infrastructure: r.infrastructure, platformFault: r.platformFault,
        aboutMain: r.aboutMain, sync: r.sync, source: 'cli_handoff', prNumber: 4186,
      }, { push: () => {} });
    }
    return r;
  };
  const restore = () => {
    for (const [id, original] of originals) {
      if (original) require.cache[id] = original; else delete require.cache[id];
    }
  };
  return { fail, asked, restore };
}

// The verdict is stored and this is the streak's first note.
function streakTx() {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (/SET check_error_notified_at = NOW\(\)/.test(text)) return { rows: [{ id: 6912 }], rowCount: 1 };
      if (/UPDATE chat_sessions/.test(text)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

const posted = (tx) => String(tx.queries.find((q) => /INSERT INTO chat_session_messages/.test(q.sql)).params[1]);

test('#4186: the thread says main is being merged in, not that the build needs fixing', async () => {
  const { fail, asked, restore } = loadPrepare({ sync: true, why: null, behindBy: 2 });
  const tx = streakTx();
  try {
    const err = Object.assign(new Error('not ready'), { healthcheckFailed: true });
    await fail(err, tx);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].commitHash, HEAD);
    assert.equal(asked[0].err, err);
    const text = posted(tx);
    assert.match(text, /^⚠️ Staging preview failed to start\. This proposal is 2 commits behind main/);
    assert.match(text, /Homeroom is merging main into it and will build the preview again\. Reason: \[not_ready\]/);
    assert.doesNotMatch(text, /can't merge yet/);
  } finally { restore(); }
});

test('a proposal level with main is told the cause is its own', async () => {
  const { fail, restore } = loadPrepare({ sync: false, why: 'level', behindBy: 0 });
  const tx = streakTx();
  try {
    await fail(Object.assign(new Error('x'), { healthcheckFailed: true }), tx);
    assert.equal(posted(tx),
      '⚠️ Staging preview failed to start, so automated checks can\'t run and this proposal can\'t merge yet. '
      + 'It already includes everything on main, so the cause is in this change. '
      + 'Reason: [not_ready] could not create unique index "idx_bot_config_versions_one_current"');
  } finally { restore(); }
});

test('no plan leaves the note as it always read', async () => {
  const { fail, restore } = loadPrepare(null);
  const tx = streakTx();
  try {
    await fail(new Error('Build failed'), tx);
    assert.equal(posted(tx),
      '⚠️ Staging preview failed to start, so automated checks can\'t run and this proposal can\'t merge yet. '
      + 'Reason: [not_ready] could not create unique index "idx_bot_config_versions_one_current"');
  } finally { restore(); }
});

test('the fleet\'s own infrastructure failure is never a reason to sync', async () => {
  const { fail, asked, restore } = loadPrepare({ sync: true, why: null, behindBy: 2 });
  try {
    const r = await fail(Object.assign(new Error('not ready'),
      { healthcheckFailed: true, containerLogs: 'FATAL: sorry, too many clients already' }));
    assert.equal(asked.length, 0);
    assert.equal(r.infrastructure, true);
    assert.equal(r.sync, false);
  } finally { restore(); }
});

// ── the column ───────────────────────────────────────────────────────────

test('the schema carries the once-per-head stamp the claim writes', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  assert.match(schema, /ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS boot_failure_sync_head TEXT;/);
});
