'use strict';

// #1688: "Needs a conversation" gets a script (src/services/conversation-prompt.js).
//
//   1. the wording: the proposer asked what they were solving, each No
//      voter asked what would unblock it, their lines quoted;
//   2. below the contested line nothing is posted;
//   3. crossing it posts once into the proposal's thread, claims the epoch,
//      and pings everyone named;
//   4. a second No on the same version posts nothing — the claim holds.

const test = require('node:test');
const assert = require('node:assert/strict');

function stubModule(rel, exportsObj) {
  const full = require.resolve(rel);
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

const sent = [];
stubModule('../src/services/ws', {
  sendSystemMessage: async (pool, appId, content, msgType, metadata, thread) => {
    sent.push({ appId, content, msgType, metadata, thread });
    return { id: 77, createdAt: '2026-09-18T12:00:00.000Z' };
  },
});
let active = 6;
stubModule('../src/services/active-users', {
  getActiveUserStats: async () => ({ active, majority: Math.floor(active / 2) + 1 }),
  isContested: (a, no) => no / Math.max(a, 1) >= 1 / 3,
});
const mentions = [];
stubModule('../src/services/notifications', {
  createMentionNotifications: async (pool, args) => { mentions.push(args); return [{ id: 1 }, { id: 2 }]; },
  hydrateAndPush: async () => {},
});

const { promptIfContested, promptText, mentionList } = require('../src/services/conversation-prompt');

const session = { id: 41, user_id: 7, app_id: 3, pr_number: 41, pr_title: 'Custom tier colors' };

function makePool({ votes = [], claimed = true } = {}) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      const s = String(sql);
      queries.push({ sql: s, params });
      if (/FROM pr_votes pv/.test(s)) return { rows: votes };
      if (/UPDATE chat_sessions/.test(s)) return { rows: claimed ? [{ approval_epoch: 2 }] : [] };
      if (/SELECT username FROM users/.test(s)) return { rows: [{ username: 'evan' }] };
      return { rows: [] };
    },
  };
}

test('the wording names the proposer and the objectors, and quotes their lines', () => {
  assert.equal(mentionList(['carol']), '@carol');
  assert.equal(mentionList(['carol', 'dave']), '@carol and @dave');
  assert.equal(mentionList(['carol', 'dave', 'erin']), '@carol, @dave and @erin');
  const text = promptText({
    label: 'PR #41: Custom tier colors',
    author: 'evan',
    objectors: [
      { username: 'carol', reason: 'The new colors clash on mobile.' },
      { username: 'dave', reason: null },
    ],
  });
  assert.equal(text,
    'PR #41: Custom tier colors needs a conversation: a third of the group has said no, so it merges only on a straight majority now. '
    + '@evan, what problem were you solving? @carol and @dave, what would unblock this for you? '
    + 'carol: “The new colors clash on mobile.”');
});

test('below the contested line nothing is posted', async () => {
  sent.length = 0;
  active = 6;
  const pool = makePool({ votes: [{ user_id: 8, vote: 'no', reason: 'x', username: 'carol' }] });
  const r = await promptIfContested(pool, session);
  assert.deepEqual(r, { prompted: false, why: 'not_contested' });
  assert.equal(sent.length, 0);
  assert.ok(!pool.queries.some((q) => /UPDATE chat_sessions/.test(q.sql)), 'no claim is attempted');
});

test('crossing it posts once into the thread, claims the epoch, and pings everyone named', async () => {
  sent.length = 0;
  mentions.length = 0;
  active = 6;
  const pool = makePool({
    votes: [
      { user_id: 8, vote: 'no', reason: 'The new colors clash on mobile.', username: 'carol' },
      { user_id: 9, vote: 'yes', reason: null, username: 'alice' },
      { user_id: 10, vote: 'no', reason: null, username: 'dave' },
    ],
  });
  const r = await promptIfContested(pool, session);
  assert.equal(r.prompted, true);
  assert.equal(r.epoch, 2);
  assert.equal(r.author, 'evan');
  assert.deepEqual(r.objectors, [
    { username: 'carol', reason: 'The new colors clash on mobile.' },
    { username: 'dave', reason: null },
  ]);

  const claim = pool.queries.find((q) => /UPDATE chat_sessions/.test(q.sql));
  assert.match(claim.sql, /SET conversation_prompted_epoch = approval_epoch/);
  assert.match(claim.sql, /conversation_prompted_epoch IS DISTINCT FROM approval_epoch/, 'once per version');

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].thread, { type: 'session', ref: 41 }, "the proposal's own thread");
  assert.equal(sent[0].msgType, 'system');
  assert.match(sent[0].content, /^PR #41: Custom tier colors needs a conversation/);
  assert.match(sent[0].content, /@evan, what problem were you solving\? @carol and @dave, what would unblock this for you\?/);
  assert.equal(sent[0].metadata.conversation.epoch, 2);
  assert.deepEqual(sent[0].metadata.conversation.objectors.map((o) => o.username), ['carol', 'dave']);

  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].chatMessageId, 77, 'the mention rows point at the prompt');
  assert.equal(mentions[0].senderId, null, 'the app, not a person, is asking');
  assert.equal(mentions[0].content, sent[0].content);
});

test('a second No on the same version posts nothing', async () => {
  sent.length = 0;
  active = 6;
  const pool = makePool({
    votes: [{ user_id: 8, vote: 'no', reason: 'x', username: 'carol' }, { user_id: 10, vote: 'no', reason: null, username: 'dave' }],
    claimed: false,
  });
  const r = await promptIfContested(pool, session);
  assert.deepEqual(r, { prompted: false, why: 'already_prompted' });
  assert.equal(sent.length, 0);
});
