'use strict';

// QA 2026-09-24 Q16: Leave group, then Back.
//
// Leaving navigates to the list, but the conversation's own address is still
// in the history. Back reopened it: the store fetched, got the 404 that leaving
// is supposed to produce, and the pane drew "This conversation is no longer
// available." in red beside a Try again that could never work. A conversation
// left in this tab is answered from the store now, as a plain "You left this
// group." with the way back to the list, and a 404 offers that way back rather
// than a retry that reads the same answer.
//
// Run with: node --test tests/messages-left-group-back.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const GROUP = 7;
const SCREEN = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/messages/index.tsx'), 'utf8');

function install() {
  const reads = [];
  let member = true;
  global.window = {
    location: { hash: '', search: '' },
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    innerWidth: 1280,
    App: { user: { id: 1, username: 'me' } },
    Notifications: { markConversationRead() {}, markConversationThreadRead() {} },
  };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  global.fetch = async (url, init = {}) => {
    const address = String(url);
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (address === `/api/conversations/${GROUP}/leave` && init.method === 'POST') {
      member = false;
      return json({ ok: true });
    }
    if (init.method === 'POST') return json({});
    if (address === `/api/conversations/${GROUP}`) {
      reads.push('conversation');
      return member
        ? json({ conversation: { id: GROUP, kind: 'group', title: 'Launch crew', membershipStatus: 'member', members: [] } })
        : json({ error: 'Not found' }, 404);
    }
    if (address.startsWith(`/api/conversations/${GROUP}/messages?`)) return json({ messages: [], next_before: null });
    if (address.startsWith('/api/conversations')) {
      return json({ conversations: member ? [{ id: GROUP, kind: 'group', title: 'Launch crew', membershipStatus: 'member' }] : [] });
    }
    return json({ discussions: [] });
  };
  return { reads, rejoin: () => { member = true; } };
}

const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 5)); };

function snapshotOf(store) {
  let snap = null;
  const Probe = () => { snap = store.useMessagesSnapshot(); return null; };
  renderToHtml(createElement(Probe));
  return snap;
}

test('Q16: Back onto a group left in this tab says so, without a fetch or a retry', async () => {
  const { reads } = install();
  try {
    const store = loadTsx('frontend/src/features/messages/store.ts');
    store.route(GROUP, null, null, {});
    await settle();
    assert.equal(snapshotOf(store).active?.id, GROUP, 'the group is open');

    await store.leave();
    assert.equal(window.location.hash, '#messages', 'leaving goes to the list');
    store.route(null, null, null, {}); // …which the router then routes
    await settle();

    // Back: the router routes the conversation's address again.
    reads.length = 0;
    store.route(GROUP, null, null, {});
    await settle();
    const snap = snapshotOf(store);
    assert.equal(snap.threadGone, 'left');
    assert.equal(snap.threadError, null, 'not an error: it is what the viewer asked for');
    assert.deepEqual(reads, [], 'and nothing is fetched to find out');
  } finally {
    delete global.window;
    delete global.fetch;
    delete global.localStorage;
  }
});

test('Q16: a group listed again (invited back) opens normally', async () => {
  const { rejoin } = install();
  try {
    const store = loadTsx('frontend/src/features/messages/store.ts');
    store.route(GROUP, null, null, {});
    await settle();
    await store.leave();
    store.route(null, null, null, {});
    await settle();
    rejoin();
    await store.loadConversations(true);
    store.route(GROUP, null, null, {});
    await settle();
    const snap = snapshotOf(store);
    assert.equal(snap.threadGone, null);
    assert.equal(snap.active?.id, GROUP);
  } finally {
    delete global.window;
    delete global.fetch;
    delete global.localStorage;
  }
});

test('Q16: the pane offers the way out for a conversation that cannot come back', () => {
  // Left: plain text in the ordinary state colour, and the list.
  assert.match(SCREEN,
    /snap\.threadGone === 'left' \? <div className="messages-state" data-thread-gone="left"><p>You left this group\.<\/p><button type="button" onClick=\{\(\) => messagesController\.open\(null\)\}>Back to Messages<\/button><\/div>/);
  // A 404: the message stays, but Try again gives way to the list.
  assert.match(SCREEN,
    /snap\.threadGone === 'missing'\s*\? <button type="button" onClick=\{\(\) => messagesController\.open\(null\)\}>Back to Messages<\/button>\s*: <button type="button" onClick=\{\(\) => messagesController\.route\(conversationId\)\}>Try again<\/button>/);
});
