'use strict';

// get_bot_thread (19 Nov 2026): the hosted connector reads the person's OWN
// private threads with Homeroom bot, the conversations at
// #homeroom-bot/thread/<n>, through the services the conversation routes
// call (src/services/private-threads.js readOwnThread and listOwnThreads,
// src/services/conversations.js listThread), never with access rules of its
// own. These tests drive the registered handler against an in-memory copy of
// the tables those services read: the database answers the services' real
// SQL, so the access path under test is the app's, and any query the fake
// does not know (a write above all) fails the test. The SQL itself is pinned
// by the *-postgres suites of conversations.js, ai-work.js and ai-history.js.
//
// Run with: node --test tests/mcp-bot-thread.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const tools = require('../src/services/mcp-tools');
const audiences = require('../src/services/mcp-audiences');
const privateThreads = require('../src/services/private-threads');
const { READ_SCOPE } = require('../src/services/mcp-connect-constants');

const ORIGIN = 'https://app.onhomeroom.example';
const ADA = { id: 7, username: 'ada' };
const BOB = { id: 8, username: 'bob' };
const ROOT = { id: 9, username: 'root', isAdmin: true, adminReadonly: false, canAdminWrite: true };
const BOT_ID = 100;
const HTML = '<section><h2>The plan</h2><p>SECRET_HTML_MARKER</p></section>';

// ── The tables ─────────────────────────────────────────────────────────

function world() {
  const at = (minute) => new Date(Date.UTC(2026, 10, 19, 9, minute)).toISOString();
  const users = new Map([
    [7, { id: 7, username: 'ada', is_synthetic: false, display_name: null }],
    [8, { id: 8, username: 'bob', is_synthetic: false, display_name: null }],
    [9, { id: 9, username: 'root', is_synthetic: false, display_name: null }],
    [BOT_ID, { id: BOT_ID, username: 'homeroom_bot', is_synthetic: true, display_name: 'Homeroom bot' }],
  ]);
  const conversations = new Map([
    [501, { id: 501, kind: 'direct', status: 'active' }], // ada and the bot
    [502, { id: 502, kind: 'direct', status: 'active' }], // bob and the bot
    [503, { id: 503, kind: 'group', status: 'active' }], // ada and bob's group
  ]);
  const pairs = [
    { conversation_id: 501, user_low_id: 7, user_high_id: BOT_ID },
    { conversation_id: 502, user_low_id: 8, user_high_id: BOT_ID },
  ];
  const members = [[501, 7], [501, BOT_ID], [502, 8], [502, BOT_ID], [503, 7], [503, 8]]
    .map(([conversation_id, user_id]) => ({ conversation_id, user_id, status: 'member' }));
  const message = (id, conversation_id, sender_id, content, extra = {}) => ({
    id, conversation_id, sender_id, content, created_at: at(id % 60), edited_at: null,
    deleted_at: null, moderation_hidden_at: null, thread_root_id: null, reply_to_id: null,
    msg_type: 'message', metadata: {}, ...extra,
  });
  const messages = [
    message(1000, 501, 7, 'Can you draw the settings screen darker?'),
    message(1001, 501, BOT_ID, '**Version 2**: Settings, darker. What should change?', {
      thread_root_id: 1000,
      metadata: { homeroomBot: { kind: 'design_version', designVersion: 2, designTitle: 'Settings', appSlug: 'recipe-box' } },
    }),
    message(1002, 501, BOT_ID, 'Here is the plan. Build it when it looks right.', {
      thread_root_id: 1000,
      metadata: { homeroomBot: {
        kind: 'reply', html: HTML, actionId: 77, issueNumber: 12, sessionId: 4303, appSlug: 'recipe-box',
        actions: [{ id: 'build', label: 'Build it', style: 'primary', type: 'server' }], status: 'open',
        card: { type: 'options', v: 1, options: [{ key: 'A', title: 'CARD_BODY_MARKER' }] },
      } },
    }),
    message(1003, 501, 7, 'OLD_DELETED_WORDS', { thread_root_id: 1000, deleted_at: at(30) }),
    message(1004, 501, 7, 'Like this one, please.', {
      thread_root_id: 1000, reply_to_id: 1002, metadata: { designPin: { version: 2, x: 0.5, y: 0.25 } },
    }),
    message(1005, 501, 7, 'Removed by moderation', { thread_root_id: 1000, moderation_hidden_at: at(40) }),
    message(1100, 501, BOT_ID, 'Hello! I am Homeroom bot.', { metadata: { homeroomBot: { kind: 'hello' } } }),
    message(2000, 502, 8, 'BOB_SECRET idea for a garden planner'),
    message(2001, 502, BOT_ID, 'BOB_SECRET answer', { thread_root_id: 2000 }),
    message(3000, 503, 7, 'A group message'),
    message(3001, 503, 8, 'A group reply', { thread_root_id: 3000 }),
  ];
  const attachments = [
    { id: 'a'.repeat(32), message_id: 1004, conversation_id: 501, kind: 'image', filename: 'darker.png',
      content_type: 'image/png', size_bytes: 2048, meta: null },
    { id: 'd'.repeat(32), message_id: 1003, conversation_id: 501, kind: 'image', filename: 'gone.png',
      content_type: 'image/png', size_bytes: 10, meta: null },
  ];
  const privates = [
    { id: 61, user_id: 7, conversation_id: 501, root_message_id: 1000, app_id: 3, kind: 'design', state: 'open',
      title: 'Darker settings', title_source: 'auto', result_ref: null },
    { id: 62, user_id: 8, conversation_id: 502, root_message_id: 2000, app_id: null, kind: 'idea', state: 'open',
      title: 'BOB_SECRET garden', title_source: 'auto', result_ref: null },
  ];
  const apps = new Map([[3, { id: 3, slug: 'recipe-box', name: 'Recipe box' }]]);
  return { users, conversations, pairs, members, messages, attachments, privates, apps, at };
}

// ── The database: the services' own SQL, answered from the tables ────

function fakePool(w = world()) {
  const queries = [];
  const byId = (id) => w.messages.find((m) => m.id === Number(id)) || null;
  const userOf = (id) => w.users.get(Number(id)) || null;
  const selectRow = (m) => {
    const sender = userOf(m.sender_id);
    const quoted = m.reply_to_id ? byId(m.reply_to_id) : null;
    const quotedBy = quoted ? userOf(quoted.sender_id) : null;
    const root = m.thread_root_id ? byId(m.thread_root_id) : null;
    return {
      id: m.id, conversation_id: m.conversation_id, sender_id: m.sender_id, content: m.content,
      created_at: m.created_at, edited_at: m.edited_at, deleted_at: m.deleted_at,
      moderation_hidden_at: m.moderation_hidden_at, thread_root_id: m.thread_root_id, msg_type: m.msg_type,
      metadata: m.metadata,
      sender_username: sender && sender.username, sender_avatar_id: null,
      sender_is_synthetic: !!(sender && sender.is_synthetic), sender_display_name: sender && sender.display_name,
      reply_id: quoted && quoted.id, reply_sender_id: quoted && quoted.sender_id,
      reply_content: quoted && quoted.content, reply_deleted_at: quoted && quoted.deleted_at,
      reply_sender_username: quotedBy && quotedBy.username, reply_sender_avatar_id: null,
      reply_sender_is_synthetic: !!(quotedBy && quotedBy.is_synthetic),
      reply_sender_display_name: quotedBy && quotedBy.display_name,
      thread_root_content: root && root.content, thread_root_deleted_at: root && root.deleted_at,
      thread_root_reply_to_id: root && root.reply_to_id, thread_root_metadata: root && root.metadata,
      thread_root_sender_username: root && userOf(root.sender_id) && userOf(root.sender_id).username,
    };
  };
  const isMember = (conversationId, userId) => w.members.some((m) => m.conversation_id === Number(conversationId)
    && m.user_id === Number(userId) && m.status === 'member');
  const pairOf = (conversationId) => w.pairs.find((p) => p.conversation_id === Number(conversationId)) || null;
  const appRow = (appId) => (appId ? w.apps.get(Number(appId)) : null) || null;

  const answer = (sql, p) => {
    if (/^\s*(INSERT|UPDATE|DELETE|WITH [a-z_]+ AS \(\s*(INSERT|UPDATE|DELETE))/i.test(sql)) {
      throw new Error(`a read wrote: ${sql.slice(0, 80)}`);
    }
    if (/FROM users WHERE username = \$1 AND is_synthetic = TRUE/.test(sql)) {
      return [...w.users.values()].filter((u) => u.username === p[0] && u.is_synthetic).map((u) => ({ id: u.id, username: u.username }));
    }
    // private-threads.js placeOfMessage
    if (/SELECT m\.id, m\.thread_root_id, m\.conversation_id FROM conversation_messages m JOIN conversation_direct_pairs d/.test(sql)) {
      const m = byId(p[0]);
      const pair = m && pairOf(m.conversation_id);
      return pair && pair.user_low_id === p[1] && pair.user_high_id === p[2]
        ? [{ id: m.id, thread_root_id: m.thread_root_id, conversation_id: m.conversation_id }] : [];
    }
    // conversations.js loadMembership
    if (/FROM conversations c JOIN conversation_members cm ON cm\.conversation_id = c\.id WHERE c\.id = \$1 AND cm\.user_id = \$2/.test(sql)) {
      const c = w.conversations.get(Number(p[0]));
      if (!c || c.status !== 'active' || !isMember(c.id, p[1])) return [];
      return [{ id: c.id, kind: c.kind, title: null, conversation_status: c.status, created_by: null,
        deleted_peer: false, role: 'member', membership_status: 'member', last_read_message_id: null }];
    }
    // loadDirectPeer
    if (/AS other_id FROM conversation_direct_pairs WHERE conversation_id = \$1/.test(sql)) {
      const pair = pairOf(p[0]);
      if (!pair || (pair.user_low_id !== p[1] && pair.user_high_id !== p[1])) return [];
      return [{ other_id: pair.user_low_id === p[1] ? pair.user_high_id : pair.user_low_id }];
    }
    // Nobody here blocked anybody: blockedEitherWay, and the quoted authors' blocks.
    if (/^SELECT (1|blocked_user_id) FROM user_blocks/.test(sql)) return [];
    // isHomeroomBotDirect
    if (/FROM conversation_direct_pairs p JOIN users u ON u\.id IN \(p\.user_low_id, p\.user_high_id\)/.test(sql)) {
      const pair = pairOf(p[0]);
      const ids = pair ? [pair.user_low_id, pair.user_high_id] : [];
      return ids.some((id) => userOf(id) && userOf(id).is_synthetic && userOf(id).username === p[1]) ? [{ '?column?': 1 }] : [];
    }
    // listThread: the root, then a page of its replies
    if (/WHERE m\.id = \$1 AND m\.conversation_id = \$2 AND m\.thread_root_id IS NULL/.test(sql)) {
      const m = byId(p[0]);
      return m && m.conversation_id === Number(p[1]) && m.thread_root_id == null ? [selectRow(m)] : [];
    }
    if (/WHERE m\.thread_root_id = \$1 AND m\.conversation_id = \$2/.test(sql)) {
      const before = p[2] == null ? null : Number(p[2]);
      return w.messages
        .filter((m) => m.thread_root_id === Number(p[0]) && m.conversation_id === Number(p[1]) && (before == null || m.id < before))
        .sort((a, b) => b.id - a.id).slice(0, Number(p[4])).map(selectRow);
    }
    // hydrateMessages
    if (/FROM conversation_message_reactions/.test(sql)) return [];
    if (/FROM conversation_message_attachments WHERE message_id = ANY/.test(sql)) {
      return w.attachments.filter((a) => p[0].includes(a.message_id));
    }
    if (/FROM conversation_message_objects/.test(sql)) return [];
    if (/FROM conversation_message_bookmarks/.test(sql)) return [];
    // threadSummaries
    if (/WITH replies AS \(/.test(sql)) {
      return p[0].map((rootId) => {
        const replies = w.messages.filter((m) => m.thread_root_id === Number(rootId) && !m.deleted_at);
        if (!replies.length) return null;
        const newest = replies.reduce((a, b) => (b.id > a.id ? b : a));
        return {
          root_id: Number(rootId), reply_count: replies.length,
          last_reply_at: replies.map((m) => m.created_at).sort().pop(), participants: [],
          last_reply_id: newest.id, last_reply_content: newest.content, last_reply_created_at: newest.created_at,
          last_reply_sender_id: newest.sender_id, last_reply_username: userOf(newest.sender_id).username,
          last_reply_avatar_id: null,
        };
      }).filter(Boolean);
    }
    if (/FROM notifications n JOIN conversation_messages m ON m\.id = n\.conversation_message_id/.test(sql)) {
      return [{ first_unread_id: null, unread_count: 0 }];
    }
    // private-threads.js stateOf, and ownRoot when the thread has no row
    if (/FROM private_threads p LEFT JOIN design_threads d/.test(sql)) {
      const row = w.privates.find((r) => r.root_message_id === Number(p[0]) && r.user_id === Number(p[1]));
      if (!row) return [];
      const app = appRow(row.app_id);
      return [{ state: row.state, result_ref: row.result_ref, kind: row.kind, own_title: row.title,
        title_source: row.title_source, slug: app && app.slug, name: app && app.name, target_number: null,
        design_title: null, design_version: null, made: false, root_app_name: null }];
    }
    if (/SELECT m\.id, m\.conversation_id, m\.content, \(m\.sender_id = \$2\) AS own/.test(sql)) {
      const m = byId(p[0]);
      return m && m.thread_root_id == null && !m.deleted_at && isMember(m.conversation_id, p[1]) && m.sender_id === Number(p[1])
        ? [{ id: m.id, conversation_id: m.conversation_id, content: m.content, own: true, first_own: null }] : [];
    }
    // ai-work.js PRIVATE_SQL: the Homeroom bot page's list, for user $1
    if (/JOIN conversation_members mine ON mine\.conversation_id = c\.id AND mine\.user_id = \$1/.test(sql)) {
      return w.privates.filter((r) => r.user_id === Number(p[0]) && r.state !== 'done').map((r) => {
        const root = byId(r.root_message_id);
        const app = appRow(r.app_id);
        return {
          root_id: r.root_message_id, content: root.content, created_at: root.created_at, kind: r.kind,
          state: r.state, result_ref: r.result_ref, done_at: null, slug: app && app.slug, name: app && app.name,
          icon_emoji: null, icon_image_id: null, repo_url: null, title: r.title, title_source: r.title_source,
          first_own: null, about_kind: null, about_number: null, about_title: null, design_title: null,
          project_idea: null, draft_title: null, moved_title: null, root_app_name: null, last_at: null, result_done: false,
        };
      });
    }
    // private-threads.js unreadFor
    if (/SELECT p\.root_message_id AS root_id, COUNT\(\*\)::int AS unread FROM private_threads p/.test(sql)) {
      return w.privates.filter((r) => r.user_id === Number(p[0]) && p[1].includes(r.root_message_id) && r.unread)
        .map((r) => ({ root_id: r.root_message_id, unread: r.unread }));
    }
    // ai-history.js HISTORY_PRIVATE_SQL: finished private threads of user $1
    if (/SELECT p\.id, p\.root_message_id AS root_id, p\.kind, p\.state/.test(sql)) {
      return w.privates.filter((r) => r.user_id === Number(p[0]) && r.state === 'done' && (p[2] == null || r.done_at < p[2]))
        .sort((a, b) => String(b.done_at).localeCompare(String(a.done_at))).slice(0, Number(p[1])).map((r) => {
          const root = byId(r.root_message_id);
          const app = appRow(r.app_id);
          return {
            id: r.id, root_id: r.root_message_id, kind: r.kind, state: r.state, result_ref: null, done_at: r.done_at,
            updated_at: r.done_at, slug: app && app.slug, name: app && app.name, icon_emoji: null, icon_image_id: null,
            repo_url: null, content: root.content, about_kind: null, about_number: null, about_title: null,
            design_title: null, project_idea: null, draft_title: null, moved_title: null, root_app_name: null,
            first_own: null, result_at: null, result_outcome: null, about_outcome: null, at: r.done_at, title: r.title,
          };
        });
    }
    throw new Error(`unexpected query: ${sql.slice(0, 160)}`);
  };
  return {
    queries,
    world: w,
    async query(sql, params = []) {
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      queries.push({ sql: flat, params });
      return { rows: answer(flat, params) };
    },
  };
}

// registerTools takes an McpServer; a recorder standing in for one is enough.
function connector(user, pool) {
  const handlers = new Map();
  const specs = new Map();
  tools.registerTools({
    registerTool(name, spec, handler) { handlers.set(name, handler); specs.set(name, spec); },
  }, {
    accessToken: 'svmcp_test', scopes: [READ_SCOPE], user,
    clientName: 'Claude', clientId: 'c1', origin: ORIGIN, baseUrl: 'http://platform.internal',
    pool, config: {}, tokenId: null, grantId: null,
  });
  return { call: (args) => handlers.get('get_bot_thread')(args), spec: specs.get('get_bot_thread') };
}

const unwrap = (text) => String(text || '').replace(/^<untrusted-content>/, '').replace(/<\/untrusted-content>$/, '');

// ── Reading a thread ───────────────────────────────────────────────────

test('the person reads their own thread whole, oldest first', async () => {
  const pool = fakePool();
  const res = await connector(ADA, pool).call({ threadId: 1000 });
  assert.equal(res.isError, undefined, JSON.stringify(res.structuredContent));
  const out = res.structuredContent;
  assert.equal(out.threadId, 1000);
  assert.equal(unwrap(out.root.text), 'Can you draw the settings screen darker?');
  assert.equal(out.root.fromYou, true);
  assert.deepEqual(out.messages.map((m) => m.id), [1001, 1002, 1003, 1004, 1005], 'oldest first');
  assert.equal(out.hasMore, false);
  assert.equal(out.nextBefore, null);
  assert.deepEqual(out.threads, []);

  const [version, plan, , liked] = out.messages;
  assert.equal(unwrap(version.author), 'Homeroom bot');
  assert.equal(version.fromBot, true);
  assert.equal(version.fromYou, false);
  assert.equal(version.kind, 'message');
  assert.match(version.text, /^<untrusted-content>\*\*Version 2\*\*/, 'the words, whole and wrapped');
  assert.equal(liked.replyTo, 1002, 'a quote names what it quotes');
  assert.deepEqual(liked.designPin, { version: 2 });
  assert.deepEqual(liked.attachments, [{
    id: 'a'.repeat(32), kind: 'image', filename: '<untrusted-content>darker.png</untrusted-content>',
    contentType: 'image/png', sizeBytes: 2048,
  }]);
  assert.equal(plan.bot.offerId, 77);

  // The head the thread's bar draws, and the link that opens it.
  assert.equal(unwrap(out.thread.title), 'Darker settings');
  assert.equal(out.thread.kind, 'design');
  assert.equal(out.thread.state, 'open');
  assert.equal(out.thread.project.slug, 'recipe-box');
  assert.equal(out.thread.link, `${ORIGIN}/#homeroom-bot/thread/1000`);

  // The tool's own schema accepts what it answers.
  const { z } = require('zod');
  assert.equal(z.object(connector(ADA, pool).spec.outputSchema).safeParse(out).success, true);
});

test('a design version and a laid-out reply come back summarized, never as HTML', async () => {
  const res = await connector(ADA, fakePool()).call({ threadId: 1000 });
  const [version, plan] = res.structuredContent.messages;
  assert.deepEqual(version.bot, {
    kind: 'design_version', designVersion: 2, designTitle: '<untrusted-content>Settings</untrusted-content>', project: 'recipe-box',
  });
  assert.equal(plan.bot.kind, 'reply');
  assert.equal(plan.bot.htmlChars, HTML.length, 'flagged with its length');
  assert.equal(plan.bot.requestNumber, 12);
  assert.equal(plan.bot.changeId, 4303);
  assert.equal(plan.bot.card, 'options', 'a card by its type');
  assert.deepEqual(plan.bot.buttons, ['<untrusted-content>Build it</untrusted-content>']);
  assert.equal(plan.bot.status, 'open');
  const wire = JSON.stringify(res);
  assert.ok(!wire.includes('SECRET_HTML_MARKER'), 'the HTML itself is never sent');
  assert.ok(!wire.includes('<section>'));
  assert.ok(!wire.includes('CARD_BODY_MARKER'), 'nor what a card carries');
});

test('a deleted message and a moderated one keep their place, never their words', async () => {
  const res = await connector(ADA, fakePool()).call({ threadId: 1000 });
  const deleted = res.structuredContent.messages.find((m) => m.id === 1003);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.text, '');
  assert.equal(deleted.textChars, 0);
  assert.deepEqual(deleted.attachments, [], 'and no files');
  const moderated = res.structuredContent.messages.find((m) => m.id === 1005);
  assert.equal(moderated.moderated, true);
  assert.equal(moderated.text, '');
  const wire = JSON.stringify(res);
  assert.ok(!wire.includes('OLD_DELETED_WORDS'));
  assert.ok(!wire.includes('gone.png'));
});

test('somebody else\'s thread, a group\'s and a missing one are the same not_found, for an admin too', async () => {
  const pool = fakePool();
  const ada = connector(ADA, pool);
  const answers = [
    await ada.call({ threadId: 2000 }), // bob's thread
    await ada.call({ threadId: 2001 }), // a reply in it
    await ada.call({ threadId: 3000 }), // a group room's thread ada is in
    await ada.call({ threadId: 999999 }), // nothing at all
    await connector(ROOT, pool).call({ threadId: 2000 }), // an admin, bob's thread
    await connector(ROOT, pool).call({ threadId: 1000 }), // an admin, ada's thread
  ];
  for (const res of answers) {
    assert.equal(res.isError, true);
    assert.deepEqual(res.structuredContent, answers[0].structuredContent, 'one answer, whatever the number is');
  }
  assert.equal(answers[0].structuredContent.code, 'not_found');
  assert.ok(!JSON.stringify(answers).includes('BOB_SECRET'), 'nothing of bob\'s leaks');
  // Never even looked for in anybody else's chat: the search is the pair
  // (caller, bot), and no conversation but the caller's is read.
  const searched = pool.queries.filter((q) => /conversation_direct_pairs d/.test(q.sql));
  assert.ok(searched.length > 0);
  for (const q of searched) assert.ok([ADA.id, ROOT.id].includes(q.params[1]), 'the pair is the caller\'s');
  assert.ok(!pool.queries.some((q) => /m\.thread_root_id = \$1/.test(q.sql) && q.params[1] === 502),
    'bob\'s chat is never read');
});

test('bob reads his own, and a message id or a pasted link opens its thread', async () => {
  const pool = fakePool();
  const bob = await connector(BOB, pool).call({ threadId: 2000 });
  assert.equal(bob.structuredContent.threadId, 2000);
  assert.match(bob.structuredContent.root.text, /BOB_SECRET/);
  const ada = connector(ADA, pool);
  assert.equal((await ada.call({ threadId: 1004 })).structuredContent.threadId, 1000, 'a reply opens its thread');
  const link = await ada.call({ threadId: 'https://app.onhomeroom.com/#homeroom-bot/thread/1000/design/1' });
  assert.equal(link.structuredContent.threadId, 1000);
  assert.equal(link.structuredContent.messages.length, 5);
});

test('a long thread pages back with before, oldest first on every page', async () => {
  const w = world();
  for (let i = 0; i < 10; i += 1) {
    w.messages.push({
      id: 1200 + i, conversation_id: 501, sender_id: i % 2 ? BOT_ID : 7, content: `${'x'.repeat(7000)} ${i}`,
      created_at: w.at(50), edited_at: null, deleted_at: null, moderation_hidden_at: null, thread_root_id: 1000,
      reply_to_id: null, msg_type: 'message', metadata: {},
    });
  }
  const c = connector(ADA, fakePool(w));
  const first = (await c.call({ threadId: 1000 })).structuredContent;
  assert.ok(first.messages.reduce((n, m) => n + m.textChars, 0) <= tools.MAX_BOT_THREAD_PAGE_CHARS);
  assert.ok(first.messages.length < 15, 'cut for length');
  assert.equal(first.messages[first.messages.length - 1].id, 1209, 'the newest are kept');
  assert.equal(first.hasMore, true);
  assert.equal(first.nextBefore, first.messages[0].id);
  for (const m of first.messages) assert.equal(m.textChars, unwrap(m.text).length, 'each message whole');
  const second = (await c.call({ threadId: 1000, before: first.nextBefore })).structuredContent;
  assert.ok(second.messages.length > 0);
  assert.ok(second.messages.every((m) => m.id < first.nextBefore));
  const ids = second.messages.map((m) => m.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));

  const small = (await c.call({ threadId: 1000, limit: 2 })).structuredContent;
  assert.deepEqual(small.messages.map((m) => m.id), [1208, 1209]);
  assert.equal(small.nextBefore, 1208);
});

test('bad input is refused before anything is read', async () => {
  const pool = fakePool();
  const c = connector(ADA, pool);
  for (const args of [
    { threadId: 'not a link' },
    { threadId: '#messages/app/recipe-box/thread/12' },
    { threadId: 0 },
    { threadId: 1000, before: -1 },
    { threadId: 1000, olderThan: '2026-11-01T00:00:00Z' },
    { before: 5 },
    { olderThan: 'yesterday-ish' },
  ]) {
    const res = await c.call(args);
    assert.equal(res.structuredContent.code, 'invalid_request', JSON.stringify(args));
  }
  assert.equal(pool.queries.length, 0);
});

// ── The list ───────────────────────────────────────────────────────────

test('the list holds the caller\'s threads and nobody else\'s', async () => {
  const pool = fakePool();
  const w = pool.world;
  w.privates[0].unread = 2;
  w.privates.push({ id: 63, user_id: 7, conversation_id: 501, root_message_id: 1100, app_id: null, kind: 'hello',
    state: 'done', done_at: w.at(5), title: 'Hello', title_source: null, result_ref: null });
  const c = connector(ADA, pool);
  const res = await c.call({});
  assert.equal(res.isError, undefined, JSON.stringify(res.structuredContent));
  const out = res.structuredContent;
  const { z } = require('zod');
  assert.equal(z.object(c.spec.outputSchema).safeParse(out).success, true, 'the list fits the tool\'s own schema');
  assert.deepEqual(out.threads.map((t) => t.threadId), [1000, 1100], 'the page\'s list, then finished ones');
  const [open, done] = out.threads;
  assert.equal(unwrap(open.title), 'Darker settings');
  assert.equal(open.status, 'open');
  assert.equal(open.kind, 'design');
  assert.equal(open.project.slug, 'recipe-box');
  assert.equal(open.replyCount, 4, 'deleted replies are not counted');
  assert.equal(open.unread, 2);
  assert.equal(open.link, `${ORIGIN}/#homeroom-bot/thread/1000`);
  assert.equal(done.status, 'finished');
  assert.equal(done.outcome, 'done');
  assert.equal(done.finishedAt, w.at(5));
  assert.equal(out.hasMore, false);
  assert.equal(out.nextOlderThan, null);
  assert.equal(out.threadId, null);
  assert.ok(!JSON.stringify(res).includes('BOB_SECRET'));
  // Every list read is the caller's.
  for (const q of pool.queries.filter((x) => /private_threads p|conversation_members mine/.test(x.sql))) {
    assert.equal(q.params[0], ADA.id);
  }

  const bob = (await connector(BOB, pool).call({})).structuredContent;
  assert.deepEqual(bob.threads.map((t) => t.threadId), [2000]);
  const admin = (await connector(ROOT, pool).call({})).structuredContent;
  assert.deepEqual(admin.threads, [], 'an admin lists only their own, here none');
});

test('listOwnThreads folds a thread both lists hold into the active one, and pages finished ones', async () => {
  const calls = [];
  const deps = {
    bot: { id: BOT_ID },
    aiWork: { async privateFor(pool, { user }) { calls.push(['work', user.id]); return [{ rootId: 5, title: 'A', at: '2026-11-19T09:00:00.000Z' }]; } },
    aiHistory: {
      async historyFor(pool, { user, before, limit }) {
        calls.push(['history', user.id, before, limit]);
        return { rows: [{ rootId: 5, kind: 'solo', outcome: 'done' }, { rootId: 4, kind: 'solo', outcome: 'put_away' }], next: '2026-11-01T00:00:00.000Z' };
      },
    },
    conversations: { async threadSummaries(pool, user, ids) { calls.push(['replies', user.id, ids]); return new Map(); } },
  };
  const first = await privateThreads.listOwnThreads(null, { user: ADA, limit: 3, deps });
  assert.deepEqual(first.active.map((p) => p.rootId), [5]);
  assert.deepEqual(first.finished.map((p) => p.rootId), [4], 'listed once, as active');
  assert.equal(first.next, '2026-11-01T00:00:00.000Z');
  assert.deepEqual(calls, [['work', 7], ['history', 7, null, 3], ['replies', 7, [5, 4]]]);

  calls.length = 0;
  const older = await privateThreads.listOwnThreads(null, { user: ADA, olderThan: '2026-11-01T00:00:00.000Z', deps });
  assert.deepEqual(older.active, [], 'a later page is History\'s alone');
  assert.deepEqual(calls[0], ['history', 7, '2026-11-01T00:00:00.000Z', 20]);
  assert.deepEqual((await privateThreads.listOwnThreads(null, { user: null, deps })).active, []);
});

// ── Pure parts ─────────────────────────────────────────────────────────

test('a thread is named by its number or by a pasted link of the chat with the bot', () => {
  const parse = tools.parseBotThreadId;
  assert.equal(parse(58922), 58922);
  assert.equal(parse(' 58922 '), 58922);
  assert.equal(parse('https://app.onhomeroom.com/#homeroom-bot/thread/58922/design/1'), 58922);
  assert.equal(parse('#homeroom-bot/thread/58922/m/58930'), 58922, 'the thread, not the message in it');
  assert.equal(parse('#homeroom-bot/m/58930'), 58930, 'a message, whose thread opens');
  assert.equal(parse('https://app.onhomeroom.com/#messages/44/thread/9'), 9, 'the old Messages address of the chat');
  assert.equal(parse('#messages/app/recipe-box/thread/9'), null, 'a project\'s reply thread is get_discussion\'s');
  assert.equal(parse('#homeroom-bot/thread/58922x'), null);
  for (const bad of [0, -3, 1.5, '99999999999', '', null, {}, '#homeroom-bot']) assert.equal(parse(bad), null, String(bad));
});

test('a bot message with nothing to draw says nothing, and junk in its metadata is dropped', () => {
  assert.equal(tools.botMessageSummary(null), null);
  assert.equal(tools.botMessageSummary({}), null);
  assert.equal(tools.botMessageSummary([]), null);
  assert.deepEqual(tools.botMessageSummary({
    kind: 'Not A Code', designVersion: -1, appSlug: '../etc', issueNumber: 'x', actionId: 0,
    card: { type: 'DROP TABLE' }, status: 'weird', chosen: 'Yes please', actions: [{ label: 7 }],
  }), null);
  assert.deepEqual(tools.botMessageSummary({ kind: 'reply', liveWork: { appSlug: 'plant-pal', issueNumber: 4 }, outcome: { state: 'done', text: 'Filed.' } }),
    { kind: 'reply', project: 'plant-pal', requestNumber: 4, outcome: 'done' });
  // A person's message never carries a bot summary, whatever its metadata says.
  const person = tools.shapeBotThreadMessage({
    id: 3, sender: { id: 7, username: 'ada' }, content: 'hi', metadata: { homeroomBot: { kind: 'reply', html: HTML } },
  }, 7);
  assert.equal(person.bot, undefined);
  assert.equal(person.fromYou, true);
});

test('fitting a page keeps its newest messages and at least one', () => {
  const m = (id, textChars) => ({ id, textChars });
  assert.deepEqual(tools.fitBotThreadPage([m(1, 10), m(2, 10), m(3, 10)], 25), { messages: [m(2, 10), m(3, 10)], cut: true });
  assert.deepEqual(tools.fitBotThreadPage([m(1, 10), m(2, 90)], 25), { messages: [m(2, 90)], cut: true });
  assert.deepEqual(tools.fitBotThreadPage([m(1, 10)], 25), { messages: [m(1, 10)], cut: false });
  assert.deepEqual(tools.fitBotThreadPage([], 25), { messages: [], cut: false });
});

// ── Who sees it ────────────────────────────────────────────────────────

test('get_bot_thread is a read for external clients only, within the description budget', () => {
  const { spec } = connector(ADA, fakePool());
  assert.equal(spec.annotations.readOnlyHint, true);
  assert.equal(tools.isHintEligibleTool('get_bot_thread'), true);
  const { TOOL_DESCRIPTION_MAX_CHARS } = require('../src/services/mcp-connect-constants');
  assert.ok(spec.description.length <= TOOL_DESCRIPTION_MAX_CHARS);
  assert.match(spec.description, /untrusted content/);
  assert.match(spec.description, /OWN private threads with Homeroom bot/);
  assert.equal(audiences.toolVisibleTo('external', 'get_bot_thread'), true);
  for (const kind of ['agent_mayor', 'worker_read', 'bot_admin']) {
    assert.equal(audiences.toolVisibleTo(kind, 'get_bot_thread'), false, kind);
  }
  const charter = require('../src/services/mcp-charter');
  const section = charter.CHARTER_SECTIONS.find((s) => s.id === 'posting-in-discussions');
  assert.match(section.text, /get_bot_thread reads/);
});
