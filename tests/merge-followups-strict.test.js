'use strict';

// The functions the merge-followups workflow machine's durable work calls,
// asked to be strict: they throw what they could not do, so the work item is
// retried, instead of resolving null over a failure they logged. Without
// `strict` they keep the never-throw contract [main]'s merge relies on.
// (src/workflow/merge-followups/services.ts passes it.)

const test = require('node:test');
const assert = require('node:assert/strict');

const down = () => ({ async query() { throw new Error('db down'); } });

test('homeroom-bot noteRequestMerged: strict throws; otherwise it resolves null', async () => {
  const bot = require('../src/services/homeroom-bot');
  assert.equal(await bot.noteRequestMerged(down(), { id: 5 }), null);
  await assert.rejects(bot.noteRequestMerged(down(), { id: 5 }, { strict: true }), /db down/);
});

test('homeroom-bot noteRequestMerged run again stops a build an earlier run marked but may not have stopped', async () => {
  const bot = require('../src/services/homeroom-bot');
  const stopped = [];
  const pool = {
    async query(sql) {
      const text = String(sql);
      if (/FROM chat_sessions cs JOIN users u/.test(text)) return { rows: [{ id: 5, app_id: 2, user_id: 1, linked_issues: [7] }] };
      if (/^\s*UPDATE homeroom_bot_runs r\s+SET live_build_waiting_at/.test(text)) return { rows: [] };   // marked already
      if (/SELECT r\.id, r\.build_session_id FROM homeroom_bot_runs r/.test(text)) return { rows: [{ id: 30, build_session_id: 44 }] };
      return { rows: [], rowCount: 0 };
    },
  };
  const out = await bot.noteRequestMerged(pool, { id: 5 }, {
    strict: true,
    worker: { async stopTurn(id) { stopped.push(id); } },
    sessionLifecycle: { async archiveSession() { return { archived: false }; } },
    dm: { async closePlanCards() {} },
  });
  assert.deepEqual(stopped, [44]);
  assert.equal(out.stopped, 0, 'counted once, by the run that marked it');
});

test('journey-events recordChangeLive: strict throws; otherwise it resolves null', async () => {
  const journey = require('../src/services/journey-events');
  const args = { session: { id: 5, app_id: 2 }, deps: { live: () => true } };
  assert.equal(await journey.recordChangeLive(down(), args), null);
  await assert.rejects(journey.recordChangeLive(down(), { ...args, strict: true }), /db down/);
});

test('main-watch afterMerge: a claim that could not be written throws when strict, reads as "not running" otherwise', async () => {
  const mainWatch = require('../src/services/main-watch');
  const app = { id: 2, repo_url: 'https://github.com/acme/shop' };
  assert.equal(await mainWatch.afterMerge({}, down(), { app, mergeSha: 'a'.repeat(40) }), null);
  await assert.rejects(mainWatch.afterMerge({}, down(), { app, mergeSha: 'a'.repeat(40), strict: true }), /db down/);
});

test('homeroom-bot-chat noteRequestStatus: strict throws; otherwise it resolves 0', async () => {
  const chat = require('../src/services/homeroom-bot-chat');
  assert.equal(await chat.noteRequestStatus(down(), { appId: 2, issueNumber: 7, status: 'live' }), 0);
  await assert.rejects(chat.noteRequestStatus(down(), { appId: 2, issueNumber: 7, status: 'live', deps: { strict: true } }), /db down/);
});

test('homeroom-bot-chat noteRequestStatus strict: the chip write itself failing throws too', async () => {
  const chat = require('../src/services/homeroom-bot-chat');
  const pool = {
    async query(sql) {
      if (/FROM chat_bot_requests r JOIN apps a/.test(String(sql))) {
        return { rows: [{ kind: 'filed', chat_message_id: 3, app_id: 2, app_slug: 'shop', requester_id: 1, issue_number: 7 }] };
      }
      if (/UPDATE chat_messages/.test(String(sql))) throw new Error('db down');
      return { rows: [] };
    },
  };
  assert.equal(await chat.noteRequestStatus(pool, { appId: 2, issueNumber: 7, status: 'live' }), 1, 'never throws without strict');
  await assert.rejects(chat.noteRequestStatus(pool, { appId: 2, issueNumber: 7, status: 'live', deps: { strict: true } }), /db down/);
});
