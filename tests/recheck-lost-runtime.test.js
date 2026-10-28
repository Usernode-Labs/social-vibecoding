'use strict';

// "Run checks again" on a preview whose runtime was removed from under the
// preview machine (28 Oct 2026: the data-policy retirement of a release
// deleted three platform previews' Deployments, and the machine still said
// they served). The re-run ran all 743 checks against the runtime that was
// gone, and every one failed at once. A recheck now looks at the runtime
// first, from the row as it is now: one that is gone is reported lost, the
// machine rebuilds it, and the recheck joins that build. A runtime that
// cannot be read is not gone, and a session the machine does not hold is
// the machine's to enrol, as before.

const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (path, exports) => {
  const id = require.resolve(path);
  const original = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  return () => { if (original) require.cache[id] = original; else delete require.cache[id]; };
};

const SESSION = { id: 77, app_id: 10, status: 'promoted', checks_commit_sha: 'c'.repeat(40) };
const RUNTIME = { id: 77, staging_url: 'https://p--s77.apps.test', staging_runtime_kind: 'kubernetes',
  staging_runtime_name: 'sv-preview-10-s77', staging_container_id: null };

// staging-recovery with the machine's front door, the runtime and the
// fresh-run record stubbed. `cluster` answers the runtime's inspect.
function load({ held = true, working = false, cluster = async () => ({ status: 'running', labels: {} }), row = RUNTIME } = {}) {
  const calls = [];
  const restores = [
    stub('../src/services/logger', { info() {}, warn() {}, error() {}, debug() {} }),
    stub('../src/services/preview-workflow', {
      held: async () => held,
      working: async () => working,
      lost: async ({ session, detail }) => { calls.push(['lost', session.id, detail]); return true; },
      recheck: async ({ reason }) => { calls.push(['recheck', reason]); },
    }),
    stub('../src/services/application-runtime', {
      inspect: async (config, which) => { calls.push(['inspect', which.runtimeName]); return cluster(); },
    }),
    stub('../src/services/unit-suite-reuse', { markFreshOwed: async () => true }),
  ];
  const subject = require.resolve('../src/services/staging-recovery');
  delete require.cache[subject];
  const recovery = require('../src/services/staging-recovery');
  const pool = {
    async query(sql) {
      if (/staging_runtime_name, staging_container_id\s+FROM chat_sessions/.test(sql)) return { rows: row ? [row] : [] };
      return { rows: [] };
    },
  };
  const restore = () => { for (const r of restores) r(); delete require.cache[subject]; };
  return { recovery, pool, calls, restore };
}

test('a recheck of a preview whose runtime is gone reports it lost before it asks for the run', async () => {
  const { recovery, pool, calls, restore } = load({ cluster: async () => ({ status: 'not_found' }) });
  try {
    assert.equal(await recovery.recheckSessionChecks({ pool, session: SESSION, reason: 'manual-recheck' }), 'handed_off');
    assert.deepEqual(calls, [['inspect', 'sv-preview-10-s77'], ['lost', 77, 'runtime gone'], ['recheck', 'manual-recheck']],
      'the machine rebuilds what served, and the recheck joins the build');
  } finally { restore(); }
  // The system's own rechecks look too: none of them may judge a runtime that is gone.
  const sys = load({ cluster: async () => ({ status: 'not_found' }) });
  try {
    await sys.recovery.recheckSessionChecks({ pool: sys.pool, session: SESSION, reason: 'stale-pending-vote-kick' });
    assert.deepEqual(sys.calls.map(([name]) => name), ['inspect', 'lost', 'recheck']);
  } finally { sys.restore(); }
});

test('the system\'s recheck leaves a preview the machine builds or retries to it; a person\'s still looks', async () => {
  // A loss reported again is rebuilt as a person's (machine.ts lost): from a
  // vote's kick it would build past the error lane's cap.
  const sys = load({ working: true, cluster: async () => ({ status: 'not_found' }) });
  try {
    await sys.recovery.recheckSessionChecks({ pool: sys.pool, session: SESSION, reason: 'stale-pending-vote-kick' });
    assert.deepEqual(sys.calls, [['recheck', 'stale-pending-vote-kick']]);
  } finally { sys.restore(); }
  const person = load({ working: true, cluster: async () => ({ status: 'not_found' }) });
  try {
    await person.recovery.recheckSessionChecks({ pool: person.pool, session: SESSION, reason: 'manual-recheck' });
    assert.deepEqual(person.calls.map(([name]) => name), ['inspect', 'lost', 'recheck']);
  } finally { person.restore(); }
});

test('a recheck of a preview that still runs, or cannot be read, runs against it', async () => {
  const live = load();
  try {
    await live.recovery.recheckSessionChecks({ pool: live.pool, session: SESSION, reason: 'manual-recheck' });
    assert.deepEqual(live.calls, [['inspect', 'sv-preview-10-s77'], ['recheck', 'manual-recheck']]);
  } finally { live.restore(); }
  // An API outage is not evidence that the preview is gone.
  const outage = load({ cluster: async () => { throw new Error('the cluster did not answer'); } });
  try {
    await outage.recovery.recheckSessionChecks({ pool: outage.pool, session: SESSION, reason: 'manual-recheck' });
    assert.deepEqual(outage.calls, [['inspect', 'sv-preview-10-s77'], ['recheck', 'manual-recheck']]);
  } finally { outage.restore(); }
});

test('a session the machine does not hold is enrolled by the recheck, as before', async () => {
  const { recovery, pool, calls, restore } = load({ held: false, cluster: async () => ({ status: 'not_found' }) });
  try {
    await recovery.recheckSessionChecks({ pool, session: SESSION, reason: 'manual-recheck' });
    assert.deepEqual(calls, [['recheck', 'manual-recheck']], 'nothing to report lost: the machine builds what it enrols');
  } finally { restore(); }
});

// ── What the machine does with the report ────────────────────────────
//
// The fix relies on the preview machine's own PreviewLost (machine.ts lost):
// in a state that serves, the lost attempt is built again; during a run,
// the run against it is cancelled; and a person's recheck that follows
// joins the build rather than run against what was lost.

const { preview, WORK } = require('../src/workflow/preview/machine.ts');
const machine = preview({ maxRetries: 5, retireAfterMs: 60000 });
const HEAD = 'c'.repeat(40);
const ctx = { machine: 'preview', key: 'session:77', appId: 10, version: 9, now: new Date('2026-10-28T17:05:00Z') };
const facts = { session: null, app: null, alive: new Set() };
function serving(name, extra = {}) {
  return {
    name,
    data: {
      sessionId: 77, appId: 10, appSlug: 'usernode-2d5619', userId: 3, seed: 500, head: HEAD, trigger: 'manual-recheck', last: 1,
      preparing: null,
      serving: { n: 1, head: HEAD, db: 'app_usernode_2d5619_staging_s77_aaaaaa', url: 'https://p--s77.apps.test',
        runtimeKind: 'kubernetes', runtimeName: 'sv-preview-10-s77', containerId: null, imageRef: null, buildRef: null,
        since: '2026-10-28T16:59:00Z' },
      run: null, verdict: 'failing', failure: null, platformFault: false, streak: 0, firstFailureAt: null,
      episode: 0, retiring: [], exit: null, pending: null, closedAt: null, operations: [], ...extra,
    },
  };
}
const send = (state, type, payload, source = { kind: 'system' }) => {
  const entry = machine.entryFor(state.name, type);
  const event = { id: 9, type, payload, source };
  if (entry.guard) assert.equal(entry.guard(state, event, facts, ctx), true);
  return entry.to(state, event, facts, ctx);
};

test('a lost preview is built again, and a person\'s recheck joins that build', () => {
  const lost = send(serving('settled'), 'PreviewLost', { attempt: 1, detail: 'runtime gone' });
  assert.equal(lost.next.name, 'preparing');
  assert.deepEqual(lost.work.filter((w) => w.kind === WORK.prepare).map((w) => [w.input.n, w.input.head]), [[2, HEAD]]);
  const joined = send(lost.next, 'RecheckRequested', { reason: 'manual-recheck', trigger: 'manual-recheck' }, { kind: 'route' });
  assert.equal(joined.next.name, 'preparing');
  assert.deepEqual((joined.work || []).filter((w) => w.kind === WORK.run), [], 'nothing runs against what was lost');
  assert.deepEqual(joined.writes, [{ type: 'owed', sessionId: 77, head: HEAD }], 'the person is owed the run of the rebuild');
});

test('a preview lost under its checks run stops the run and is built again', () => {
  const run = { key: 'run:1:9', n: 1, head: HEAD };
  const lost = send(serving('checking', { run, verdict: null }), 'PreviewLost', { attempt: 1, detail: 'runtime gone' });
  assert.equal(lost.next.name, 'preparing');
  assert.ok(lost.cancel.some((c) => c.kind === WORK.run && c.key === run.key), 'the run against the retired runtime is cancelled');
  assert.equal(lost.work.filter((w) => w.kind === WORK.prepare).length, 1);
});
