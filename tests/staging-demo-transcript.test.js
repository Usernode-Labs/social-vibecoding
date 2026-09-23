'use strict';

// The demo issue's Discussion must not depend on nobody having typed there.
//
// `?demo=1` on a staging preview used to answer a thread's first page with
// the mock transcript only when the real read came back EMPTY. A preview is a
// live, shared stack, though: a reviewer trying the composer on the demo
// issue (900008), or an evidence replay doing the same, leaves one real row,
// the server accepts it (an issue thread ref is not checked against the
// issue list), and from then on that preview answered with that row alone.
// The declared checks that read the mock on that topic — #2236's via-agent
// chip and #1926's folded conflict notices — then failed on proposals that
// never touched the chat, and kept failing on every recheck of that preview.
//
// The contract pinned here:
//   * a pinned demo topic keeps its mock rows on every demo first page, with
//     whatever was really posted there after them;
//   * every other thread, and the general stream, keeps the old rule: the
//     mock only stands in for an empty transcript, a genuine one wins;
//   * nothing changes outside staging, without `demo=1`, or past page one.
//
// Run with: node --test tests/staging-demo-transcript.test.js

process.env.USERNODE_ENV = 'staging';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

let realRows = [];
const poolMod = require('../src/db/pool');
poolMod.getPool = () => ({
  query: async (sql) => (/FROM chat_messages m/.test(sql) ? { rows: realRows.slice().reverse() } : { rows: [] }),
});

const appAccessId = require.resolve('../src/services/app-access');
require.cache[appAccessId] = {
  id: appAccessId, filename: appAccessId, loaded: true, paths: [],
  exports: {
    ACCESS_COLUMNS: 'id, slug',
    getAppForUser: async (_pool, slug) => (slug === 'demo' ? { id: 7, slug: 'demo' } : null),
    checkAppAccess: async () => true,
  },
};

const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true, paths: [],
  exports: { getReactionsForMessages: async () => ({}) },
};

const { chatRoutes, stagingMockGroupChat, stagingDemoTranscript } = require('../src/routes/chat');

const DEMO_ISSUE = { type: 'issue', ref: 900008 };
const tester = (id, extra = {}) => ({
  id, user_id: 42, username: 'a-tester', content: 'trying the composer',
  msg_type: 'message', metadata: {}, thread_type: 'issue', thread_ref: 900008,
  created_at: '2026-09-23T09:40:00.000Z', edited_at: null, posted_via: null, ...extra,
});
const ids = (rows) => rows.map((r) => r.id);

test('the demo issue keeps its mock transcript when somebody has posted there', () => {
  const mock = stagingMockGroupChat(1, DEMO_ISSUE);
  const rows = stagingDemoTranscript(1, DEMO_ISSUE, [tester(216), tester(217)]);
  assert.deepEqual(ids(rows), [...ids(mock), 216, 217], 'fixture first, then what was posted');
  const agent = rows.filter((r) => r.posted_via === 'agent');
  assert.equal(agent.length, 1, 'the row the via-agent check reads is still there');
  assert.equal(agent[0].username, 'staging-demo-agent');
  assert.ok(rows.some((r) => r.id === 9902017 && r.msg_type === 'conflict'),
    'and the folded conflict notices the #1926 check reads');
});

test('the demo issue on an empty database is the mock transcript, as before', () => {
  assert.deepEqual(ids(stagingDemoTranscript(1, DEMO_ISSUE, [])), ids(stagingMockGroupChat(1, DEMO_ISSUE)));
});

test('a real row sharing a mock id cannot displace the fixture row', () => {
  const rows = stagingDemoTranscript(1, DEMO_ISSUE, [tester(9902018), tester(300)]);
  assert.equal(rows.filter((r) => r.id === 9902018).length, 1);
  assert.equal(rows.find((r) => r.id === 9902018).posted_via, 'agent');
  assert.equal(rows[rows.length - 1].id, 300);
});

test('every other thread keeps the empty-transcript rule: a genuine transcript wins', () => {
  for (const thread of [{ type: 'issue', ref: 900001 }, { type: 'issue', ref: 42 }, { type: 'session', ref: 900008 }, null]) {
    assert.equal(stagingDemoTranscript(1, thread, [tester(5)]), null, JSON.stringify(thread));
    assert.deepEqual(ids(stagingDemoTranscript(1, thread, [])), ids(stagingMockGroupChat(1, thread)));
  }
});

async function withServer(fn) {
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 42 }; next(); });
  app.use(chatRoutes({}));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    return await fn((qs) => fetch(`http://127.0.0.1:${server.address().port}/api/apps/demo/messages?${qs}`)
      .then((r) => r.json()));
  } finally {
    server.close();
  }
}

test('GET: a staging demo first page of the demo issue serves the mock, then the real rows', async () => {
  realRows = [tester(216)];
  await withServer(async (get) => {
    const { messages } = await get('thread_type=issue&thread_ref=900008&limit=50&demo=1');
    assert.ok(messages.some((m) => m.posted_via === 'agent' && m.username === 'staging-demo-agent'));
    assert.equal(messages[messages.length - 1].id, 216);

    const plain = await get('thread_type=issue&thread_ref=900008&limit=50');
    assert.deepEqual(ids(plain.messages), [216], 'no demo flag, no fixture');

    const paged = await get('thread_type=issue&thread_ref=900008&limit=50&before=217&demo=1');
    assert.deepEqual(ids(paged.messages), [216], 'a Load earlier page is never padded');

    const other = await get('thread_type=issue&thread_ref=900001&limit=50&demo=1');
    assert.deepEqual(ids(other.messages), [216], 'another thread with a real transcript is left alone');
  });
});

test('the pinned set holds only mock topics', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/routes/chat.js'), 'utf8');
  const m = src.match(/const PINNED_DEMO_THREADS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'PINNED_DEMO_THREADS is declared');
  for (const key of m[1].match(/'[^']+'/g)) {
    const ref = Number(key.slice(1, -1).split(':')[1]);
    assert.ok(ref >= 900000 && ref < 1000000, `${key} is a staging mock issue number`);
  }
});
