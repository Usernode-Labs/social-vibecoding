'use strict';

// #1688: what happens to a proposal's votes when its author pushes a new
// version from a native session (src/services/vote-revision.js).
//
// The turn tail used to DELETE every pr_votes row and announce the reset.
// Now it retires them the way an imported proposal always did — the
// session's approval epoch moves on, the rows stay — and asks the people
// whose Yes stopped counting to take another look. These tests pin:
//
//   1. a new head bumps the epoch and names the prior Yes voters, the
//      author excluded;
//   2. the same head bumps nothing (a resumed tail, or a vote-time
//      reconcile that got there first);
//   3. the shared step announces once and asks the prior Yes voters back;
//   4. with no counted votes there is nothing to say and nobody to ask.

const test = require('node:test');
const assert = require('node:assert/strict');

function stubModule(rel, exportsObj) {
  const full = require.resolve(rel);
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

const asked = [];
const pushed = [];
stubModule('../src/services/notifications', {
  createRevisionRecheckNotifications: async (pool, args) => {
    asked.push(args);
    return args.voterIds.map((id, i) => ({ id: 500 + i, user_id: id, kind: 'revision_recheck' }));
  },
  hydrateAndPush: async (pool, row) => { pushed.push(row.id); },
});

const { retireVotesAfterAuthoredPush, retireAndRecheck } = require('../src/services/vote-revision');

function makePool({ counted = [], headNew = true, epoch = 4 } = {}) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      const s = String(sql);
      queries.push({ sql: s, params });
      if (/SELECT pv\.user_id, pv\.vote[\s\S]*FROM pr_votes pv/.test(s)) return { rows: counted };
      if (/UPDATE chat_sessions/.test(s)) return { rows: headNew ? [{ approval_epoch: epoch }] : [] };
      return { rows: [] };
    },
  };
}

const session = { id: 41, user_id: 7, app_id: 3, app_slug: 'tiers', pr_number: 41, pr_title: 'Custom tier colors' };
const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';

test('a new head bumps the epoch and names the prior Yes voters, author excluded', async () => {
  const pool = makePool({
    counted: [
      { user_id: 7, vote: 'yes' },  // the author's own yes
      { user_id: 8, vote: 'yes' },
      { user_id: 9, vote: 'no' },
      { user_id: 10, vote: 'yes' },
    ],
    epoch: 5,
  });
  const r = await retireVotesAfterAuthoredPush(pool, session, HEAD.toUpperCase());
  assert.equal(r.bumped, true);
  assert.equal(r.epoch, 5);
  assert.equal(r.retired, 4, 'every counted vote stopped counting');
  assert.deepEqual(r.priorYes, [8, 10], 'the Yes voters, minus the author; a No is not asked back');

  const bump = pool.queries.find((q) => /UPDATE chat_sessions/.test(q.sql));
  assert.ok(bump, 'the epoch bump is one UPDATE');
  assert.match(bump.sql, /approval_epoch = approval_epoch \+ 1/);
  assert.match(bump.sql, /reviewed_head_sha = COALESCE\(\$2, reviewed_head_sha\)/, 'the head is installed in the same statement');
  assert.match(bump.sql, /reviewed_head_sha IS DISTINCT FROM \$2::varchar/, 'guarded on the head being new');
  assert.match(bump.sql, /stale_notified_at = NULL/, 'a push is activity: the stale clock restarts');
  assert.deepEqual(bump.params, [41, HEAD], 'the sha is lower-cased, like every other pin');
  assert.ok(!pool.queries.some((q) => /DELETE FROM pr_votes/.test(q.sql)), 'nothing is deleted');
});

test('the same head bumps nothing', async () => {
  const pool = makePool({ counted: [{ user_id: 8, vote: 'yes' }], headNew: false });
  const r = await retireVotesAfterAuthoredPush(pool, session, HEAD);
  assert.deepEqual(r, { bumped: false, epoch: null, retired: 0, priorYes: [] });
});

test('retireAndRecheck announces once and asks the prior Yes voters back', async () => {
  asked.length = 0;
  pushed.length = 0;
  const pool = makePool({ counted: [{ user_id: 8, vote: 'yes' }, { user_id: 9, vote: 'yes' }], epoch: 2 });
  const announced = [];
  const r = await retireAndRecheck(pool, session, HEAD, {
    announce: async (info) => { announced.push(info); },
  });
  assert.equal(r.retired, 2);
  assert.equal(announced.length, 1, 'the chat line goes out once');
  assert.equal(announced[0].retired, 2);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0], { appId: 3, sessionId: 41, authorId: 7, voterIds: [8, 9], epoch: 2 });
  assert.deepEqual(pushed, [500, 501], 'every created row is pushed live');
});

test('with no counted votes there is nothing to say and nobody to ask', async () => {
  asked.length = 0;
  const pool = makePool({ counted: [], epoch: 3 });
  const announced = [];
  const r = await retireAndRecheck(pool, session, HEAD, { announce: async (i) => { announced.push(i); } });
  assert.equal(r.bumped, true, 'the epoch still moves: the head is new');
  assert.equal(r.retired, 0);
  assert.equal(announced.length, 0);
  assert.equal(asked.length, 0);
});
