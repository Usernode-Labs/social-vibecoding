'use strict';

// #6228 (3 Nov 2026): what a request's thread says the bot is doing with a
// person's reply, and how that is published to the room.

const test = require('node:test');
const assert = require('node:assert/strict');

const replyStatus = require('../src/services/homeroom-bot-reply-status');

const NOW = new Date('2026-11-03T17:00:00Z');
const ago = (seconds) => new Date(NOW.getTime() - seconds * 1000).toISOString();
const status = (extra) => replyStatus.statusOf({ replyId: 500, now: NOW, ...extra });

test('#6228: the thread\'s three states, and when there is nothing to say', () => {
  // Queued or about to be: will read.
  assert.equal(status({ stage: { stage: 'reading', reply: true, waiting: true } }), 'will_read');
  assert.equal(status({ voiceOwed: true }), 'will_read');
  // Reading now: the turn began after the reply, or the read started.
  assert.equal(status({ voice: [{ started_at: ago(5), finished_at: null, outcome: null }], replyAt: ago(30) }), 'reading');
  assert.equal(status({ stage: { stage: 'reading', reply: true } }), 'reading');
  // Nothing to add: the bot was spoken to, read the reply, and stopped.
  assert.equal(status({
    voice: [{ started_at: ago(20), finished_at: ago(10), outcome: 'quiet', speaker_id: 9, through_message_id: 500 }],
  }), 'quiet');
  // The bot's answer is there: nothing to say.
  assert.equal(status({ botAfter: true, stage: { stage: 'reading', reply: true } }), null);
  // It read a message nobody addressed to it: never "nothing to add".
  assert.equal(status({
    voice: [{ started_at: ago(20), finished_at: ago(10), outcome: 'quiet', speaker_id: null, through_message_id: 500 }],
  }), null);
  // An old quiet turn no longer shows.
  assert.equal(status({
    voice: [{ started_at: ago(120), finished_at: ago(90), outcome: 'quiet', speaker_id: 9, through_message_id: 500 }],
  }), null);
  // No reply at all.
  assert.equal(replyStatus.statusOf({ replyId: null, now: NOW }), null);
});

test('#6228: a status is broadcast to the project and the bot page re-reads for both people', async () => {
  const frames = [];
  const changed = [];
  const pool = {
    query: async (sql) => {
      if (/FROM UNNEST\(\$2::int\[\]\) AS w\(n\)/.test(sql)) {
        return { rows: [{
          app_id: 1, slug: 'homeroom', issue_number: 2, mode: 'live', verdict: 'person',
          run_at: ago(600), reply_id: 500, reply_at: ago(30), reply_user_id: 8, queue_id: 3, enqueued_at: ago(20),
        }] };
      }
      return { rows: [] };
    },
  };
  const deps = {
    ws: { broadcast: (appId, data) => frames.push([appId, data]) },
    workChanged: { noteWorkChanged: (userId) => changed.push(userId) },
    dm: { requesterOf: async () => ({ userId: 7 }) },
  };
  const out = await replyStatus.publish(pool, { appId: 1, issueNumber: 2, deps });
  assert.equal(out, undefined);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], [1, {
    type: 'bot_status', thread: { type: 'issue', ref: 2 }, status: 'will_read', authorId: 8, replyId: 500,
  }]);
  assert.deepEqual(changed.sort(), [7, 8], 'the requester and the person who replied');
});

test('#6228: publishing never throws, even with a broken read', async () => {
  const pool = { query: async () => { throw new Error('database down'); } };
  await replyStatus.publish(pool, { appId: 1, issueNumber: 2, deps: { ws: { broadcast() {} } } });
});
