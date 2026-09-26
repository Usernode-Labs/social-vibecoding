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
  audience_label: 'Community',
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

test('the bar reads Home, Discover, Communities, Messages, you — Communities in the middle', () => {
  const order = [...TABS.matchAll(/\{ key: '([a-z]+)' as const, label: '([A-Za-z]+)'/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(order.map((o) => o[0]), ['discover', 'workshop', 'messages', 'me'],
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

test('a project page is its hub and its Workshop; Needs you and All items are pages under them', () => {
  const { hubLabel, litTab } = loadTsx('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.equal(hubLabel('open'), 'Community hub');
  assert.equal(hubLabel('invited'), 'Group hub');
  assert.equal(hubLabel('solo'), 'Hub');
  assert.equal(hubLabel(undefined), 'Hub', 'plain Hub until the community record has said');
  assert.deepEqual(['status', 'needs', 'workshop', 'all'].map(litTab), ['status', 'status', 'workshop', 'workshop'],
    'a page lights the tab it hangs off');
  assert.match(LANDER, /const TABS: \{ key: TabKey; label: string; Icon: typeof NewspaperIcon \}\[\] = \[\s*\{ key: 'status', label: 'Hub', Icon: UserGroupIcon \},\s*\{ key: 'workshop', label: 'Workshop', Icon: BoardIcon \},\s*\];/);
  // The hub's order, as agreed: hero, the channel, Needs you, members and
  // activity, and Since your last visit at the foot.
  const hub = LANDER.slice(LANDER.indexOf("{tab === 'status' ? ("));
  const at = (s) => hub.indexOf(s);
  assert.ok(at('<CommunityCard') < at('<ChannelCard') && at('<ChannelCard') < at('<NeedsCard')
    && at('<NeedsCard') < at('<MembersCard'), 'hero, channel, Needs you, members');
  assert.ok(LANDER.lastIndexOf('data-ws-since=""') > LANDER.indexOf('<MembersCard'), 'Since your last visit last');
  // The Workshop tab: your own work, then All items' numbers with See all.
  const ws = LANDER.slice(LANDER.indexOf("{tab === 'workshop' ? ("));
  assert.ok(ws.indexOf('data-ws-mine=""') < ws.indexOf('data-ws-dashboard=""'));
  assert.match(ws, /<span className="dev-ws-head-title">All items<\/span>\s*<button[\s\S]*?data-ws-all-open=""\s*onClick=\{\(\) => openTab\('all'\)\}/);
  // Each page has its way back to the tab it hangs off.
  assert.match(LANDER, /\{tab === 'needs' \|\| tab === 'all' \? \(\s*<PageBack\s+label=\{tab === 'needs' \? hubLabel\(community\?\.audience\) : 'Workshop'\}\s+onBack=\{\(\) => openTab\(tab === 'needs' \? 'status' : 'workshop'\)\}/);
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
  // Homeroom's: #general, with its old discussion one tap away, read-only.
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
  assert.match(homeroom, /<a href="#messages\/app\/homeroom" class="dev-ws-hub-archive" data-ws-channel-archive="">Earlier project discussion, read-only/);
  // Nothing to draw without a record, or for a viewer who may not talk here.
  assert.equal(renderToHtml(createElement(ChannelCard, { slug: 'garden', name: 'Garden', data: null })), '');
  assert.equal(renderToHtml(createElement(ChannelCard, { slug: 'garden', name: 'Garden', data: community({ channel: null }) })), '');
});

test('Needs you opens the queue; members and activity count who is here', () => {
  const { NeedsCard, MembersCard } = loadTsx(HUB);
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
  const none = renderToHtml(createElement(NeedsCard, { queue: [], canPost: true, onOpen: () => {} }));
  assert.match(none, /data-ws-hub-needs-open="" disabled=""/);
  assert.match(none, /Nothing is waiting on you\./);

  const members = renderToHtml(createElement(MembersCard, { data: community({ member_count: 12 }) }));
  assert.match(members, /Members &amp; activity/);
  const cells = [...members.matchAll(/data-ws-members-cell="([a-z]+)"><b>(\d+)<\/b>/g)].map((m) => [m[1], Number(m[2])]);
  assert.deepEqual(cells, [['members', 12], ['active', 4], ['shipped', 3]]);
  assert.match(members, /class="dev-ws-hub-more">\+10</, 'two faces drawn, ten more counted');
  assert.equal(renderToHtml(createElement(MembersCard, { data: community({ audience: 'solo' }) })), '',
    'a project that is just yours has nobody else to count');
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
  assert.match(route2, /archive_href: `#messages\/app\/\$\{encodeURIComponent\(app\.slug\)\}`,/);
});
