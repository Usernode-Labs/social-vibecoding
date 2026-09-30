'use strict';

// A project's page is its community's HUB beside its WORKSHOP, and the
// channels live on the hubs rather than in Messages:
//
//   - the middle tab is Communities (frontend/src/features/nav/tab-bar.tsx),
//     with a count of the channels you have unread;
//   - a project's page has two tabs, the hub and the Workshop, with Needs you
//     and All items as pages under them (dev-board/workshop/workshop.tsx);
//   - the hub draws the channel's last messages, what needs you, and members
//     and activity (dev-board/workshop/hub-cards.tsx);
//   - Messages is people and agents, and an open channel lights Communities
//     and hangs off its hub (features/messages/);
//   - #general is the Homeroom community's channel: posting there needs that
//     community, and Homeroom's old project channel is read-only.
//
// The database half (the #general gate, the archive, the summaries) is pinned
// against a real schema in tests/communities-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const HUB = 'frontend/src/features/dev-board/workshop/hub-cards.tsx';
const LANDER = read('frontend/src/features/dev-board/workshop/workshop.tsx');
const TABS = read('frontend/src/features/nav/tab-bar.tsx');
const STORE = read('frontend/src/features/messages/store.ts');

const community = (over = {}) => ({
  slug: 'garden',
  name: 'Garden',
  member_count: 12,
  is_member: true,
  is_creator: false,
  audience: 'open',
  audience_label: 'Public community',
  members: [{ id: 1, username: 'ada' }, { id: 2, username: 'lin' }],
  channel: {
    last_message: 'See you Sunday',
    last_at: '2026-09-20T10:00:00Z',
    last_by: 'lin',
    unread_count: 2,
    recent: [
      { id: 1, content: 'Who has seeds?', created_at: '2026-09-19T10:00:00Z', by: 'ada' },
      { id: 2, content: 'See you Sunday', created_at: '2026-09-20T10:00:00Z', by: 'lin' },
    ],
    href: '#messages/app/garden',
    handle: null,
  },
  activity: { active_week: 4, shipped_month: 3 },
  approval: { policy: 'anyone', approvals_required: null, electorate: 12, required: 5 },
  ...over,
});

test('the bar reads Home, Discover, Messages, Communities, you — Messages in the middle', () => {
  const order = [...TABS.matchAll(/\{ key: '([a-z]+)' as const, label: '([A-Za-z]+)'/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(order.map((o) => o[0]), ['discover', 'messages', 'workshop', 'me'],
    'after Home, whose entry is written across lines');
  assert.deepEqual(order.find((o) => o[0] === 'workshop'), ['workshop', 'Communities'],
    'the key stays `workshop`; the word is Communities');
  assert.match(TABS, /key: 'workshop' as const, label: 'Communities', href: '#communities', Icon: UserGroupIcon/);
  // The channels' count rides the Communities tab, the conversations' the
  // Messages tab, and the Messages store writes both.
  assert.match(TABS, /key === 'workshop' \? \(\s*<TabBadge count=\{communities\} id="platform-tabs-badge-communities"/);
  assert.match(STORE, /messages: state\.conversations\s*\.filter\(\(item\) => item\.kind !== 'channel' && item\.unreadCount > 0\)\.length,/);
  assert.match(STORE, /communities: state\.conversations\.filter\(\(item\) => item\.kind === 'channel' && item\.unreadCount > 0\)\.length\s*\+ state\.discussions\.filter\(\(item\) => item\.section !== 'more' && \(item\.unreadCount \|\| 0\) > 0\)\.length,/);
});

test('a project page is its hub, with doors to the Workshop and Needs you; All items is under the Workshop', () => {
  const { pageParent, pageTitle } = loadTsx('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.deepEqual(['needs', 'workshop', 'all'].map(pageParent), ['status', 'status', 'workshop'],
    'a page goes back to where its door is');
  assert.deepEqual(['needs', 'workshop', 'all'].map(pageTitle), ['Needs you', 'Workshop', 'All items']);
  // No tab strip: the hub has no bar, and a page leads with its way back.
  assert.doesNotMatch(LANDER, /role="tablist" aria-label="Workshop sections"/, 'the hub and the Workshop are not two tabs any more');
  assert.match(LANDER, /const railNode = tab === 'status' \? null : \(/);
  assert.match(LANDER, /<PageBack\s+label=\{tab === 'all' \? 'Workshop' : \(app\.name \|\| community\?\.name \|\| slug\)\}\s+title=\{pageTitle\(tab\)\}\s+onBack=\{\(\) => openTab\(pageParent\(tab\)\)\}/);
  // The hub's order, as agreed: the hero (with who is here, #3268), what
  // landed since your last visit, your work, the channel, and the two doors.
  const hub = LANDER.slice(LANDER.indexOf("{tab === 'status' ? ("), LANDER.indexOf("{tab === 'workshop' ? ("));
  const order = ['<CommunityCard', '<SinceSummaryCard', '<YourWorkCard', '<ChannelCard', '<NeedsCard', '<WorkshopDoor'].map((s) => hub.indexOf(s));
  assert.ok(order.every((n) => n >= 0), 'all six on the hub');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'hero, summary, your work, channel, Needs you, Workshop');
  assert.match(hub, /\{owesVote\(v\.queue\)\s*\? <NeedsCard [^\n]*\n\s*: <NothingToVote queue=\{v\.queue\} onOpen=\{\(\) => openTab\('needs'\)\} \/>\}/,
    'Needs you only while a vote is owed; one quiet line in its place otherwise (#3408)');
  assert.match(hub, /\{v\.mine && v\.mine\.rows\.length \? \(\s*<YourWorkCard/, 'your work only when you have some');
  assert.doesNotMatch(hub, /data-ws-since=""/, 'the since list is the Workshop page\'s now');
  // The Workshop page: your work in full, the since list by week, All items
  // with See all, then the approval rules.
  const ws = LANDER.slice(LANDER.indexOf("{tab === 'workshop' ? ("));
  const w = (s) => ws.indexOf(s);
  assert.ok(w('data-ws-mine=""') < w('data-ws-since=""') && w('data-ws-since=""') < w('data-ws-dashboard=""')
    && w('data-ws-dashboard=""') < w('<ApprovalRules'));
  assert.match(ws, /<span className="dev-ws-head-title">All items<\/span>\s*<button[\s\S]*?data-ws-all-open=""\s*onClick=\{\(\) => openTab\('all'\)\}/);
  // `?ws=workshop` is a deep link like the others.
  assert.match(read('public/js/app-view.js'), /WORKSHOP_TABS: \['status', 'workshop', 'needs', 'all'\],/);
});

test('the hub\'s channel card shows the last messages, what is new, and the way in', () => {
  const { ChannelCard } = loadTsx(HUB);
  const html = renderToHtml(createElement(ChannelCard, { slug: 'garden', name: 'Garden', data: community() }));
  assert.match(html, /data-ws-channel=""/);
  assert.match(html, /data-ws-channel-unread="2"[^>]*>2 new</);
  assert.match(html, /<a href="#messages\/app\/garden" class="dev-ws-hub-open un-touch-target" data-ws-channel-open="">Open/);
  const lines = [...html.matchAll(/class="dev-ws-hub-msg-text">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(lines, ['Who has seeds?', 'See you Sunday'], 'oldest first, as a transcript reads');
  // The composer posts from here, to the room's own write route.
  assert.doesNotMatch(html, /data-ws-channel-compose/, 'no write route, no composer');
  const withPost = renderToHtml(createElement(ChannelCard, {
    slug: 'garden', name: 'Garden',
    data: community({ channel: { ...community().channel, post_url: '/api/apps/garden/messages' } }),
  }));
  assert.match(withPost, /<form class="dev-ws-hub-compose" data-ws-channel-compose=""><input type="text" class="dev-ws-hub-compose-input" data-ws-channel-input="" aria-label="Message Garden" placeholder="Message Garden…"/);
  assert.match(withPost, /<button type="submit" class="dev-ws-hub-compose-send" data-ws-channel-send="" aria-label="Send" disabled="">/,
    'nothing to send yet');
  assert.doesNotMatch(html, /data-ws-channel-archive/, 'no archive on an ordinary project');
  // Homeroom's: #general, and no link to its old discussion (#3406).
  const homeroom = renderToHtml(createElement(ChannelCard, {
    slug: 'homeroom',
    name: 'Homeroom',
    data: community({
      channel: { ...community().channel, href: '#messages/1', handle: 'general', archive_href: '#messages/app/homeroom' },
    }),
  }));
  assert.match(homeroom, /data-ws-channel-handle="general"/);
  assert.match(homeroom, /<span class="dev-ws-hub-handle">#general<\/span>/);
  assert.match(homeroom, /<a href="#messages\/1" class="dev-ws-hub-open/);
  assert.doesNotMatch(homeroom, /data-ws-channel-archive|dev-ws-hub-archive|Earlier project discussion/,
    'the channel card links to no archive');
  // Nothing to draw without a record, or for a viewer who may not talk here.
  assert.equal(renderToHtml(createElement(ChannelCard, { slug: 'garden', name: 'Garden', data: null })), '');
  assert.equal(renderToHtml(createElement(ChannelCard, { slug: 'garden', name: 'Garden', data: community({ channel: null }) })), '');
});

test('Needs you opens the queue and counts the votes owed', () => {
  const { NeedsCard } = loadTsx(HUB);
  const row = (key, title, who) => ({ t: 'card', key, card: { title: { text: title } }, who, kind: 'vote' });
  const needs = renderToHtml(createElement(NeedsCard, {
    queue: [row('a', 'Dark mode', 'ada'), row('b', 'Tags', 'lin'), row('c', 'Export', 'kai')],
    canPost: true,
    onOpen: () => {},
  }));
  assert.match(needs, /<span class="dev-ws-head-title">Needs you<\/span><span class="dev-ws-head-n">3 to vote<\/span>/);
  assert.match(needs, /<span class="dev-ws-hub-needs-title">Dark mode<\/span><span class="dev-ws-hub-needs-sub">from @ada · and 2 more<\/span>/);
  assert.doesNotMatch(needs, /Join to vote/);
  const outsider = renderToHtml(createElement(NeedsCard, { queue: [row('a', 'Dark mode', 'ada')], canPost: false, onOpen: () => {} }));
  assert.match(outsider, /Join to vote on these\./);
  assert.doesNotMatch(needs, /data-ws-hub-needs-none/, 'the door says nothing about an empty queue: it is not drawn then');
  // #3408: no vote owed, no card. One quiet line says so.
  const { NothingToVote, owesVote } = loadTsx(HUB);
  assert.equal(owesVote([]), false);
  const none = renderToHtml(createElement(NothingToVote, { queue: [], onOpen: () => {} }));
  assert.equal(none, '<p class="dev-ws-week-note" data-ws-hub-needs-none="">Nothing more to vote on.</p>');

  // Members & activity is the hero's since #3268: pinned in
  // tests/community-hub-details.test.js.
  assert.equal(loadTsx(HUB).MembersCard, undefined, 'no separate Members & activity card');
});

test('an open channel lights Communities and hangs off its hub; Messages lists people and agents', () => {
  assert.match(STORE, /export function channelHub\(\): string \| null \{\s*if \(state\.route\.appSlug\) return `#app\/\$\{encodeURIComponent\(state\.route\.appSlug\)\}\/workshop`;/);
  assert.match(STORE, /if \(!row \|\| row\.kind !== 'channel'\) return null;/, '#general is the channel among the conversations');
  assert.match(STORE, /navStore\.set\(\{ tab: hub \? 'workshop' : 'messages' \}\);/);
  assert.match(STORE, /app\.setBackIcon\?\.\('arrow', hub\);/);
  assert.match(STORE, /if \(!state\.route\.threadRootId && channelHub\(\)\) return false;/,
    'Back on a phone follows the arrow to the hub rather than to the list');
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /const channelOpen = !!snap\.route\.appSlug\s*\|\| \(!!snap\.route\.conversationId && snap\.active\?\.id === snap\.route\.conversationId && snap\.active\?\.kind === 'channel'\);/);
  const inbox = read('frontend/src/features/messages/inbox.ts');
  assert.match(inbox, /if \(item\.kind === 'channel'\) continue;/);
  assert.match(inbox, /return chats\.sort\(byClock\);/);
});

test('#general needs the Homeroom community to post in; Homeroom\'s old channel takes no post', () => {
  const route = read('src/routes/conversations.js');
  const send = route.slice(route.indexOf("router.post('/api/conversations/:id/messages'"));
  assert.match(send.slice(0, send.indexOf('conversations.sendMessage(')),
    /const join = await communities\.generalNeedsJoin\(pool, id, req\.user, config\?\.selfAppSlug\);\s*if \(join\) return res\.status\(403\)\.json\(join\);/,
    'refused before the message is written, with the join_required body the client turns into Join');
  const ws = read('src/services/ws.js');
  assert.match(ws, /if \(msg\.type === 'chat' && \(!msg\.thread \|\| msg\.thread\.type === 'message'\)\) \{[\s\S]*?communities\.channelArchived\(pool, client\.appId\)[\s\S]*?return \{ ok: false, code: 'channel_moved' \};/,
    'the main stream and its reply threads; a proposal\'s or a request\'s own thread stays open');
  assert.match(read('src/routes/chat.js'), /if \(result\?\.code === 'channel_moved'\) \{\s*return res\.status\(409\)\.json\(\{ error: communities\.CHANNEL_MOVED, code: 'channel_moved' \}\);/);
  const view = read('public/js/app-view.js');
  assert.match(view, /const archived = \(ctx && ctx\.slug\)\s*\? !!ctx\.archived\s*: !!\(AppView\.appData && AppView\.appData\.self_hosted\);/);
  assert.match(STORE, /archived: app\.self_hosted === true,\s*readOnly: app\.can_collaborate === false \|\| app\.self_hosted === true,/);
  const route2 = read('src/routes/apps.js');
  assert.match(route2, /if \(app\.slug === config\.selfAppSlug\) \{\s*const general = await communities\.generalChannelSummary\(pool, req\.user\?\.id\);/);
  assert.doesNotMatch(route2, /archive_href/, 'the hub names no archive (#3406)');
});
