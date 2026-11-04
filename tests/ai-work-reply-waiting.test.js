'use strict';

// #6228 (3 Nov 2026): a person's reply on a request the bot handed back
// leaves Needs you (Decide) the moment it is stored, both for the requester
// (the bot's own stages, botStages) and for anyone else reading the thread
// (the request's facts). What the bot decides and when it reads do not move.

const test = require('node:test');
const assert = require('node:assert/strict');

const { standing } = require('../src/services/ai-work');

const NOW = new Date('2026-11-03T17:00:00Z');
const row = {
  state: 'open', kind: 'request', number: 6209, request_state: 'open',
  request_at: '2026-11-03T15:00:00Z', created_at: '2026-11-03T15:00:00Z',
};

test('#6228: the bot\'s own stage for a reply it will read is In progress, not Decide', () => {
  const reply = { stage: 'reading', reply: true, since: '2026-11-03T16:52:00Z' };
  assert.deepEqual(standing(row, 7, NOW, 99, reply, null), {
    group: 'next', what: 'reading_reply', at: '2026-11-03T16:52:00.000Z',
  });
  // A plain read of the request is unchanged.
  assert.equal(standing(row, 7, NOW, 99, { stage: 'reading', since: '2026-11-03T16:52:00Z' }, null).what, 'reading');
});

test('#6228: another viewer\'s facts say Reading the reply as soon as it is stored', () => {
  const facts = {
    handled: true,
    handedBack: true, replyWaits: true,
    run: { verdict: 'person', held: false, capSuppressed: null, createdAt: '2026-11-03T15:00:00Z' },
    viewerDecides: true,
  };
  assert.deepEqual(standing(row, 8, NOW, 99, null, facts), {
    group: 'next', what: 'reading_reply', at: '2026-11-03T15:00:00.000Z', quietDays: 0,
  });
  // Past the window with no queue row, it is back to Decide.
  assert.equal(standing(row, 8, NOW, 99, null, { ...facts, replyWaits: false }).what, 'decide');
  // A reply on a request that was not handed back leaves the row alone.
  assert.equal(standing(row, 8, NOW, 99, null, {
    ...facts, handedBack: false, run: { verdict: 'ready', held: false, capSuppressed: null, createdAt: '2026-11-03T15:00:00Z' },
  }).what, 'not_picked_up');
});

// #6245 (4 Nov 2026): what the bot waits on you for is timed from when it
// began waiting, never from the change's or its page's last activity (a
// view bumps that), so the row keeps its place in Needs you.
test('#6245: a plan or a hand-back is timed from when it began waiting on you', () => {
  const touched = { ...row, last_activity_at: '2026-11-03T16:59:00Z' };
  for (const stage of ['plan', 'decide', 'build_stopped']) {
    assert.deepEqual(standing(touched, 7, NOW, 99, { stage, since: null }, null), {
      ...(stage === 'plan' ? { group: 'needs', what: 'plan' } : { group: 'needs', what: stage }),
      at: '2026-11-03T15:00:00.000Z',
    }, `${stage}: the request's own time, not the activity`);
  }
  // Its own waiting time wins where the bot knows it.
  assert.equal(standing(touched, 7, NOW, 99, { stage: 'plan', since: '2026-11-03T16:30:00Z' }, null).at,
    '2026-11-03T16:30:00.000Z');
  // A stage that is not Needs you keeps the activity fallback, so In
  // progress and Waiting order as they do today.
  assert.deepEqual(standing(touched, 7, NOW, 99, { stage: 'reading', since: null }, null),
    { group: 'next', what: 'reading', at: '2026-11-03T16:59:00.000Z' });
});
