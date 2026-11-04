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

// #6246 (4 Nov 2026): a plan waiting for Build it is Needs you's even when a
// reply waits to be read beside it. The facts path and the bot's own stage
// both say plan; a read on a request the bot handed back is unchanged.
test('#6246: a waiting plan wins over a reply being read', () => {
  const planFacts = {
    planWaits: true, planAt: '2026-11-03T16:40:00Z',
    replyWaits: true, handedBack: false,
    run: { verdict: 'ready', held: false, capSuppressed: null, createdAt: '2026-11-03T16:30:00Z' },
    viewerDecides: true,
  };
  assert.deepEqual(standing(row, 8, NOW, 99, null, planFacts), {
    group: 'needs', what: 'plan', at: '2026-11-03T16:40:00.000Z', quietDays: 0,
  });
  // The bot's own stage says plan too, when it fits.
  assert.deepEqual(standing(row, 7, NOW, 99, { stage: 'plan', since: '2026-11-03T16:40:00Z' }, null), {
    group: 'needs', what: 'plan', at: '2026-11-03T16:40:00.000Z',
  });
  // #6228 stays: a read on a request the bot handed back still reads the reply.
  assert.equal(standing(row, 7, NOW, 99, { stage: 'reading', reply: true, since: '2026-11-03T16:52:00Z' }, null).what,
    'reading_reply');
  // Facts without a waiting plan are unchanged.
  assert.equal(standing(row, 8, NOW, 99, null, { ...planFacts, planWaits: false, replyWaits: false }).what,
    'not_picked_up');
});

// #6313 (4 Nov 2026): a request queued for another read after Homeroom bot
// could not write its plan says it is retrying the plan, not that it waits
// for a free builder. The word is the same in the tab (shortWords) and in
// the bot's answer (THREAD_SAYS, listsOf); once a read starts, the plain
// reading line returns.
test('#6313: a read queued after a plan that could not be written is retrying the plan', () => {
  const queued = { stage: 'queued', retry: 'plan', since: '2026-11-03T16:58:00Z' };
  assert.deepEqual(standing(row, 7, NOW, 99, queued, null), {
    group: 'waiting', what: 'retrying_plan', at: '2026-11-03T16:58:00.000Z',
  });
  // A queued read after some other failure is the plain queue.
  assert.equal(standing(row, 7, NOW, 99, { stage: 'queued', since: '2026-11-03T16:58:00Z' }, null).what, 'queued');
  // A read under way is reading the request, whatever failed before.
  assert.equal(standing(row, 7, NOW, 99, { stage: 'reading', retry: 'plan', since: '2026-11-03T16:59:00Z' }, null).what, 'reading');
  // The bot's own answer names it, and orders it with the queue.
  const lists = require('../src/services/ai-work').listsOf([], {
    private: [], needs: [], live: [],
    waiting: [{ ...standing(row, 7, NOW, 99, queued, null), app: { slug: 'homeroom' }, number: 6209, title: 'T', threadId: 5 }],
  }, { botUsername: 'homeroom-bot' });
  assert.match(lists.waiting[0].says, /trying the plan again/);
});
