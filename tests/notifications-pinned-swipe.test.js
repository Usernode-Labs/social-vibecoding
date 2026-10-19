// #5309: the pinned Saved + Invite rows of the notifications sheet sit in a
// React-owned slot and detach their swipe wiring.
//
// The kit's attachSwipeActions reparents the node it is handed into a
// .un-swipe wrapper it inserts in its place. A pinned row that React owned
// directly therefore left React removing it from a parent it was no longer
// in: Unsave threw NotFoundError, the island boundary escalated, and React
// dropped the whole tree while the sheet stayed painted — a sheet where
// Unsave, the tabs, rows, Mark all read and close did nothing, and the page
// behind it was dead too. ScreenRow in ./notifications-sheet.tsx already
// solved the same failure (#3538); the pinned rows use its pattern now.
//
// Two halves, the two ways tests here can hold this:
//
//  1. RENDERED — through tests/lib/render-tsx.js with a touch store holding
//     one of each pinned row: every row is the only child of a slot div,
//     which is the node React adds and removes.
//  2. SOURCE — every `ui.swipeActions(` call keeps the handle the kit
//     returns, and every effect that attaches returns a detach cleanup, so
//     the kit never keeps a wrapper around a node React re-owns.
//
// Run with: node --test tests/notifications-pinned-swipe.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const LIST_PATH = 'frontend/src/features/notifications/notifications-list.tsx';
const LIST_SRC = fs.readFileSync(path.join(ROOT, LIST_PATH), 'utf8');

const { createStore } = loadTsx('frontend/src/lib/plain-store.js');

function renderPinned({ saved, invites, touch }) {
  const notificationsStore = createStore({
    saved, invites, touch,
    items: [], loadingMore: false, screenCanLoadMore: false,
  });
  const mod = loadTsx(LIST_PATH, {
    stubs: { './notifications-store.js': { notificationsStore } },
  });
  return renderToHtml(createElement(mod.NotificationsPinnedSections));
}

const savedMessage = {
  type: 'message',
  messageId: 12,
  slug: 'community-garden',
  conversationId: 0,
  who: '@System',
  author: 'cyrcle_0',
  appName: 'Community garden',
  line: 'notifications:saved.line.authorApp',
  time: '4h ago',
  text: 'cyrcle_0 proposed changing the opening hours',
};

const savedNotification = {
  type: 'notification',
  id: 34,
  icon: '🎉',
  label: 'A change you voted on is live',
  segments: [{ t: 'text', v: 'Shorten plan lines' }],
  time: '4h ago',
};

const invite = {
  appId: 56,
  slug: 'page-turners',
  kind: 'build',
  icon: '📖',
  who: '@alex_t1005',
  inviter: 'alex_t1005',
  line: 'notifications:invite.line.build',
  appName: 'Page Turners',
  members: '1 person is in it',
  time: '2d ago',
};

test('on touch each pinned row is the only child of its React-owned slot', () => {
  const html = renderPinned({ saved: [savedMessage, savedNotification], invites: [invite], touch: true });

  // The saved rows carry their attribute before the class; the invite after
  // it — the exact tag order the source spells.
  const slotOf = (rowOpen) => {
    const marker = `<div class="notifications-row-slot"><div ${rowOpen}`;
    const start = html.indexOf(marker);
    if (start < 0) return null;
    const after = html.indexOf('</div></div>', start);
    return html.slice(start, after + '</div></div>'.length);
  };

  const messageSlot = slotOf('data-saved-message="12"');
  assert.ok(messageSlot, 'the saved message sits first in a slot of its own');
  assert.equal((messageSlot.match(/notifications-row-slot/g) || []).length, 1,
    'the slot holds exactly the one row — React adds and removes the slot');
  assert.match(messageSlot, /<button data-saved-unsave="12"/);

  const notificationSlot = slotOf('data-saved-notification="34"');
  assert.ok(notificationSlot, 'the saved notification sits in a slot of its own');
  assert.match(notificationSlot, /<button data-saved-notification-unsave="34"/);

  const inviteSlot = slotOf('class="notifications-row flex items-start gap-3 px-4 py-3" data-invite-app="56"');
  assert.ok(inviteSlot, 'the invite sits in a slot of its own');
  assert.match(inviteSlot, /<button data-invite-accept="56"/);
  assert.match(inviteSlot, /<button data-invite-decline="56"/);

  // The row's own ids, data-* attributes and class string are unchanged, so
  // dapp.json's #notifications-saved [data-saved-unsave] chains still resolve.
  assert.match(html, /<div id="notifications-saved" class="shrink-0 overflow-y-auto max-h-64">/);
  assert.match(html, /data-saved-message="12" class="notifications-row flex items-center gap-3 px-4 py-3"/);
});

test('at a desk the pinned rows keep the same slot wrapper (harmless there)', () => {
  const html = renderPinned({ saved: [savedMessage], invites: [], touch: false });
  assert.match(html, /<div class="notifications-row-slot"><div data-saved-message="12"/,
    'the slot is part of the row component, not something touch adds');
});

test('every swipeActions call keeps the handle and detaches in cleanup', () => {
  // No bare call: each attach is assigned, so its effect can detach.
  assert.doesNotMatch(LIST_SRC, /(?<!const swipe = )ui\.swipeActions\(/);
  assert.equal((LIST_SRC.match(/const swipe = ui\.swipeActions\(/g) || []).length, 3,
    'Saved, SavedNotification and Invite each attach once');
  assert.equal((LIST_SRC.match(/return \(\) => swipe\.detach\(\);/g) || []).length, 3,
    'each attaching effect returns a detach cleanup');
  assert.doesNotMatch(LIST_SRC, /if \(!touch \|\| !el \|\| !ui\?\.swipeActions\) return;/,
    'an early exit returns undefined, like ScreenRow');

  // The comment says why: the kit reparents the node it is handed.
  assert.match(LIST_SRC, /\.un-swipe/);
  assert.match(LIST_SRC, /notifications-row-slot/);
  assert.match(LIST_SRC, /notifications-sheet\.tsx/);
});
