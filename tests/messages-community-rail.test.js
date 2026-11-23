'use strict';

// The community rail and channel drawer (#6992).
//
// Messages' left column lists the viewer's communities, and picking one lists
// that community's channels. No new route and no new storage: the rail is
// built from the conversation list and the app discussions Messages already
// loads, and a channel opens at the address it already had.
//
// What is pinned here:
//
//   1. THE ORDER: Direct messages, Homeroom, then the server's order, with the
//      platform's own discussion never listed twice.
//   2. A TOPIC OPENS WHERE IT LIVES: its project's channel address.
//   3. A COUNT: 0 says nothing, 99+ past ninety-nine.
//   4. THE PICK IS VALIDATED: a project the person has left does not stay
//      selected, and someone with no conversations lands on Homeroom.
//   5. THE RAIL IS THE STANDARD LIST'S ONLY: the frame look's list keeps the
//      rows it had.
//
// Run with: node --test tests/messages-community-rail.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { message } = require('./lib/platform-i18n');
const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

globalThis.window = globalThis.window || {
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() { return true; },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  location: { hash: '' },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.document = globalThis.document || {
  addEventListener() {},
  removeEventListener() {},
  documentElement: {},
  visibilityState: 'visible',
};

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SCREEN = read('frontend/src/features/messages/index.tsx');

const rail = loadTsx('frontend/src/features/messages/community-rail.ts');

const PLATFORM = 'usernode-2d5619';

const CONVERSATIONS = [
  { id: 9, kind: 'channel', title: 'general', channelKey: 'general', unreadCount: 3, latestSummary: 'The new Home is live' },
  { id: 4, kind: 'direct', title: 'Rin', unreadCount: 0, latestSummary: 'hey' },
];

const DISCUSSIONS = [
  {
    slug: 'game-corner', name: 'Game Corner', channel: 'game-corner',
    iconUrl: null, iconEmoji: '🎮', lastMessage: 'next round?', lastAt: null, lastBy: 'Rin', unreadCount: 21,
  },
  {
    slug: PLATFORM, name: 'Homeroom', channel: 'homeroom',
    iconUrl: null, iconEmoji: null, lastMessage: 'platform', lastAt: null, lastBy: null, unreadCount: 7,
  },
];

const PLACES = {
  owed: null,
  channels: [
    { id: 1, kind: 'general', key: null, handle: 'general', aliases: [], name: 'general', about: '', icon: '', state: 'live', merged_into: null, merged_at: null, requests: null, unread: 0 },
    { id: 2, kind: 'topic', key: 'builds', handle: 'builds', aliases: [], name: 'Builds', about: '', icon: '🏗️', state: 'live', merged_into: null, merged_at: null, requests: 2, unread: 4 },
    { id: 3, kind: 'topic', key: 'old', handle: 'retired', aliases: [], name: 'Retired', about: '', icon: '', state: 'archived', merged_into: null, merged_at: null, requests: null, unread: 9 },
    { id: 4, kind: 'topic', key: 'quiet', handle: 'quiet', aliases: [], name: 'Quiet', about: '', icon: '', state: 'live', merged_into: null, merged_at: null, requests: 0, unread: 5, muted: true },
  ],
};

test('the rail is Direct messages, Homeroom, then the server order, without repeating the platform', () => {
  const entries = rail.railEntries({ conversations: CONVERSATIONS, discussions: DISCUSSIONS, platformSlug: PLATFORM });
  assert.deepEqual(entries.map((e) => e.key), ['dm', 'homeroom', 'app:game-corner']);
  const homeroom = entries[1];
  assert.equal(homeroom.slug, PLATFORM);
  assert.equal(homeroom.general.target, '#messages/9');
  assert.equal(homeroom.unread, 3);
  const app = entries[2];
  assert.equal(app.general.target, '#messages/app/game-corner');
  assert.equal(app.unread, 21);
  assert.equal(app.iconEmoji, '🎮');
});

test('no platform slug, or no #general conversation, means no Homeroom tile', () => {
  // Without the platform's slug nothing can tell its discussion apart from any
  // other project, so it is listed like one until the slug lands.
  const noSlug = rail.railEntries({ conversations: CONVERSATIONS, discussions: DISCUSSIONS, platformSlug: null });
  assert.deepEqual(noSlug.map((e) => e.key), ['dm', 'app:game-corner', `app:${PLATFORM}`]);
  assert.ok(!noSlug.some((e) => e.kind === 'homeroom'));
  const noGeneral = rail.railEntries({
    conversations: [{ id: 4, kind: 'direct', title: 'Rin', unreadCount: 0 }],
    discussions: DISCUSSIONS,
    platformSlug: PLATFORM,
  });
  assert.deepEqual(noGeneral.map((e) => e.key), ['dm', 'app:game-corner']);
});

test('a community lists #general first, then its live topics at their own addresses', () => {
  const entries = rail.railEntries({ conversations: CONVERSATIONS, discussions: DISCUSSIONS, platformSlug: PLATFORM });
  const homeroom = entries[1];
  const rows = rail.channelRows(homeroom, PLACES);
  assert.deepEqual(rows.map((r) => r.handle), ['general', 'builds', 'quiet']);
  assert.equal(rows[0].name, 'general');
  assert.equal(rows[0].target, '#messages/9');
  assert.equal(rows[0].preview, 'The new Home is live');
  assert.equal(rows[1].target, `#app/${PLATFORM}/dev/c/builds`);
  assert.equal(rows[1].unread, 4);
  // A muted channel says nothing new; a retired one is not listed at all.
  assert.equal(rows[2].unread, 0);
  assert.ok(!rows.some((r) => r.handle === 'retired'));
});

test('the drawer search narrows by name or handle, case-insensitively', () => {
  const entries = rail.railEntries({ conversations: CONVERSATIONS, discussions: DISCUSSIONS, platformSlug: PLATFORM });
  const homeroom = entries[1];
  assert.deepEqual(rail.channelRows(homeroom, PLACES, 'BUILD').map((r) => r.handle), ['builds']);
  assert.deepEqual(rail.channelRows(homeroom, PLACES, 'general').map((r) => r.handle), ['general']);
  assert.deepEqual(rail.channelRows(homeroom, PLACES, 'zzz'), []);
});

test('a count says nothing at zero and caps at 99+', () => {
  assert.equal(rail.railUnreadShown(0), '');
  assert.equal(rail.railUnreadShown(-3), '');
  assert.equal(rail.railUnreadShown(1), '1');
  assert.equal(rail.railUnreadShown(99), '99');
  assert.equal(rail.railUnreadShown(100), '99+');
});

test('the remembered pick is kept only while the rail still has that button', () => {
  const entries = rail.railEntries({ conversations: CONVERSATIONS, discussions: DISCUSSIONS, platformSlug: PLATFORM });
  assert.equal(rail.savedRailPick('app:game-corner', entries), 'app:game-corner');
  assert.equal(rail.savedRailPick('app:gone', entries), null);
  assert.equal(rail.savedRailPick('', entries), null);
  assert.equal(rail.savedRailPick(null, entries), null);
  assert.equal(rail.savedRailPick('dm', entries), 'dm');
});

test('someone with no conversations lands on Homeroom; otherwise Direct messages', () => {
  const entries = rail.railEntries({ conversations: CONVERSATIONS, discussions: DISCUSSIONS, platformSlug: PLATFORM });
  assert.equal(rail.defaultRailPick(1, entries), 'dm');
  assert.equal(rail.defaultRailPick(0, entries), 'homeroom');
  assert.equal(rail.defaultRailPick(0, [{ key: 'dm', kind: 'dm' }]), 'dm');
});

test('<CommunityRail> marks the pick, shows its count, and hides a zero badge', () => {
  const { CommunityRail } = loadTsx('frontend/src/features/messages/community-rail-view.tsx');
  const entries = rail.railEntries({ conversations: CONVERSATIONS, discussions: DISCUSSIONS, platformSlug: PLATFORM });
  const html = renderToHtml(createElement(CommunityRail, { entries, pick: 'homeroom', onPick: () => {} }));
  assert.match(html, /data-community-rail=""/);
  assert.match(html, /aria-label="Your communities"/);
  assert.match(html, /aria-label="Direct messages"/);
  assert.match(html, /data-rail="homeroom"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-rail="homeroom"/);
  assert.match(html, /aria-label="Homeroom, 3 new messages"/);
  assert.match(html, /data-rail-unread="3">3</);
  // The game corner has 21; its badge says so. A zero renders no badge text.
  assert.match(html, /data-rail-unread="21">21</);
  const empty = renderToHtml(createElement(CommunityRail, {
    entries: entries.map((e) => ({ ...e, unread: 0 })),
    pick: 'dm',
    onPick: () => {},
  }));
  assert.match(empty, /data-rail-unread="0" hidden=""/);
});

test('<ChannelDrawer> draws #general while the community record is still loading', () => {
  const { ChannelDrawer } = loadTsx('frontend/src/features/messages/community-rail-view.tsx');
  const entries = rail.railEntries({ conversations: CONVERSATIONS, discussions: DISCUSSIONS, platformSlug: PLATFORM });
  const html = renderToHtml(createElement(ChannelDrawer, { entry: entries[1], query: '' }));
  assert.match(html, /data-drawer-channel="general"/);
  assert.match(html, /Channels/);
  assert.match(html, /Hub/);
  assert.match(html, /3 new/);
});

test('Messages mounts the rail in the standard list only, and both channel heads know the way back', () => {
  assert.match(SCREEN, /<CommunityRail entries=\{rail\}/);
  assert.match(SCREEN, /<ChannelDrawer entry=\{railEntry\}/);
  assert.match(SCREEN, /messages-has-rail/);
  // The frame look's list is untouched: no rail between its own pane and the
  // end of that branch.
  const frame = SCREEN.slice(SCREEN.indexOf('data-frame-list'), SCREEN.indexOf('messages-has-rail'));
  assert.doesNotMatch(frame, /CommunityRail/);
  // #6992: a channel opened from the drawer goes back to Messages.
  assert.match(SCREEN, /useRailReturn\(active\?\.kind === 'channel' \? 'homeroom' : null\)/);
  assert.match(SCREEN, /useRailReturn\(`app:\$\{slug\}`\)/);
});

test('the rail and drawer words are in the English catalog', () => {
  assert.equal(message('messages:rail.dm'), 'Direct messages');
  assert.equal(message('messages:rail.label'), 'Your communities');
  assert.equal(message('messages:rail.homeroom'), 'Homeroom');
  assert.equal(message('messages:drawer.channels'), 'Channels');
  assert.equal(message('messages:drawer.hub'), 'Hub');
  assert.equal(message('messages:drawer.searchPlaceholder'), 'Search channels');
  assert.equal(message('messages:rail.tile', { name: 'Homeroom', count: 3 }), 'Homeroom, 3 new messages');
  assert.equal(message('messages:drawer.unread', { shown: '3', count: 3 }), '3 new');
});
