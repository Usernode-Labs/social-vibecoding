'use strict';

// #6859 (Gym Tracker #78, 19 Nov 2026): a plan that could not be written on
// an API error said "I'm trying again" and nothing ever read the request
// again. #6313 counted on the failure note's own post on the request to move
// it, and since #6806 (b2de48299) the bot's own post is no change to read. So
// the read is queued by the failure itself, once, a few minutes later, and
// the words promise it only when that row is really owed: a second failure
// says what a person can do. #6806 stays fixed: the bot's own post alone
// still queues no read.

const test = require('node:test');
const assert = require('node:assert/strict');

// The workflow runtime answers an Owed with what its instance made of it
// (workflow/platform.ts botOwedAndWait); the bot's own process has it, a test
// does not.
const replies = [];
let answer = { queued: true, looking: false, jobKey: null };
const stub = (path, exports) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
};
stub('../src/workflow/platform.ts', {
  botOwedAndWait: async (p) => { replies.push(p); return answer; },
  botOwed: async () => {},
});

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');

const APP = { id: 41, slug: 'gym-tracker', name: 'Gym Tracker' };
const BOT = { id: 9, username: 'homeroom_bot' };
const PLAN_REASON = 'no plan could be written (the spec turn ended on an API error)';
const PUSH_REASON = 'the build turn gave up (GitHub refused the upload; permanent)';

// A request's run row, as the retry reads it: what started that read.
const poolFor = ({ readReason = 'changed' } = {}) => ({
  async query(sql) {
    const s = String(sql);
    if (/SELECT read_reason FROM homeroom_bot_runs/.test(s)) return { rows: [{ read_reason: readReason }] };
    return { rows: [] };
  },
});

const announce = async (built, { readReason = 'changed' } = {}) => {
  const said = [];
  const acted = await bot.announceBuilt({
    pool: poolFor({ readReason }), ws: null, app: APP, bot: BOT, issueNumber: 78, runId: 6250, built,
    say: async (kind, text, extra) => { said.push({ kind, text, extra }); }, domain: 'app.example',
  });
  return { acted, said };
};

test.beforeEach(() => { replies.length = 0; answer = { queued: true, looking: false, jobKey: null }; });

test('#6859: a plan that could not be written queues one read of its own, a few minutes out, and says it is trying again', async () => {
  const { acted, said } = await announce({ ok: false, sessionId: 14039, error: PLAN_REASON });
  assert.equal(acted, 'build_failed');
  assert.equal(replies.length, 1, 'one row, queued by the failure itself');
  const [owed] = replies;
  assert.equal(owed.appId, APP.id);
  assert.equal(owed.issueNumber, 78);
  assert.equal(owed.reason, bot.PLAN_RETRY_REASON);
  assert.equal(owed.reason, 'plan_retry');
  assert.equal(owed.waitMs, bot.PLAN_RETRY_AFTER_MS, 'held a few minutes before the loop takes it');
  assert.ok(bot.PLAN_RETRY_AFTER_MS >= 60 * 1000 && bot.PLAN_RETRY_AFTER_MS <= 10 * 60 * 1000, 'a few minutes');
  assert.equal(owed.key, 'plan_retry:6250', 'one key per run, so a restart saying it again adds no second row');
  assert.ok(owed.priority > 0, 'not a person\'s ask: it lifts nobody\'s hold');
  // The bot's own row: uncharged, and a refresh keeps it while the request
  // is quiet (a refresh runs every five minutes, inside the wait).
  assert.ok(bot.SELF_QUEUED_REASONS.includes('plan_retry'));
  assert.ok(bot.KEPT_WHILE_QUIET_REASONS.includes('plan_retry'));
  // And it is said as the bot trying again, in both voices.
  assert.deepEqual(said.map((s) => s.kind), ['build_failed']);
  assert.equal(said[0].text, 'Homeroom bot couldn\'t finish writing the plan for this. It is trying again.');
  assert.equal(said[0].extra.dm.retrying, true);
});

test('#6859: the same run announced twice (a restart finishing its words) queues one row', async () => {
  await announce({ ok: false, sessionId: 14039, error: PLAN_REASON });
  await announce({ ok: false, sessionId: 14039, error: PLAN_REASON });
  assert.equal(replies.length, 2);
  assert.equal(replies[0].key, replies[1].key, 'the instance replays the same key, never a second debt');
});

test('#6859: a second plan failure is not tried a third time by itself: it asks for a reply', async () => {
  const { acted, said } = await announce({ ok: false, sessionId: 14040, error: PLAN_REASON }, { readReason: 'plan_retry' });
  assert.equal(acted, 'build_failed');
  assert.deepEqual(replies, [], 'the retry was the read that just failed');
  assert.equal(said[0].text, 'Homeroom bot couldn\'t finish writing the plan for this. '
    + 'Reply here (or on the GitHub issue) and it will try again.');
  assert.equal(said[0].extra.dm.retrying, false);
  assert.equal(require('../src/services/homeroom-bot-dm').dmText('build_failed', { reason: PLAN_REASON, retrying: false }, { appName: 'Gym Tracker', issueNumber: 78 }),
    '**Gym Tracker** · request #78\n\nI couldn\'t finish writing the plan for this. Reply here and I\'ll try again.');
});

test('#6859: a look already running takes the row after, so nothing is promised', async () => {
  answer = { queued: false, looking: true, jobKey: null };
  const { said } = await announce({ ok: false, sessionId: 14041, error: PLAN_REASON });
  assert.equal(replies.length, 1, 'the read was still asked for');
  assert.equal(said[0].extra.dm.retrying, false, 'but "I\'m trying again" is said only of a row really owed');
  assert.match(said[0].text, /Reply here \(or on the GitHub issue\) and it will try again\.$/);
});

test('#6859: "I\'m trying again" never comes from the cause alone', async () => {
  // The runtime answers nothing (its timeout): the words do not promise a
  // retry that was not made.
  stub('../src/workflow/platform.ts', {
    botOwedAndWait: async (p) => { replies.push(p); return null; },
    botOwed: async () => {},
  });
  const { said } = await announce({ ok: false, sessionId: 14042, error: PLAN_REASON });
  assert.equal(said[0].extra.dm.retrying, false);
  assert.deepEqual(replies.map((p) => p.reason), ['plan_retry']);
});

test('#6859: another failure is not a plan, and queues nothing of its own', async () => {
  for (const error of [PUSH_REASON, 'the build ran past its time limit', 'produced no change to propose']) {
    replies.length = 0;
    const { said } = await announce({ ok: false, sessionId: 14043, error });
    assert.deepEqual(replies, [], error);
    assert.equal(said[0].extra.dm.retrying, false, error);
  }
});

// #6806 (b2de48299): a refresh reads a request again only for what moved it,
// and the bot's own comment on the request is not that. The retry above is
// the read #6313 assumed this would be; this stays fixed.
test('#6806 stays fixed: the bot\'s own post on a request queues no read', () => {
  const lastSeen = '2026-11-19T10:37:00.000Z';
  const ownPost = '2026-11-19T10:38:28.000Z';
  const issue = { number: 78, state: 'open', createdAt: '2026-11-19T10:30:00.000Z', updatedAt: ownPost };
  const lastRun = { thread_seen_at: lastSeen, verdict: 'ready', created_at: lastSeen };
  assert.deepEqual(bot.classifyIssue({ issue, lastRun, ownPostAt: ownPost }),
    { eligible: false, reason: 'unchanged', threadSeenAt: ownPost });
  // A person writing after it is read as before.
  const after = bot.classifyIssue({
    issue: { ...issue, updatedAt: '2026-11-19T10:45:00.000Z' }, lastRun, ownPostAt: ownPost,
  });
  assert.deepEqual([after.eligible, after.reason], [true, 'changed']);
  // And the words the bot says for this failure are still the plan's.
  assert.equal(live.buildFailedText(PLAN_REASON, { retrying: true }),
    'Homeroom bot couldn\'t finish writing the plan for this. It is trying again.');
});
