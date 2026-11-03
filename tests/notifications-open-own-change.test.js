'use strict';

// #6099 — a notification about a change opens the change its own title names.
//
// The row's title is built from its own `session_id` (serialize() in
// src/services/notifications.js joins the change on it), but the tap used to
// prefer the row's pull request number. Several sessions can share one
// (app_id, pr_number): a change carried in another change's PR, or two changes
// proposed together. `dev/changes/<N>` is then looked up on the server
// (GET /api/apps/:slug/changes/:number), which deliberately collapses that
// group to ONE session (the one that reached a vote first, then the newest),
// so two notices in a row both opened the older change. The tap now carries the
// row's own session id, and the page's usual canonicalisation rewrites the
// address to `dev/changes/<N>` once it knows the number.
//
// The REAL shipped notifications.js runs in a vm, as in
// tests/vote-digest-destination.test.js.
//
// Run with: node --test tests/notifications-open-own-change.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { englishPlatformI18n } = require('./lib/platform-i18n');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(
  path.join(ROOT, 'frontend', 'src', 'features', 'notifications', 'notifications.js'),
  'utf8',
).replace(/^import \{ agoStamp \}.*$/m, '');

function load({ app = true } = {}) {
  const calls = [];
  const location = { search: '', hash: '' };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Promise, setTimeout, clearTimeout, URLSearchParams, location,
    localStorage: { getItem: () => null, setItem: () => {} },
    document: {
      title: '',
      getElementById: () => null,
      addEventListener: () => {},
      querySelectorAll: () => ({ forEach: () => {} }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({ unread: 0, cleared: 1 }) }),
    PlatformUI: { isTouch: () => false, toast() {} },
    UsernodeReact: {
      devBoard: { showVotes: (id) => calls.push(['showVotes', id]) },
    },
  };
  if (app) {
    sandbox.App = {
      user: { id: 1 },
      openAppTab: (slug, tab, opts) => { calls.push(['openAppTab', slug, tab, opts || null]); },
    };
  }
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.runInContext(SRC, sandbox);
  const N = sandbox.Notifications;
  N._markOneRead = () => {};
  N._dismissSheetForNav = () => calls.push(['dismiss']);
  return { N, calls, location, sandbox };
}

const nav = (calls) => JSON.parse(JSON.stringify(calls.filter((c) => c[0] !== 'dismiss')));
const openedRef = (calls) => nav(calls).filter((c) => c[0] === 'openAppTab').map((c) => c[3].ref);

// The reported case: two changes in one project whose sessions share nothing
// but the notices' own titles, then a pair that even share a PR number.
const OLDER = { id: 11, readAt: null, kind: 'pr_proposed', appSlug: 'notes', sessionId: 7296, prNumber: 4509 };
const NEWER = { id: 12, readAt: null, kind: 'pr_proposed', appSlug: 'notes', sessionId: 7300, prNumber: 4510 };
const SAME_PR = { ...NEWER, prNumber: 4509 };

test('two notices in a row open two different changes', () => {
  for (const tab of ['unread', 'all']) {
    const { N, calls } = load();
    if (tab === 'unread') N.items = [NEWER, OLDER];
    else N.savedNotifications = [NEWER, OLDER];
    N._onItemClick(OLDER.id);
    N._onItemClick(NEWER.id);
    assert.deepEqual(openedRef(calls), [
      { kind: 'proposal', id: 7296 },
      { kind: 'proposal', id: 7300 },
    ], `${tab}: each row opens the change its own title names`);
    assert.deepEqual(nav(calls)[0], ['showVotes', 7296], `${tab}: the vote nudge still lands on Votes`);
    assert.equal(nav(calls).every((c) => c[0] !== 'openAppTab' || c[3].subTab === 'topic'), true);
  }
});

// A change carried in another change's PR. The two rows name different
// sessions but the same pull request number; before, both opened whichever
// session the server picked for that number.
test('a notice for a change carried in another change’s PR opens its own change', () => {
  const { N, calls } = load();
  N.items = [SAME_PR, OLDER];
  N._onItemClick(SAME_PR.id);
  assert.deepEqual(openedRef(calls), [{ kind: 'proposal', id: 7300 }]);
  const open = nav(calls).find((c) => c[0] === 'openAppTab');
  assert.equal('pr' in open[3].ref, false,
    'the number is dropped once the session id is known, so _appUrl and the panel cannot resolve it back');
  assert.equal(N._changeHash('notes', 7300, 4509), '#app/notes/dev/proposals/7300');
  assert.deepEqual(JSON.parse(JSON.stringify(N._changeRef(7300, 4509))), { kind: 'proposal', id: 7300 });
});

test('without App the hash fallback is the same address', () => {
  const { N, calls, location } = load({ app: false });
  N.items = [SAME_PR];
  N._onItemClick(SAME_PR.id);
  assert.equal(location.hash, '#app/notes/dev/proposals/7300');
  assert.deepEqual(openedRef(calls), []);
});

test('a row with no session id keeps the number, and one with neither keeps the board', () => {
  const byNumber = load();
  byNumber.N.items = [{ id: 20, readAt: null, kind: 'pr_proposed', appSlug: 'notes', prNumber: 4509 }];
  byNumber.N._onItemClick(20);
  assert.deepEqual(openedRef(byNumber.calls), [{ kind: 'proposal', pr: 4509 }],
    'no session id: the PR number is the only address the row has');
  assert.equal(byNumber.N._changeHash('notes', null, 4509), '#app/notes/dev/changes/4509');

  const hashed = load({ app: false });
  hashed.N.items = [{ id: 21, readAt: null, kind: 'pr_proposed', appSlug: 'notes', prNumber: 4509 }];
  hashed.N._onItemClick(21);
  assert.equal(hashed.location.hash, '#app/notes/dev/changes/4509');

  const board = load();
  board.N.items = [{ id: 22, readAt: null, kind: 'pr_proposed', appSlug: 'notes' }];
  board.N._onItemClick(22);
  assert.deepEqual(nav(board.calls), [['openAppTab', 'notes', 'dev', { subTab: 'proposals', ref: null }]]);
});

test('the fold still opens its newest, and a history line opens its own', async () => {
  const stacks = loadTsx('frontend/src/features/notifications/notification-stacks.tsx');
  const view = (row) => ({
    id: row.id,
    kind: row.kind,
    unread: true,
    unreadCls: '',
    time: '2m ago',
    timeTitle: 'Sunday',
    icon: '🚀',
    label: 'New change',
    segments: [{ t: 'strong', v: `Change ${row.sessionId}` }],
    createdAtMs: 2000 - row.id,
    who: '',
    appLine: 'Notes',
    appName: 'Notes',
    appId: 5,
    storyKey: 'r:5:5580',
    storyRef: { number: 5580, title: 'Plant shelf' },
  });
  const entries = [NEWER, OLDER].map((row) => ({
    type: 'notif', key: `n:${row.id}`, at: 2000 - row.id, view: view(row),
  }));
  const folded = stacks.foldStories(entries);
  assert.equal(folded.length, 1, 'two notices about one request are one card');
  assert.deepEqual(folded[0].view.groupIds, [12, 11]);
  assert.equal(folded[0].view.id, 12, 'drawn as its newest notification');

  const { N, calls } = load();
  N.items = [NEWER, OLDER];
  N.unread = 2;
  await N.openGroupRow(12, [12, 11]);
  assert.deepEqual(openedRef(calls), [{ kind: 'proposal', id: 7300 }],
    'the card opens the newest change it is drawn as');
  N._onItemClick(11);
  assert.deepEqual(openedRef(calls), [
    { kind: 'proposal', id: 7300 },
    { kind: 'proposal', id: 7296 },
  ], 'a history line opens its own notification');
});

test('a phone push opens the row’s own change too', async () => {
  const { N, calls } = load();
  N.items = [NEWER, OLDER];
  assert.equal(await N.openById(12), true);
  assert.deepEqual(openedRef(calls), [{ kind: 'proposal', id: 7300 }]);
});
