'use strict';

// A recheck of a proposal up for approval checks the head people vote on,
// even when the preview machine still holds an older one
// (services/preview-workflow.js recheck). Session 8465 (16 October 2026): a
// promoted CLI upload moved reviewed_head_sha to c20ba948 and only cleared
// the verdict, so "Run checks again", the stuck sweep and boot reconcile all
// re-ran the machine's df02ec96, a commit nobody was voting on any more.
// The whole path against PostgreSQL and the real machine:
// tests/promoted-upload-checks-postgres.test.js.
//
// Run with: node --test tests/recheck-voted-head.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const OLD = `df02ec96${'0'.repeat(32)}`;
const NEW = `c20ba948${'1'.repeat(32)}`;
const IMPORTED = `abcdef01${'2'.repeat(32)}`;

function stubModule(id, exports) {
  const original = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: original ? original.paths : [] };
  return () => { if (original) require.cache[id] = original; else delete require.cache[id]; };
}

// The real staging-recovery and preview-workflow; the machine's front door
// stubbed. `held`: the head the machine holds. `row`: the session's pins as
// the database has them now. `answer`: the machine's answer to a revision.
function harness(t, { held, row, answer = 'accepted' }) {
  const calls = [];
  const restores = [stubModule(require.resolve('../src/workflow/platform.ts'), {
    previewHeld: async () => !!held,
    previewInstance: async () => (held ? { state: 'settled', data: { head: held } } : null),
    submitRevision: async (r) => {
      calls.push(['revision', r.head, r.source, r.trigger]);
      return answer === 'accepted' ? { status: 'accepted' } : { status: 'rejected', reason: answer };
    },
    requestRecheck: async (r) => { calls.push(['recheck', r.reason]); return { status: 'accepted' }; },
  })];
  const paths = ['staging-recovery', 'preview-workflow'].map((n) => require.resolve(`../src/services/${n}`));
  for (const p of paths) delete require.cache[p];
  const log = require('../src/services/logger');
  const saved = log.warn;
  log.warn = () => {};
  t.after(() => {
    log.warn = saved;
    for (const p of paths) delete require.cache[p];
    for (const restore of restores) restore();
  });
  const pool = { query: async () => ({ rows: [row], rowCount: 1 }) };
  // The caller's copy can predate the upload: its pins are the old ones.
  const session = { id: 8465, app_id: 10, status: 'promoted', source: 'cli_handoff', branch_name: 'dev/x',
    reviewed_head_sha: OLD, checks_commit_sha: OLD };
  return { rec: require('../src/services/staging-recovery'), pool, session, calls };
}

const promotedOnNew = { status: 'promoted', source: 'cli_handoff', reviewed_head_sha: NEW, checks_commit_sha: OLD,
  handoff_head_sha: OLD, imported_pr_head_sha: null };

for (const [reason, trigger] of [['manual-recheck', 'manual-recheck'], ['stuck-checks-sweep', 'stuck-sweep'],
  ['stuck-checks-boot', 'boot-reconcile']]) {
  test(`${reason}: the machine on the old head is handed the reviewed head, and nothing re-checks the old one`, async (t) => {
    const { rec, pool, session, calls } = harness(t, { held: OLD, row: promotedOnNew });
    assert.equal(await rec.recheckSessionChecks({ pool, session, reason }), 'handed_off');
    assert.deepEqual(calls, [['revision', NEW, 'recheck', trigger], ['recheck', reason]],
      'the revision builds and checks the reviewed head; the recheck after it joins that build');
  });
}

test('an imported PR is checked on its own moved head', async (t) => {
  const { rec, pool, session, calls } = harness(t, { held: OLD,
    row: { ...promotedOnNew, source: 'imported', imported_pr_head_sha: IMPORTED } });
  await rec.recheckSessionChecks({ pool, session: { ...session, source: 'imported' }, reason: 'manual-recheck' });
  assert.deepEqual(calls.map((c) => c.slice(0, 2)), [['revision', IMPORTED], ['recheck', 'manual-recheck']]);
});

test('the machine already on the reviewed head: a plain recheck, no revision', async (t) => {
  const { rec, pool, session, calls } = harness(t, { held: NEW, row: promotedOnNew });
  await rec.recheckSessionChecks({ pool, session, reason: 'manual-recheck' });
  assert.deepEqual(calls, [['recheck', 'manual-recheck']]);
});

test('a session not up for approval keeps rechecking the head the machine holds', async (t) => {
  const { rec, pool, session, calls } = harness(t, { held: OLD, row: { ...promotedOnNew, status: 'active' } });
  await rec.recheckSessionChecks({ pool, session: { ...session, status: 'active' }, reason: 'manual-recheck' });
  assert.deepEqual(calls, [['recheck', 'manual-recheck']]);
});

test('a revision the machine refuses (the pin moved on again) leaves the recheck to what the machine holds', async (t) => {
  const { rec, pool, session, calls } = harness(t, { held: OLD, row: promotedOnNew, answer: 'head_superseded' });
  await rec.recheckSessionChecks({ pool, session, reason: 'manual-recheck' });
  assert.deepEqual(calls.map((c) => c[0]), ['revision', 'recheck']);
});
