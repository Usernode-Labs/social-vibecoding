'use strict';

// #5304: A TOPIC OPENS ON ITS REQUESTS, and the plan reader goes with the
// place.
//
//   * a live topic's channel is three tabs on the shell's Tabs strip:
//     Requests (first, the default), Chat, and Numbers when it names
//     figures; a retired topic has its chat alone;
//   * the Requests tab draws the topic's lanes from the Workshop's publish
//     (`topics`, the whole grouping, not All items' search), the way to the
//     Board under them, and says so when nothing is filed;
//   * the room mounts only while Chat is up, and a door into it turns to
//     Chat first;
//   * a move to another place closes the group chat's plan reader
//     (GroupChat._closeSpecPanel); the page arriving closes nothing.
//
// Run with: node --test tests/topic-channel-tabs.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const DIR = 'frontend/src/features/dev-board/workshop';
const PD_PATH = `${DIR}/project-discussion.tsx`;

test('a live topic\'s tabs are Requests, Chat and Numbers when it names figures; a retired one has its chat alone', () => {
  const { topicTabs } = loadTsx(PD_PATH, { stubs: { '../../messages': { EmbeddedConversation: () => null, AppReplyThreadPane: () => null } } });
  assert.deepEqual([...topicTabs({ state: 'live', figures: ['infra.apps-up'] })], ['requests', 'chat', 'numbers']);
  assert.deepEqual([...topicTabs({ state: 'live', figures: [] })], ['requests', 'chat']);
  assert.deepEqual([...topicTabs({ state: 'live' })], ['requests', 'chat']);
  assert.deepEqual([...topicTabs({ state: 'archived', figures: ['infra.apps-up'] })], ['chat']);
  assert.deepEqual([...topicTabs({ state: 'merged' })], ['chat']);
  assert.equal(message('project:places.topicTabs.requests'), 'Requests');
  assert.equal(message('project:places.topicTabs.chat'), 'Chat');
  assert.equal(message('project:places.topicTabs.numbers'), 'Numbers');
});

test('the channel draws the strip with the shell\'s Tabs, opens on its first tab, and mounts the room only on Chat', () => {
  const src = read(PD_PATH);
  assert.match(src, /from '@\/components\/ui\/tabs';/);
  assert.match(src, /const \[picked, setView\] = useState<TopicTab>\(tabs\[0\]\);[\s\S]*?const view = tabs\.includes\(picked\) \? picked : tabs\[0\];/);
  assert.match(src, /<TabsList className=\{`\$\{SECTION_TABS_LIST_BASE\} dev-ws-topic-tabs`\} data-topic-tabs=\{topic\.handle\}>/);
  assert.match(src, /data-topic-tab=\{key\}/);
  assert.match(src, /\{view === 'requests' \? <TopicRequests slug=\{slug\} topic=\{topic\} onAll=\{openRequests\} \/> : null\}/);
  // The room: mounted while Chat is up, its host kept (hidden) otherwise.
  assert.match(src, /if \(!el \|\| !onShow \|\| !chatUp\) return undefined;/);
  assert.match(src, /data-topic-channel=\{topic\.id\} hidden=\{!chatUp\} \/>/);
  assert.match(read('public/css/app.css'), /\.dev-ws-topic-host\[hidden\] \{ display: none; \}/);
  // A door that names a message or a thread turns to the chat first.
  assert.match(src, /if \(target\.focusMessageId \|\| target\.threadRootId\) setView\('chat'\);/);
  // The line above the tabs no longer carries the requests link.
  assert.doesNotMatch(src, /onRequests=\{openRequests\}/);
});

// ── The Requests tab, rendered ───────────────────────────────────────────

const card = (key, title) => ({
  t: 'card', key, card: { key, title }, brief: { title },
});

const theme = (over = {}) => ({
  id: 'category-onboarding',
  name: 'Onboarding',
  description: '',
  saying: null,
  icon: '',
  people: [],
  lastActive: 0,
  counts: { open: 2, underway: 1, review: 0, shipped: 0, fresh: 0 },
  lanes: [
    { key: 'review', title: 'Waiting on votes', rows: [], more: 0 },
    { key: 'underway', title: 'Being built', rows: [card('issue:7', 'Sign in with a phone')], more: 0 },
    { key: 'open', title: 'Open', rows: [card('issue:8', 'Welcome screen'), card('issue:9', 'Invite copy')], more: 3 },
    { key: 'shipped', title: 'Shipped this week', rows: [], more: 0 },
  ],
  topic: { key: 'onboarding', handle: 'onboarding' },
  ...over,
});

function requestsTab(view, topic = { key: 'onboarding', handle: 'onboarding', requests: 6 }) {
  const store = { get: () => view, subscribe: () => () => {} };
  const { TopicRequests, topicTheme } = loadTsx(`${DIR}/topic-requests.tsx`, {
    stubs: {
      '../card/cards-store': { devWorkshopStore: store },
      './work-row': {
        WorkList: ({ rows }) => createElement('div', { 'data-rows': rows.map((r) => r.key).join(',') }),
      },
    },
  });
  return { html: renderToHtml(createElement(TopicRequests, { slug: 'homeroom', topic, onAll: () => {} })), topicTheme };
}

test('the Requests tab: the topic\'s lanes with rows, its overflow, and the Board under them', () => {
  const { html } = requestsTab({ loading: false, themes: [], topics: [theme()] });
  assert.match(html, /^<div class="dev-ws-topic-requests" data-ws-topic-requests-list="onboarding"><div class="dev-ws-topic-requests-card">/);
  assert.deepEqual([...html.matchAll(/data-ws-lane="([^"]+)"/g)].map((m) => m[1]), ['underway', 'open'], 'empty lanes are not drawn');
  assert.match(html, /data-rows="issue:8,issue:9"/);
  assert.match(html, />\+3 more in this lane</);
  assert.match(html, /data-ws-topic-requests="onboarding">Open on Board ›</);
});

test('the Requests tab reads the whole grouping, not All items\' search', () => {
  const { topicTheme } = requestsTab({ loading: false, themes: [], topics: [] });
  const whole = theme();
  const searched = theme({ lanes: [] });
  assert.equal(topicTheme({ themes: [searched], topics: [whole] }, 'onboarding'), whole);
  assert.equal(topicTheme({ themes: [whole] }, 'onboarding'), whole, 'an older publish without `topics`');
  assert.equal(topicTheme({ themes: [whole], topics: [] }, 'other'), null);
});

test('a topic with nothing filed says so; the Board stays offered while its record counts requests', () => {
  const none = requestsTab({ loading: false, themes: [], topics: [] }, { key: 'onboarding', handle: 'onboarding', requests: 0 }).html;
  assert.match(none, /data-ws-topic-requests-none="">No requests in this topic yet\.</);
  assert.doesNotMatch(none, /Open on Board/, 'a zero is not a door');
  const counted = requestsTab({ loading: false, themes: [], topics: [] }, { key: 'onboarding', handle: 'onboarding', requests: 4 }).html;
  assert.match(counted, /Open on Board ›/);
  const loading = requestsTab({ loading: true, themes: [], topics: [] }).html;
  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /role="status">Loading this topic&#x27;s requests</);
});

// ── The plan reader goes with the place ─────────────────────────────────

test('a move to another place closes the plan reader; the page arriving closes nothing', () => {
  const store = loadTsx(`${DIR}/place-store.ts`, {
    stubs: {
      './community-card': {
        cachedCommunity: () => null,
        communityInflight: () => false,
        reloadCommunity: async () => {},
      },
    },
  });
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const was = globalThis.window;
  let closed = 0;
  globalThis.window = { GroupChat: { _closeSpecPanel: () => { closed += 1; } } };
  try {
    store.publishPlace('homeroom', 'discussion', 0);
    assert.equal(closed, 0, 'the page arriving (a reload restores the reader)');
    store.publishPlace('homeroom', 'discussion', 2, 1);
    assert.equal(closed, 0, 'the same place, its counts moved');
    store.publishPlace('homeroom', 'c:onboarding', 2);
    assert.equal(closed, 1, 'another place');
    store.publishPlace('other', 'c:onboarding', 0);
    assert.equal(closed, 2, 'another project');
    store.clearPlace('other');
    store.publishPlace('homeroom', 'status', 0);
    assert.equal(closed, 2, 'after the page went');
  } finally {
    if (had) globalThis.window = was; else delete globalThis.window;
  }
});
