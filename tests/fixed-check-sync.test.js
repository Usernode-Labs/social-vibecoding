'use strict';

// services/fixed-check-sync.js: a promoted proposal whose only blocking
// failures are checks main failed too, and has since fixed, is synced with
// main by the platform, once per head and once per check.
//
// What it is for (9 Oct 2026): the Custom domain check (#4405) failed on
// every proposal because its staging fixture made the wrong account the
// project's manager. The fix (#4576) merged, and about fifteen proposals,
// several approved, stayed red on it, because each preview builds its own
// branch's copy of the fixture. Sync is the owner's button, and nobody
// presses it on the Homeroom bot's proposals.
//
// Run with: node --test tests/fixed-check-sync.test.js

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
const subject = require('../src/services/fixed-check-sync');
const appManifest = require('../src/services/app-manifest');
const { UNIT_CHECK_NAME, UNIT_CHECK_PATH, UNIT_CHECK_INDEX } = require('../src/services/unit-suite-row');

const ROOT = path.join(__dirname, '..');
const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);

const DOMAIN = {
  name: 'The hub\'s ⋯ menu offers Custom domain in its Settings & rules panel to whoever manages the project (#4405)',
  path: '/?demo=1&ws=status#app/staging-demo-custom-domain/dev',
};
const PICKER = { name: 'Assignee picker opens', path: '/#app/x/dev' };
const UNIT = { name: UNIT_CHECK_NAME, path: UNIT_CHECK_PATH, index: UNIT_CHECK_INDEX };
const key = (c) => appManifest.checkKey(c.name, c.path);

// A row as openVerdicts returns it.
function verdict(id, failing, over = {}) {
  return {
    id, source: 'cli_handoff', check_state: 'failing',
    checks_commit_sha: HEAD, reviewed_head_sha: HEAD,
    fixed_check_sync_head: null, fixed_check_sync_keys: null,
    failing: failing.map((f) => ({ advisory: false, ...f })),
    ...over,
  };
}

// ── select: who is stuck on main's failure ───────────────────────────────

test('9 Oct: proposals failing only a check main now passes, and that fails across them, are picked', () => {
  const rows = [
    verdict(7504, [DOMAIN]),
    verdict(7498, [DOMAIN, UNIT]),
    // Checked while the check was still advisory: evidence it is main's,
    // but its own verdict passed, so it is not stuck on checks.
    verdict(7489, [{ ...DOMAIN, advisory: true }], { check_state: 'passing' }),
  ];
  const { candidates, skipped } = subject.select(rows, new Set([key(DOMAIN)]));
  assert.deepEqual(candidates.map((c) => c.id), [7504, 7498]);
  assert.deepEqual(candidates[0], { id: 7504, head: HEAD, keys: [key(DOMAIN)] });
  assert.deepEqual(candidates[1].keys, [key(DOMAIN)],
    'the unit-suite row neither counts as fixed nor stops the sync: the new run re-tests it');
  assert.deepEqual(skipped, {}, 'a passing verdict is not a candidate and not a skip either');
});

test('a check failing on one proposal alone is that proposal\'s to fix', () => {
  const { candidates, skipped } = subject.select([verdict(1, [DOMAIN])], new Set([key(DOMAIN)]));
  assert.deepEqual(candidates, []);
  assert.deepEqual(skipped, { 1: 'own_failure' });
});

test('nothing is synced while main itself still fails the check', () => {
  // A sync would only copy main's broken fixture again, and spend the one
  // try each check gets.
  const rows = [verdict(1, [DOMAIN]), verdict(2, [DOMAIN])];
  const { candidates, skipped } = subject.select(rows, new Set());
  assert.deepEqual(candidates, []);
  assert.deepEqual(skipped, { 1: 'main_fails', 2: 'main_fails' });
});

test('one failure of its own beside main\'s keeps a proposal for its author', () => {
  const rows = [verdict(1, [DOMAIN, PICKER]), verdict(2, [DOMAIN])];
  const { candidates, skipped } = subject.select(rows, new Set([key(DOMAIN), key(PICKER)]));
  assert.deepEqual(candidates.map((c) => c.id), [2]);
  assert.equal(skipped[1], 'own_failure', 'the picker check fails on it alone');
});

test('only the unit suite failing (main not green since), an imported head, a moved head or a head already synced: no sync', () => {
  const passes = new Set([key(DOMAIN)]);
  // Two others failing it, so the check is main's whatever row 1 says.
  const others = [verdict(9, [DOMAIN]), verdict(10, [DOMAIN])];
  for (const [row, why] of [
    [verdict(1, [UNIT]), 'unit_suite_only'],
    [verdict(1, [{ ...UNIT, advisory: true }]), 'nothing_fixed'],
    [verdict(1, [DOMAIN], { source: 'imported' }), 'imported'],
    [verdict(1, [DOMAIN], { reviewed_head_sha: NEW_HEAD }), 'head_moved'],
    [verdict(1, [DOMAIN], { fixed_check_sync_head: HEAD.toUpperCase() }), 'already_tried'],
    [verdict(1, [DOMAIN], { checks_commit_sha: null }), 'no_verdict'],
  ]) {
    const { candidates, skipped } = subject.select([row, ...others], passes);
    assert.deepEqual(candidates.map((c) => c.id), [9, 10], why);
    assert.equal(skipped[1], why);
  }
});

// 10 Oct 2026: five challenge tests failed every weekend until #4648 fixed
// them on main. Two approved Homeroom bot proposals cut before it failed only
// the unit suite on them and stayed red: the rule above needs a named check
// that fails across proposals, and the unit-suite row names none. Main watch
// runs the same suite on main itself, so main green AFTER a proposal's run is
// the evidence instead.
test('a proposal failing only the unit suite is synced once main watch has passed since its run', () => {
  const ran = '2026-10-10T08:46:04.000Z';
  const row = verdict(7629, [UNIT], { checks_checked_at: ran });
  const greenAfter = { passing: true, at: Date.parse('2026-10-10T11:01:15Z') };

  const { candidates } = subject.select([row], new Set(), greenAfter);
  assert.deepEqual(candidates, [{ id: 7629, head: HEAD, keys: [subject.UNIT_KEY] }],
    'synced once, recorded under the unit suite\'s own key');

  for (const [watch, why] of [
    [{ passing: true, at: Date.parse('2026-10-10T08:00:00Z') }, 'green before its run: main has not moved since'],
    [{ passing: false, at: Date.parse('2026-10-10T11:01:15Z') }, 'main is red itself'],
    [null, 'no main watch on this app'],
  ]) {
    const out = subject.select([row], new Set(), watch);
    assert.deepEqual(out.candidates, [], why);
    assert.equal(out.skipped[7629], 'unit_suite_only', why);
  }

  const synced = verdict(7629, [UNIT], {
    checks_checked_at: ran, fixed_check_sync_head: NEW_HEAD, fixed_check_sync_keys: [subject.UNIT_KEY],
  });
  assert.equal(subject.select([synced], new Set(), greenAfter).skipped[7629], 'already_tried',
    'still failing on a head that contains main: the proposal\'s own');

  // A named check of its own beside it is still the author's.
  const mixed = verdict(7630, [UNIT, PICKER], { checks_checked_at: ran });
  assert.equal(subject.select([mixed], new Set([key(PICKER)]), greenAfter).skipped[7630], 'own_failure');
});

// 10 Oct 2026, the same evening: #4720 fixed a unit test (TEST_SHARD leaking
// into a nested run) and shipped at 21:26; main watch passed on that release
// at 21:32. Six approved proposals cut before it were re-run after an outage
// and five ended red on that one test at 21:40-21:45. Main had not moved
// since, and nothing was ready to merge, so "green since its run" never came.
// Main green on the tip they are behind is the same evidence: syncOne still
// measures that the proposal is behind main and leaves one level with it.
test('a proposal failing only the unit suite is synced when main watch passed on main\'s tip, whenever its run was', () => {
  const TIP = 'c'.repeat(40);
  const row = verdict(7732, [UNIT], { checks_checked_at: '2026-10-10T21:40:48.000Z' });
  const greenTip = { passing: true, at: Date.parse('2026-10-10T21:32:20Z'), sha: TIP, tip: TIP };

  assert.deepEqual(subject.select([row], new Set(), greenTip).candidates,
    [{ id: 7732, head: HEAD, keys: [`${subject.UNIT_KEY}@${TIP}`] }],
    'recorded with the main it was synced against');
  assert.deepEqual(subject.select([row], new Set(), { ...greenTip, tip: TIP.toUpperCase() }).candidates.map((c) => c.id), [7732],
    'shas compare whatever their case');

  for (const [watch, why] of [
    [{ ...greenTip, tip: 'd'.repeat(40) }, 'main moved past the green commit and is not judged yet'],
    [{ ...greenTip, passing: false }, 'main is red itself'],
    [{ ...greenTip, sha: null }, 'no commit recorded'],
  ]) {
    const out = subject.select([row], new Set(), watch);
    assert.deepEqual(out.candidates, [], why);
    assert.equal(out.skipped[7732], 'unit_suite_only', why);
  }
  const synced = verdict(7732, [UNIT], { fixed_check_sync_head: NEW_HEAD, fixed_check_sync_keys: [subject.unitSyncKey(TIP)] });
  assert.equal(subject.select([synced], new Set(), greenTip).skipped[7732], 'already_tried',
    'once per main: still failing on a head that contains this one, the failure is the proposal\'s own');
  assert.equal(subject.select([synced], new Set(), { ...greenTip, tip: TIP.toUpperCase() }).skipped[7732], 'already_tried',
    'the recorded tip compares whatever its case');
});

// 11 Oct 2026: the translation proposal #4764 failed one unit test that
// pinned the shell to English alone. The sweep synced it onto main as it
// was, before #4767 fixed that test, so its synced head still failed, and
// once-per-proposal skipped it from then on: red with two yes votes and a
// fixed main, and nobody able to press Sync on Homeroom's own proposal. One
// row stands for every test, so failing on a head containing one main says
// nothing about a later main.
test('a proposal failing only the unit suite is synced again once main moves on and is green, at most MAX_UNIT_SYNCS times', () => {
  const OLD_TIP = 'c'.repeat(40);
  const TIP = 'd'.repeat(40);
  const ran = '2026-10-11T14:05:00.000Z';
  const greenTip = { passing: true, at: Date.parse('2026-10-11T19:40:00Z'), sha: TIP, tip: TIP };
  const after = (keys, over = {}) => verdict(7825, [UNIT], {
    checks_checked_at: ran, fixed_check_sync_head: NEW_HEAD, fixed_check_sync_keys: keys, ...over,
  });

  // Synced once before the tip was recorded (a bare key), or with an older main.
  for (const keys of [[subject.UNIT_KEY], [subject.unitSyncKey(OLD_TIP)]]) {
    assert.deepEqual(subject.select([after(keys)], new Set(), greenTip).candidates,
      [{ id: 7825, head: HEAD, keys: [subject.unitSyncKey(TIP)] }], keys[0]);
    assert.deepEqual(subject.select([after(keys)], new Set(), { ...greenTip, sha: OLD_TIP }).candidates.map((c) => c.id), [7825],
      'main watch green since its run is enough, as for the first');
  }

  for (const [watch, why] of [
    [{ ...greenTip, passing: false }, 'main is red itself'],
    [{ ...greenTip, sha: OLD_TIP, at: Date.parse('2026-10-11T13:00:00Z') }, 'green only before its run, on a main it already has'],
  ]) {
    const out = subject.select([after([subject.UNIT_KEY])], new Set(), watch);
    assert.deepEqual(out.candidates, [], why);
    assert.equal(out.skipped[7825], 'unit_suite_only', why);
  }

  assert.equal(subject.select([after([subject.UNIT_KEY])], new Set(), { ...greenTip, tip: null }).skipped[7825], 'already_tried',
    'with no tip, a later main cannot be told from the one it was synced with');

  const used = [subject.UNIT_KEY, subject.unitSyncKey(OLD_TIP), subject.unitSyncKey('e'.repeat(40))];
  assert.equal(used.length, subject.MAX_UNIT_SYNCS);
  assert.equal(subject.select([after(used)], new Set(), greenTip).skipped[7825], 'already_tried',
    'a proposal whose own change breaks a test stops costing runs');
  assert.deepEqual(subject.select([after(used.slice(1))], new Set(), greenTip).candidates.map((c) => c.id), [7825]);

  // A named check's key beside them is not a unit-suite sync.
  const mixed = after([subject.UNIT_KEY, key(DOMAIN), key(PICKER)]);
  assert.deepEqual(subject.select([mixed], new Set(), greenTip).candidates.map((c) => c.id), [7825]);
});

test('main watch\'s verdict carries the commit it judged and main\'s tip', async () => {
  const TIP = 'c'.repeat(40);
  let sql = null;
  const pool = { query: async (q) => {
    sql = q;
    return { rows: [{ main_check_state: 'passing', main_check_at: '2026-10-10T21:32:20Z', main_check_sha: TIP, main_sha: TIP }] };
  } };
  assert.deepEqual(await subject.mainWatchVerdict(pool, 5),
    { passing: true, at: Date.parse('2026-10-10T21:32:20Z'), sha: TIP, tip: TIP });
  assert.match(sql, /SELECT main_check_state, main_check_at, main_check_sha, main_sha FROM apps WHERE id = \$1/);
});

test('a check a proposal was already synced for is never a reason to sync it again', () => {
  // It contains a main that passes the check and still fails it: its own.
  const rows = [
    verdict(1, [DOMAIN], { fixed_check_sync_head: NEW_HEAD, fixed_check_sync_keys: [key(DOMAIN)] }),
    verdict(2, [DOMAIN]),
  ];
  const { candidates, skipped } = subject.select(rows, new Set([key(DOMAIN)]));
  assert.deepEqual(candidates.map((c) => c.id), [2]);
  assert.equal(skipped[1], 'already_tried');
});

// ── syncOne: measure, claim, sync, start the new head's run ─────────────

function fullRow(over = {}) {
  return {
    id: 7504, status: 'promoted', source: 'cli_handoff', check_state: 'failing',
    branch_name: 'dev/homeroom_bot-homeroom-bot-4571-fix',
    repo_url: 'https://github.com/Usernode-Labs/social-vibecoding',
    app_slug: 'usernode-2d5619', checks_commit_sha: HEAD, behind_main: 0,
    ...over,
  };
}

function makePool({ current = fullRow(), claimWins = true } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (/FROM chat_sessions cs JOIN apps a/.test(text)) return { rows: current ? [current] : [] };
      if (/SET fixed_check_sync_head = \$2/.test(text)) {
        return claimWins ? { rows: [{ id: params[0] }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// The sync is the proposal machine's (platform.ts requestSync): it decides
// whether it may run (nobody working on it, not being merged, not synced for
// this head yet), writes the once-record with the sync's own work, runs it
// and starts the new head's run (tests/workflow-merge-postgres.test.js M8).
function makeDeps({
  measured = { headSha: HEAD, behindBy: 5, mergesClean: true },
  answer = { status: 'accepted', sync: 1, lastSync: { n: 1, outcome: 'clean', sha: NEW_HEAD } },
} = {}) {
  const calls = { measure: [], sync: [] };
  const deps = {
    integration: {
      measure: async ({ session }, options) => {
        calls.measure.push({ session, options });
        return measured;
      },
    },
    platform: () => ({
      requestSync: async (p) => { calls.sync.push(p); return typeof answer === 'function' ? answer(p) : answer; },
    }),
  };
  return { deps, calls };
}

const CANDIDATE = { id: 7504, head: HEAD, keys: [key(DOMAIN)] };

test('a stuck proposal behind main and clean is asked of the proposal machine, on its head, with its checks', async () => {
  const pool = makePool();
  const { deps, calls } = makeDeps();
  const out = await subject.syncOne({ config: { c: 1 }, pool, candidate: CANDIDATE }, deps);
  assert.deepEqual(out, { synced: true, why: null, sha: NEW_HEAD });
  assert.equal(calls.measure.length, 1, 'measured first');
  assert.deepEqual(calls.sync.map(({ sessionId, reason, head, keys, wait }) => ({ sessionId, reason, head, keys, wait })),
    [{ sessionId: 7504, reason: 'fixed_check', head: HEAD, keys: [key(DOMAIN)], wait: true }]);
  assert.ok(!pool.queries.some((q) => /SET fixed_check_sync_head/.test(q.sql)), 'the once-record is the machine\'s to write');
});

test('level with main, conflicting, a moved head, or refused by the proposal machine (tried, busy): nothing is synced', async () => {
  for (const [opts, poolOpts, why] of [
    [{ measured: { headSha: HEAD, behindBy: 0, mergesClean: true } }, {}, 'level'],
    [{ measured: { headSha: HEAD, behindBy: 3, mergesClean: false } }, {}, 'conflict'],
    [{ measured: { headSha: NEW_HEAD, behindBy: 3, mergesClean: true } }, {}, 'head_moved'],
    [{ measured: { error: 'mirror down' } }, {}, 'unmeasured'],
    [{ answer: { status: 'rejected', reason: 'already_tried' } }, {}, 'already_tried'],
    [{ answer: { status: 'rejected', reason: 'busy' } }, {}, 'busy'],
    [{ answer: { status: 'faulted', reason: 'boom' } }, {}, 'threw'],
    [{}, { current: fullRow({ checks_commit_sha: NEW_HEAD }) }, 'head_moved'],
    [{}, { current: fullRow({ status: 'merged' }) }, 'gone'],
  ]) {
    const { deps, calls } = makeDeps(opts);
    const out = await subject.syncOne({ config: {}, pool: makePool(poolOpts), candidate: CANDIDATE }, deps);
    assert.deepEqual(out, { synced: false, why }, why);
    if (!opts.answer) assert.equal(calls.sync.length, 0, `${why}: never asked`);
  }
  // Recorded, not decided yet (the conductor slow or restarting): a sync has
  // no deadline, so it still runs: asked for, not refused, and not a fault.
  const { deps } = makeDeps({ answer: { status: 'pending', requestKey: 'k' } });
  const out = await subject.syncOne({ config: {}, pool: makePool({}), candidate: CANDIDATE }, deps);
  assert.deepEqual(out, { synced: false, requested: true, why: 'pending' });
});

test('a sync that pushes nothing reports it and starts no run', async () => {
  const { deps } = makeDeps({ answer: { status: 'accepted', sync: 2, lastSync: { n: 2, outcome: 'unresolvable' } } });
  const out = await subject.syncOne({ config: {}, pool: makePool(), candidate: CANDIDATE }, deps);
  assert.deepEqual(out, { synced: false, why: 'conflict' });
});

// ── syncBeforeHandOff: the Homeroom bot's one sync before a person ───────
// PR #4851 sat red from 12 Oct, 18 yes votes waiting, on a test #4843 had
// fixed on main: the bot's fix turn found it was not the change's, handed it
// to a person, and main watch never read green, so nothing synced it.

// The pool syncOne reads, plus the keys a proposal's syncs left on it.
function handOffPool({ keys = null, ...rest } = {}) {
  const pool = makePool(rest);
  const query = pool.query.bind(pool);
  pool.query = async (sql, params) => {
    if (/SELECT fixed_check_sync_keys FROM chat_sessions/.test(String(sql))) {
      pool.queries.push({ sql: String(sql), params });
      return { rows: rest.current === null ? [] : [{ fixed_check_sync_keys: keys }] };
    }
    return query(sql, params);
  };
  return pool;
}

test('before the bot hands red checks to a person, its proposal is synced with main once, through the same claim', async () => {
  const pool = handOffPool({ keys: [key(DOMAIN)] });
  const { deps, calls } = makeDeps();
  const out = await subject.syncBeforeHandOff({ config: { c: 1 }, pool, sessionId: 7504, head: HEAD.toUpperCase() }, deps);
  assert.deepEqual(out, { synced: true, why: null, sha: NEW_HEAD });
  assert.deepEqual([calls.sync[0].reason, calls.sync[0].head, calls.sync[0].keys], ['bot_handoff', HEAD, [subject.BOT_HANDOFF_KEY]],
    'on the head the sweep syncs, so the two never both sync it; a sweep\'s key is no reason not to');
});

test('once per proposal, never while off, and only what syncOne would sync', async () => {
  const { deps, calls } = makeDeps();
  const tried = handOffPool({ keys: [subject.BOT_HANDOFF_KEY] });
  assert.deepEqual(await subject.syncBeforeHandOff({ config: {}, pool: tried, sessionId: 7504, head: HEAD }, deps),
    { synced: false, why: 'already_tried' }, 'a check still red on a head that contains main is handed over');
  assert.deepEqual(await subject.syncBeforeHandOff({ config: {}, pool: handOffPool({ current: null }), sessionId: 7504, head: HEAD }, deps),
    { synced: false, why: 'gone' });
  assert.deepEqual(await subject.syncBeforeHandOff({ config: {}, pool: handOffPool(), sessionId: 7504, head: null }, deps),
    { synced: false, why: 'no_verdict' });
  const level = makeDeps({ measured: { headSha: HEAD, behindBy: 0, mergesClean: true } });
  assert.deepEqual(await subject.syncBeforeHandOff({ config: {}, pool: handOffPool(), sessionId: 7504, head: HEAD }, level.deps),
    { synced: false, why: 'level' }, 'a change level with main has nothing to gain');
  const conflict = makeDeps({ measured: { headSha: HEAD, behindBy: 182, mergesClean: false } });
  assert.deepEqual(await subject.syncBeforeHandOff({ config: {}, pool: handOffPool(), sessionId: 7504, head: HEAD }, conflict.deps),
    { synced: false, why: 'conflict' }, 'a conflict is a person\'s to resolve');
  const down = { async query() { throw new Error('db down'); } };
  assert.deepEqual(await subject.syncBeforeHandOff({ config: {}, pool: down, sessionId: 7504, head: HEAD }, deps),
    { synced: false, why: 'threw' }, 'never throws');
  const before = process.env.FIXED_CHECK_SYNC_ENABLED;
  try {
    process.env.FIXED_CHECK_SYNC_ENABLED = '0';
    assert.deepEqual(await subject.syncBeforeHandOff({ config: {}, pool: handOffPool(), sessionId: 7504, head: HEAD }, deps),
      { synced: false, why: 'disabled' });
  } finally {
    if (before === undefined) delete process.env.FIXED_CHECK_SYNC_ENABLED;
    else process.env.FIXED_CHECK_SYNC_ENABLED = before;
  }
  assert.equal(calls.sync.length, 0, 'none of those synced anything');
});

// ── selectOwn / syncBeforeFix: the bot's own failing proposals (#5220) ──
//
// Before the bot's fix turn is spent, its proposal is judged alone: main
// passing every failing check now is the evidence, where the sweep needs a
// second proposal failing the same check to say the check, not the change,
// is what broke.

test('selectOwn picks a single proposal failing a check main passes, where select calls it own_failure', () => {
  const out = subject.selectOwn(verdict(1, [DOMAIN]), new Set([key(DOMAIN)]));
  assert.deepEqual(out.candidate, { id: 1, head: HEAD, keys: [key(DOMAIN)] });
  const swept = subject.select([verdict(1, [DOMAIN])], new Set([key(DOMAIN)]));
  assert.deepEqual(swept.candidates, []);
  assert.equal(swept.skipped[1], 'own_failure');
});

test('selectOwn keeps the sweep\'s skips: imported, a moved head, an already-tried head or key, and checks main fails', () => {
  for (const [row, why] of [
    [verdict(1, [DOMAIN], { source: 'imported' }), 'imported'],
    [verdict(1, [DOMAIN], { reviewed_head_sha: NEW_HEAD }), 'head_moved'],
    [verdict(1, [DOMAIN], { fixed_check_sync_head: HEAD.toUpperCase() }), 'already_tried'],
    [verdict(1, [DOMAIN], { fixed_check_sync_keys: [key(DOMAIN)] }), 'already_tried'],
    [verdict(1, [{ ...DOMAIN, advisory: true }]), 'nothing_fixed'],
  ]) {
    assert.deepEqual(subject.selectOwn(row, new Set([key(DOMAIN)])), { why }, why);
  }
  assert.deepEqual(subject.selectOwn(verdict(1, [DOMAIN]), new Set()), { why: 'main_fails' },
    'a check the proposal added, or that main still fails, is never a sync');
  assert.deepEqual(subject.selectOwn(verdict(1, [], { check_state: 'passing' }), new Set()), {},
    'a passing verdict is neither a candidate nor a skip');
});

test('selectOwn keeps the unit-suite rule: main watch green, the per-tip key, MAX_UNIT_SYNCS', () => {
  const ran = '2026-10-10T08:46:04.000Z';
  const row = verdict(1, [UNIT], { checks_checked_at: ran });
  const greenAfter = { passing: true, at: Date.parse('2026-10-10T11:01:15Z') };
  assert.deepEqual(subject.selectOwn(row, new Set(), greenAfter).candidate,
    { id: 1, head: HEAD, keys: [subject.UNIT_KEY] });
  assert.equal(subject.selectOwn(row, new Set(), { passing: true, at: Date.parse('2026-10-10T08:00:00Z') }).why,
    'unit_suite_only');
  const used = verdict(1, [UNIT], {
    checks_checked_at: ran,
    fixed_check_sync_keys: [subject.UNIT_KEY, subject.unitSyncKey('c'.repeat(40)), subject.unitSyncKey('d'.repeat(40))],
  });
  assert.equal(subject.selectOwn(used, new Set(), greenAfter).why, 'already_tried');
});

// syncBeforeFix reads one row (ownVerdict), decides, and claims on the head
// the sweep claims. The pool below answers ownVerdict's query for one
// proposal, and what main passes and main watch say for its app.
function ownPool({ verdictRow = null } = {}) {
  const pool = makePool();
  const query = pool.query.bind(pool);
  pool.query = async (sql, params) => {
    const text = String(sql);
    if (/FROM chat_sessions cs\s+WHERE cs\.id = \$1/.test(text) && /fixed_check_sync_head/.test(text)) {
      pool.queries.push({ sql: text, params });
      return { rows: verdictRow ? [verdictRow] : [] };
    }
    if (/WITH recent AS/.test(text)) return { rows: [{ ...DOMAIN, status: 'pass' }] };
    if (/FROM apps WHERE id = \$1/.test(text)) {
      return { rows: [{ main_check_state: null, main_check_at: null, main_check_sha: null, main_sha: null }] };
    }
    return query(sql, params);
  };
  return pool;
}

const OWN_ROW = {
  app_id: 12, id: 7504, source: 'cli_handoff', check_state: 'failing',
  checks_commit_sha: HEAD, reviewed_head_sha: HEAD, checks_checked_at: '2026-10-15T10:00:00Z',
  fixed_check_sync_head: null, fixed_check_sync_keys: null,
  failing: [{ ...DOMAIN, advisory: false }],
};

test('syncBeforeFix syncs a behind, clean proposal of the bot\'s own, claimed on the same head, as bot_fix', async () => {
  const pool = ownPool({ verdictRow: OWN_ROW });
  const { deps, calls } = makeDeps();
  const out = await subject.syncBeforeFix({ config: { c: 1 }, pool, sessionId: 7504, head: HEAD.toUpperCase() }, deps);
  assert.deepEqual(out, { synced: true, why: null, sha: NEW_HEAD });
  assert.deepEqual([calls.sync[0].reason, calls.sync[0].head, calls.sync[0].keys], ['bot_fix', HEAD, [key(DOMAIN)]],
    'the sweep\'s own head and key: the sweep, the hand-off and this never sync one head twice');
});

test('syncBeforeFix declines what the sweep would, and never throws', async () => {
  const { deps } = makeDeps();
  assert.deepEqual(await subject.syncBeforeFix({ config: {}, pool: ownPool({ verdictRow: null }), sessionId: 7504, head: HEAD }, deps),
    { synced: false, why: 'gone' });
  assert.deepEqual(await subject.syncBeforeFix({ config: {}, pool: ownPool(), sessionId: 7504, head: null }, deps),
    { synced: false, why: 'no_verdict' });
  // The verdict is about the head the fix round is due on; an older one says
  // nothing about the current code.
  assert.deepEqual(await subject.syncBeforeFix({ config: {}, pool: ownPool({ verdictRow: { ...OWN_ROW, checks_commit_sha: NEW_HEAD } }), sessionId: 7504, head: HEAD }, deps),
    { synced: false, why: 'head_moved' });
  const level = makeDeps({ measured: { headSha: HEAD, behindBy: 0, mergesClean: true } });
  assert.deepEqual(await subject.syncBeforeFix({ config: {}, pool: ownPool({ verdictRow: OWN_ROW }), sessionId: 7504, head: HEAD }, level.deps),
    { synced: false, why: 'level' }, 'a change level with main has nothing to gain');
  const conflict = makeDeps({ measured: { headSha: HEAD, behindBy: 3, mergesClean: false } });
  assert.deepEqual(await subject.syncBeforeFix({ config: {}, pool: ownPool({ verdictRow: OWN_ROW }), sessionId: 7504, head: HEAD }, conflict.deps),
    { synced: false, why: 'conflict' }, 'a conflict is a person\'s to resolve');
  const down = { async query() { throw new Error('db down'); } };
  assert.deepEqual(await subject.syncBeforeFix({ config: {}, pool: down, sessionId: 7504, head: HEAD }, deps),
    { synced: false, why: 'threw' }, 'never throws');
  const before = process.env.FIXED_CHECK_SYNC_ENABLED;
  try {
    process.env.FIXED_CHECK_SYNC_ENABLED = '0';
    assert.deepEqual(await subject.syncBeforeFix({ config: {}, pool: ownPool({ verdictRow: OWN_ROW }), sessionId: 7504, head: HEAD }, deps),
      { synced: false, why: 'disabled' });
  } finally {
    if (before === undefined) delete process.env.FIXED_CHECK_SYNC_ENABLED;
    else process.env.FIXED_CHECK_SYNC_ENABLED = before;
  }
});

// ── sweep: every app, at most MAX_SYNCS_PER_PASS ─────────────────────────

test('a sweep syncs at most MAX_SYNCS_PER_PASS and never throws', async () => {
  const ids = [1, 2, 3, 4, 5, 6];
  const pool = {
    async query(sql, params) {
      const text = String(sql);
      if (/SELECT DISTINCT app_id/.test(text)) return { rows: [{ app_id: 12 }] };
      if (/WITH recent AS/.test(text)) return { rows: [{ ...DOMAIN, status: 'pass' }] };
      if (/WHERE cs.app_id = \$1 AND cs.status = 'promoted'/.test(text)) {
        return { rows: ids.map((id) => verdict(id, [DOMAIN])) };
      }
      if (/FROM chat_sessions cs JOIN apps a/.test(text)) return { rows: [fullRow({ id: params[0] })] };
      if (/SET fixed_check_sync_head/.test(text)) return { rows: [{ id: params[0] }] };
      return { rows: [] };
    },
  };
  const { deps, calls } = makeDeps();
  const out = await subject.sweep({ config: {}, pool }, deps);
  assert.equal(out.candidates, 6);
  assert.deepEqual(out.synced, [1, 2, 3, 4], 'asked for, not waited for');
  assert.equal(calls.sync.length, subject.MAX_SYNCS_PER_PASS);
  assert.ok(calls.sync.every((c) => c.wait === false));

  const broken = { async query() { throw new Error('connection terminated'); } };
  assert.deepEqual(await subject.sweep({ config: {}, pool: broken }, deps),
    { apps: 0, candidates: 0, synced: [], skipped: {} });
});

// ── wiring ───────────────────────────────────────────────────────────────

test('a clock of the workflow runs the sweep, stops it, and says a decline once', async (t) => {
  // Every five minutes, one run at a time wherever the workflow runs
  // (src/workflow/clock/services.ts); its stop is the run's signal, and what
  // it remembers between runs is its previous run's result, not the process.
  const clocks = fs.readFileSync(path.join(ROOT, 'src/workflow/clock/services.ts'), 'utf8');
  assert.match(clocks, /name: 'fixed-check-sync', everyMs: 5 \* MIN, leaseMs: 10 \* MIN,\n\s+run: \(ctx: WorkContext, \{ pool, config \}: JobDeps\) => legacy\('services\/proposal-scans'\)\.fixedCheckSync\(config, pool, \{\n\s+previous: ctx\.input\.previous \?\? null, shouldStop: stopped\(ctx\),/);
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.doesNotMatch(server, /fixed-check-sync|fixedCheckSync/, 'no leader starts or stops it');
  assert.equal(subject.start, undefined);
  assert.equal(subject.stop, undefined);

  const scans = require('../src/services/proposal-scans');
  let skipped = { 7: 'level', 8: 'conflict' };
  const stop = () => false;
  const sweep = t.mock.method(subject, 'sweep', async () => ({ apps: 1, candidates: 2, synced: [], skipped }));
  const said = () => logs.filter((l) => l.msg === 'Proposals with failing checks not synced with main').map((l) => Object.keys(l.meta.declined));
  logs.length = 0;
  const first = await scans.fixedCheckSync({}, {}, { previous: null, shouldStop: stop });
  assert.equal(sweep.mock.calls[0].arguments[0].shouldStop, stop, 'the run\'s stop reaches the sweep');
  assert.deepEqual(first, { apps: 1, candidates: 2, synced: [], declined: { 7: 'level', 8: 'conflict' } });
  assert.deepEqual(said(), [['7', '8']]);
  assert.deepEqual(logs.find((l) => l.msg === 'Proposals with failing checks not synced with main').meta.declined['8'],
    { why: 'conflict', words: subject.declinedWords('conflict') });

  // The next run, handed the last one's result, says nothing new; a reason
  // that changed is said again; a proposal no longer declined is forgotten.
  const second = await scans.fixedCheckSync({}, {}, { previous: JSON.parse(JSON.stringify(first)) });
  assert.deepEqual(said(), [['7', '8']], 'said once');
  skipped = { 7: 'main_fails' };
  const third = await scans.fixedCheckSync({}, {}, { previous: second });
  assert.deepEqual(said(), [['7', '8'], ['7']], 'again when it changes');
  assert.deepEqual(third.declined, { 7: 'main_fails' }, 'and 8, synced or gone, is not remembered');

  const before = process.env.FIXED_CHECK_SYNC_ENABLED;
  try {
    process.env.FIXED_CHECK_SYNC_ENABLED = '0';
    assert.deepEqual(await scans.fixedCheckSync({}, {}, {}), { off: true });
    assert.equal(sweep.mock.callCount(), 3, 'off, it does not sweep');
  } finally {
    if (before === undefined) delete process.env.FIXED_CHECK_SYNC_ENABLED;
    else process.env.FIXED_CHECK_SYNC_ENABLED = before;
  }
});

test('the schema carries the claim columns', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8');
  assert.match(schema, /ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS fixed_check_sync_head TEXT;/);
  assert.match(schema, /ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS fixed_check_sync_keys TEXT\[\];/);
});

test('FIXED_CHECK_SYNC_ENABLED=0 turns it off', () => {
  const before = process.env.FIXED_CHECK_SYNC_ENABLED;
  try {
    process.env.FIXED_CHECK_SYNC_ENABLED = '0';
    assert.equal(subject.isEnabled(), false);
    delete process.env.FIXED_CHECK_SYNC_ENABLED;
    assert.equal(subject.isEnabled(), true);
  } finally {
    if (before === undefined) delete process.env.FIXED_CHECK_SYNC_ENABLED;
    else process.env.FIXED_CHECK_SYNC_ENABLED = before;
  }
});
