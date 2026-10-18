'use strict';

// v3 (18 Oct 2026) — the desktop's sidebar of rows nests what the second
// column held. From 1024px the community whose page is up opens its places
// under its row, and the inbox opens its five latest conversations and All
// messages under Messages; the section column and Messages' list column step
// aside, All communities is one page, and Discover is a compass.
//
// What is pinned, each a way it could quietly go back:
//
//   1. WHICH ROWS: a visited community gets a row; which five conversations,
//      the open one kept; topics fold after two, the one you are on kept.
//   2. THE MARKUP: the conversations' element is always there, right after
//      Messages, empty in the prerender; the places are the column's own list.
//   3. THE MOTION: one clock and the content's own height, so the rows under
//      both parts move one way.
//   4. THE PAGES: the inbox draws one pane at a time from 1024px and no
//      crowding there; All communities is one page; the All row goes there.
//   5. THE LOOK: one indent a level, one unbroken line, the parent unfilled.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const block1024 = () => {
  const css = read('public/css/app.css');
  const at = css.indexOf('@media (min-width: 1024px) {\n  /* THE ONE NUMBER THE REST FOLLOWS.');
  assert.ok(at > 0, 'the sidebar\'s block');
  return css.slice(at, css.indexOf('\n}\n', at));
};

test('which rows: a community you are visiting has one for as long as you are on its page', () => {
  const { railRows, RAIL_TOPICS } = loadTsx('frontend/src/features/nav/rail-communities.tsx');
  assert.equal(RAIL_TOPICS, 2);
  assert.deepEqual(railRows(['a', 'b'], null), ['a', 'b']);
  assert.deepEqual(railRows(['a', 'b'], 'b'), ['a', 'b'], 'one of the five keeps its row');
  assert.deepEqual(railRows(['a', 'b'], 'x'), ['x', 'a', 'b'], 'a visited one comes first');
});

test('which conversations: the bot, then the four most recent of either section, the open one kept', () => {
  const { railConversations, RAIL_CONVERSATIONS } = loadTsx('frontend/src/features/messages/rail-inbox.ts');
  assert.equal(RAIL_CONVERSATIONS, 5);
  const at = (h) => new Date(Date.UTC(2026, 9, 18, h)).toISOString();
  // The inbox's merge: agents first (the bot pinned), then people, each newest first.
  const inbox = [
    { key: 'person:bot', section: 'agents', at: at(1), pinned: true },
    { key: 'mayor:1', section: 'agents', at: at(9) },
    { key: 'mayor:2', section: 'agents', at: at(3) },
    { key: 'person:7', section: 'people', at: at(10) },
    { key: 'person:8', section: 'people', at: at(8) },
    { key: 'person:9', section: 'people', at: at(7) },
    { key: 'person:4', section: 'people', at: null },
  ];
  const keys = (rows) => rows.map((row) => row.key);
  assert.deepEqual(keys(railConversations(inbox, null)),
    ['person:bot', 'mayor:1', 'person:7', 'person:8', 'person:9'],
    'pinned first, then by clock across both, drawn back in the inbox\'s order');
  assert.deepEqual(keys(railConversations(inbox, 'mayor:2')),
    ['person:bot', 'mayor:1', 'mayor:2', 'person:7', 'person:8', 'person:9'],
    'the open one is a sixth row, in its own place');
  assert.deepEqual(keys(railConversations(inbox, 'person:7')), keys(railConversations(inbox, null)));
  assert.deepEqual(railConversations([], null), []);
});

test('the places: the column\'s own list, topics after two behind "Show N more", the one you are on kept', () => {
  const places = {
    channels: [
      { kind: 'general', handle: 'general', state: 'live', unread: 0 },
      ...['onboarding', 'homeroom-bot', 'design', 'bugs'].map((handle, i) => ({ kind: 'topic', handle, name: handle, icon: '', state: 'live', unread: 0, id: i + 1 })),
    ],
  };
  const props = (place) => ({ slug: 'notes', name: 'Notes', place, owed: 2, places, fold: 2, onPlace: () => {} });
  const folded = renderComponent('frontend/src/features/dev-board/workshop/project-places.tsx', 'ProjectPlaces', props('status'));
  assert.match(folded, /data-place="c:onboarding"[\s\S]*data-place="c:homeroom-bot"/);
  assert.doesNotMatch(folded, /data-place="c:design"|data-place="c:bugs"/);
  assert.match(folded, /<button type="button" class="dev-ws-place dev-ws-places-more" data-places-more="">/);
  assert.equal(message('project:places.list.showMore', { count: 2 }), 'Show 2 more');
  assert.ok(folded.includes('Show 2 more'));
  const onBugs = renderComponent('frontend/src/features/dev-board/workshop/project-places.tsx', 'ProjectPlaces', props('c:bugs'));
  assert.match(onBugs, /data-place="c:bugs" aria-current="page"/, 'the topic you are on is drawn');
  assert.ok(onBugs.includes('Show 1 more'));
  // Before the page has said where it is, nothing is lit.
  const unknown = renderComponent('frontend/src/features/dev-board/workshop/project-places.tsx', 'ProjectPlaces', props(null));
  assert.doesNotMatch(unknown, /aria-current/);
  // Without `fold`, every topic, as the column and the tray draw them.
  const all = renderComponent('frontend/src/features/dev-board/workshop/project-places.tsx', 'ProjectPlaces', { ...props('status'), fold: undefined });
  assert.match(all, /data-place="c:bugs"/);
  assert.doesNotMatch(all, /data-places-more/);
  // The sidebar's part is that list, under the community's own row.
  const rail = read('frontend/src/features/nav/rail-communities.tsx');
  assert.match(rail, /<ProjectPlaces[\s\S]*?fold=\{RAIL_TOPICS\}\s*onPlace=\{\(key\) => \{ openPlace\(slug, key\); \}\}/);
  assert.match(rail, /const nested = sidebarRows && onPage \? onPage : null;/, 'it opens with the page');
  assert.match(rail, /<NestSlot open=\{open\} className="platform-rail-nest" rows="\.dev-ws-place, \.dev-ws-places-head">\s*<RailPlaces slug=\{slug\} \/>/);
  assert.match(rail, /const votes = c && !c\.unchosen && !open \? Number\(c\.needs\) \|\| 0 : 0;/, 'open, its votes are Needs you\'s count');
});

test('the markup: the conversations follow Messages, empty in the prerender, and nothing is nested there', () => {
  const html = renderComponent('frontend/src/features/nav/tab-bar.tsx', 'PlatformTabs', {});
  assert.match(html, /<span class="platform-tab-label">Messages<\/span><\/a><div id="platform-rail-conversations" class="platform-rail-conversations"><\/div><div id="platform-rail-communities"/);
  assert.doesNotMatch(html, /platform-rail-nest/);
  const src = read('frontend/src/features/nav/rail-conversations.tsx');
  assert.match(src, /const open = sidebarRows && screen === 'messages-screen' && tab === 'messages';/);
  assert.match(src, /href="#messages"\s*data-rail-all-messages=""\s*aria-current=\{page \? 'page' : undefined\}/);
  assert.equal(message('core:rail.allMessages'), 'All messages');
  // The inbox publishes the rows from the whole merge, not the search's answer.
  const inbox = read('frontend/src/features/messages/index.tsx');
  assert.match(inbox, /const railOpenKey = inbox\.find\(isOpen\)\?\.key \|\| null;/);
  assert.match(inbox, /const rows = railConversations\(inbox, railOpenKey\)/);
});

test('the motion: one clock for both parts, on the content\'s own height', () => {
  const src = read('frontend/src/features/nav/rail-nest.tsx');
  const { NEST_MS, NEST_EASE } = loadTsx('frontend/src/features/nav/rail-nest.tsx');
  assert.equal(NEST_MS, 260);
  assert.equal(NEST_EASE, 'cubic-bezier(.3,.7,.2,1)');
  assert.match(src, /\[\{ gridTemplateRows: `minmax\(0px, \$\{from\}fr\)` \}, \{ gridTemplateRows: open \? 'minmax\(0px, 1fr\)' : 'minmax\(0px, 0fr\)' \}\]/);
  assert.match(src, /if \(start !== null\) motion\.startTime = start;/, 'a part that heard late joins the clock already running');
  assert.match(src, /reducedMotion\(\) \|\| typeof el\.animate !== 'function'/);
  const css = block1024();
  assert.match(css, /\.platform-rail-nest \{\n    flex: none;\n    display: grid;\n    grid-template-rows: minmax\(0, 1fr\);\n    overflow: hidden;\n  \}/);
  assert.match(css, /\.platform-rail-communities > \.platform-rail-nest \{\n    margin-top: -1px;\n  \}/, 'the section\'s gap does not arrive with it');
});

test('the pages: one pane at a time in the inbox, All communities one page, and the All row goes there', () => {
  const inbox = read('frontend/src/features/messages/index.tsx');
  assert.match(inbox, /const railClass = sidebarRows && !drawer\.on \? \(discussionOpen \? ' messages-list-in-rail' : ' messages-list-page'\) : '';/);
  const store = read('frontend/src/features/messages/store.ts');
  assert.match(store, /const crowded = !isMobile\(\) && !sidebarRowsUp\(\) && width < LIST_BESIDE_MIN_WIDTH;/);
  const css = block1024();
  assert.match(css, /\.messages-layout\.messages-list-in-rail > \.messages-list-pane \{\n    display: none;\n  \}/);
  assert.match(css, /\.messages-layout\.messages-list-page > \.messages-thread-pane \{\n    display: none;\n  \}/);
  assert.match(css, /\.messages-layout\.messages-list-page > \.messages-list-pane \{\n    flex: 1 1 auto;\n    width: auto;\n    max-width: 720px;/);
  // Beside the strip the list is still its column, with its compact rows.
  const all = read('public/css/app.css');
  assert.match(all, /  @media \(max-width: 1023px\) \{\n    \/\* ── MESSAGES' COLUMN IS ITS OWN LIST \(#4417\)/);
  assert.doesNotMatch(css, /data-workshop-panes/, 'no column and page on All communities');
  assert.match(css, /> :is\(#workshop-list, \[data-workshop-needs-door\], div:has\(> \[data-workshop-start\]\)\) \{\n    display: none;/, 'a search\'s answer is the whole list');
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.match(bar, /if \(key === 'workshop' && sidebarRows\) \{\s*event\.preventDefault\(\);\s*if \(screen === 'workshop-screen'\) pressLitTab\(screen\);\s*else goToCommunity\(null\);/);
  // The places button has nothing to open beside the docked sidebar.
  assert.match(css, /body:has\(#platform-tabs:not\(\.hidden\):not\(\.platform-tabs-peek\):not\(\.platform-tabs-folded\)\) \.dev-ws-places-btn \{\n    display: none;\n  \}/);
});

test('the look: one indent a level, one unbroken line, the parent unfilled; Discover a compass', () => {
  const css = block1024();
  assert.match(css, /\.platform-rail-nest-in::before \{\n    content: "";\n    position: absolute;\n    top: 2px;\n    bottom: 6px;\n    left: 18px;\n    width: 1px;/, 'one line, under the parent\'s tile, past the sub-headers');
  assert.match(css, /\.platform-rail-nest :is\(\.dev-ws-place, \.platform-rail-sub\) \{[^}]*margin-left: 24px;[^}]*\}/);
  assert.match(css, /\.platform-rail-nest :is\(\.dev-ws-places-group \.dev-ws-place, \.platform-rail-group\[data-rail-headed\] \.platform-rail-sub\) \{\n    margin-left: 36px;\n  \}/, 'a headed group is a step in');
  assert.match(css, /padding: 8px 8px 3px 30px;[^}]*text-transform: none;/, 'sub-headers where the rows above start, in sentence case');
  assert.match(css, /\.platform-rail-community\[data-rail-open\]\[aria-current="page"\],\n  \.platform-tabs:has\(#platform-rail-conversations > \[data-nest="open"\]\) #platform-tab-messages\[aria-current="page"\] \{\n    background: transparent;/);
  assert.match(css, /--platform-rail-full: 212px;/, 'the deeper rows need 212px');
  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.match(bar, /\{ key: 'discover' as const, label: 'core:tabs\.discover', href: '#apps', Icon: CompassIcon \}/);
  assert.match(read('frontend/@/components/ui/icons.tsx'), /export const CompassIcon = stroked\('CompassIcon', \[/);
});
