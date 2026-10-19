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
//      author excluded (the move itself is the proposal machine's:
//      ReviewHeadMoved, read from the head the caller found);
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

// The head move is the proposal machine's (ReviewHeadMoved): the service
// appends it and reads the epoch off the reply. `moves` records each ask;
// `moveReply` is what the machine answers.
const moves = [];
// `moveQueue`, when not empty, answers the asks in order before `moveReply`.
let moveReply = { status: 'accepted', reply: { epoch: 4 } };
let moveQueue = [];
stubModule('../src/workflow/platform.ts', {
  moveReviewHead: async (p) => { moves.push(p); return moveQueue.length ? moveQueue.shift() : moveReply; },
});

const { retireVotesAfterAuthoredPush, retireAndRecheck } = require('../src/services/vote-revision');

const OLD_HEAD = '1111111111111111111111111111111111111111';

function makePool({ counted = [], headNew = true, epoch = 4 } = {}) {
  const queries = [];
  moves.length = 0;
  moveQueue = [];
  moveReply = { status: 'accepted', reply: { epoch } };
  return {
    queries,
    query: async (sql, params) => {
      const s = String(sql);
      queries.push({ sql: s, params });
      if (/SELECT pv\.user_id, pv\.vote[\s\S]*FROM pr_votes pv/.test(s)) return { rows: counted };
      if (/SELECT reviewed_head_sha, app_id FROM chat_sessions/.test(s)) {
        return { rows: [{ reviewed_head_sha: headNew ? OLD_HEAD : HEAD, app_id: 3 }] };
      }
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

  // The epoch bump and the head install are one move of the proposal
  // machine's, fenced on the head read here; nothing here writes the row.
  assert.equal(moves.length, 1, 'the move is asked of the machine once');
  assert.deepEqual(moves[0], {
    sessionId: 41, appId: 3, column: 'reviewed', from: OLD_HEAD, to: HEAD,
    keepVotes: false, reason: 'authored-push',
  }, 'an authored push retires the votes; the sha is lower-cased, like every other pin');
  assert.ok(!pool.queries.some((q) => /UPDATE chat_sessions/.test(q.sql)), 'the row is the machine\'s to write');
  assert.ok(!pool.queries.some((q) => /DELETE FROM pr_votes/.test(q.sql)), 'nothing is deleted');
});

test('the same head bumps nothing', async () => {
  const pool = makePool({ counted: [{ user_id: 8, vote: 'yes' }], headNew: false });
  const r = await retireVotesAfterAuthoredPush(pool, session, HEAD);
  assert.deepEqual(r, { bumped: false, epoch: null, retired: 0, priorYes: [] });
  assert.equal(moves.length, 0, 'the machine is not asked to move a head already there');
});

test('a move the machine refuses (another pass got there first) bumps nothing', async () => {
  const pool = makePool({ counted: [{ user_id: 8, vote: 'yes' }] });
  moveReply = { status: 'rejected', reason: 'head_moved' };
  const r = await retireVotesAfterAuthoredPush(pool, session, HEAD);
  assert.deepEqual(r, { bumped: false, epoch: null, retired: 0, priorYes: [] });
  assert.equal(moves.length, 1);
});

// The machine runs in another process: a move it did not decide in time is
// refused as expired (platform.ts refuses it once the wait runs out; a
// `pending` is one it could not refuse yet). That is not "nothing moved":
// the move is asked again.
test('a move the machine did not decide in time is asked again until it lands', async () => {
  const pool = makePool({ counted: [{ user_id: 8, vote: 'yes' }], epoch: 6 });
  moveQueue = [{ status: 'rejected', reason: 'expired', requestKey: 'k1' }, { status: 'pending', requestKey: 'k2' }];
  const r = await retireVotesAfterAuthoredPush(pool, session, HEAD);
  assert.equal(r.bumped, true, 'the third ask landed');
  assert.equal(r.epoch, 6);
  assert.deepEqual(r.priorYes, [8]);
  assert.equal(moves.length, 3, 'asked until the machine answered');
  assert.ok(moves.every((m) => m.from === OLD_HEAD && m.to === HEAD), 'each ask is the same move');
});

test('a move the machine never answers is asked a bounded number of times', async () => {
  const pool = makePool({ counted: [{ user_id: 8, vote: 'yes' }] });
  moveReply = { status: 'rejected', reason: 'expired', requestKey: 'k' };
  const r = await retireVotesAfterAuthoredPush(pool, session, HEAD);
  assert.deepEqual(r, { bumped: false, epoch: null, retired: 0, priorYes: [] });
  assert.equal(moves.length, 3, 'once and twice more, then given up (loudly)');
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
