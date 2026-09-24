'use strict';

// QA 2026-09-24 Q14: a group can be renamed, and its header counts right.
//
// The group's ⋯ menu offered "Members & invitations" and "Refresh
// conversation" and nothing else, although PATCH /api/conversations/:id has
// renamed a group (for its owner) all along and api.ts already had the call.
// The header read "1 members", and an invitee — who is not shown the roster
// until they accept — read "0 members".
//
// Run with: node --test tests/messages-group-header.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SCREEN = read('frontend/src/features/messages/index.tsx');
const SERVICE = read('src/services/conversations.js');
const HEADER = SCREEN.slice(SCREEN.indexOf('function ThreadHeader('), SCREEN.indexOf('/** The day a message was sent'));

test('Rename group is offered to whoever the server lets rename: the owner (canManage)', () => {
  // The server's own gate: an active group, the caller its owner and a member.
  assert.match(SERVICE, /async function updateTitle[\s\S]*?cm\.status = 'member' AND cm\.role = 'owner'/);
  assert.match(SERVICE, /canManage: row\.kind === 'group' && row\.my_role === 'owner' && row\.membership_status === 'member'/);
  // Merged with QA Q18 (the ⋯ is a keyboard menu): the rename row is a menuitem
  // that hands focus back to the ⋯ before the dialog opens.
  assert.match(HEADER, /active\.kind === 'group' && active\.canManage\s*\? <button type="button" role="menuitem" data-rename-group="" onClick=\{\(\) => \{ menuBtnRef\.current\?\.focus\(\{ preventScroll: true \}\); void renameGroup\(\); \}\}>Rename group<\/button>\s*: null/);
});

test('it is the kit’s one-field dialog, pre-filled with the current name and capped at the server’s 80', () => {
  assert.match(HEADER, /ui\.prompt\(\{ title: 'Rename group', value: current, placeholder: 'Group name', confirmLabel: 'Save', maxLength: 80 \}\)/);
  assert.match(HEADER, /const current = active\?\.title \|\| '';/);
  assert.match(HEADER, /if \(next == null\) return;/, 'Cancel changes nothing');
  assert.match(HEADER, /catch \(err\) \{ ui\.toast\?\.\(err instanceof Error \? err\.message : 'Couldn’t rename this group\.'\); \}/);
});

test('the header counts "1 member" and "N members", and an invitee reads the invitation, not "0 members"', () => {
  assert.match(HEADER, /const count = \(n: number\) => `\$\{n\} \$\{n === 1 \? 'member' : 'members'\}`;/);
  assert.doesNotMatch(HEADER, /\$\{active\.memberCount\} members/, 'no unconditional plural left');
  assert.match(HEADER, /: invited\s*\? 'Invitation pending'/);
  assert.match(HEADER, /\? `\$\{count\(active\.memberCount\)\}\$\{active\.myRole === 'owner' \? ' · you own this group' : ''\}`/);
  // The list row's member-count tag is not drawn for an invitee either.
  assert.match(SCREEN, /conversation\.kind === 'group' && !invited \? <span className="messages-group-tag">/);
});

function harness(updateConversation) {
  const GROUP = {
    id: 42, kind: 'group', title: 'QA Flow Crew', membershipStatus: 'member', myRole: 'owner',
    members: [], memberCount: 1, unreadCount: 0, canSend: true, canInvite: true, canManage: true,
    lastActivityAt: '2026-09-24T12:00:00Z',
  };
  const api = {
    MessagesApiError: class extends Error { constructor(status, message) { super(message); this.status = status; } },
    strictId: (value) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null),
    listConversations: async () => [GROUP],
    getConversation: async () => GROUP,
    listMessages: async () => ({ messages: [], nextBefore: null }),
    markRead: async () => {},
    listAppDiscussions: async () => ({ discussions: [] }),
    updateConversation,
  };
  let read = null;
  const react = { useSyncExternalStore: (subscribe, snap) => { read = snap; return snap(); } };
  globalThis.window = {
    App: { user: { id: 7, username: 'me' } },
    location: { search: '', hash: '#messages/42' },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  };
  const store = loadTsx('frontend/src/features/messages/store.ts', { stubs: { './api': api, react } });
  store.useMessagesSnapshot();
  return { store, state: () => read(), GROUP };
}

test('renaming sends the tidied name and updates the open header and the list', async () => {
  const calls = [];
  const h = harness(async (id, body) => { calls.push([id, body]); return { ...h.GROUP, title: body.title }; });
  h.store.messagesController.route(42);
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await h.store.renameConversation('  Launch   planning ');
  assert.deepEqual(calls, [[42, { title: 'Launch planning' }]], 'whitespace collapsed, as normalizeTitle does');
  assert.equal(h.state().active.title, 'Launch planning');
  assert.equal(h.state().conversations.find((item) => item.id === 42).title, 'Launch planning');
  await h.store.renameConversation('Launch planning');
  assert.equal(calls.length, 1, 'an unchanged name is not sent');
});

test('an empty or overlong name says why instead of coming back as a 404', async () => {
  const calls = [];
  const h = harness(async (id, body) => { calls.push(body); return h.GROUP; });
  h.store.messagesController.route(42);
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(h.store.renameConversation('   '), /A group needs a name\./);
  await assert.rejects(h.store.renameConversation('x'.repeat(81)), /Group names can be up to 80 characters\./);
  assert.equal(calls.length, 0);
});
