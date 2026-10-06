'use strict';

// The notifications sheet's filter chips: Everything / Mentions / Votes /
// Builds, one row of narrowing under the tab strip, on the Unread and All
// tabs.
//
// The request: everything is in one list, votes, merges and mentions all
// mixed, and a person's own things are hard to find in it. The sheet already
// narrows by tab (Unread / Messages / All) and by section (Today / Earlier),
// but Unread and All are still single streams of every kind. The chips add
// the missing question — what KIND of thing is this — without a new screen,
// a new fetch or a server change: the categories are decided on the client,
// in CATEGORY_FOR_KIND in ./notifications.js, mirroring the coarser grouping
// the server's KIND_TO_CATEGORY (services/notification-preferences.js) makes
// for delivery preferences. The category rides the row descriptor next to
// `conversation` and `agent`, for the same reason they do: the chips must
// never re-derive the set from `kind` and drift from the rest of the module.
//
// The sheet's markup is RENDERED through tests/lib/render-tsx.js — where the
// chips sit relative to the tab strip, which of them exist for a given list,
// and what survives a filter are structure a regex over JSX cannot see. A
// static render cannot click, so the "selected" renders force the state a
// tap would set by stubbing React's useState to return it: everything else
// on the page, the filtering logic included, is the code that ships. The row
// descriptors themselves are built by the REAL rowView/screenViews, evaluated
// out of the shipped notifications.js the way
// tests/notifications-swipe-clear.test.js does it.
//
// Run with: node --test tests/notifications-filter-chips.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const SHEET_PATH = 'frontend/src/features/notifications/notifications-sheet.tsx';
const SHEET_SRC = read(SHEET_PATH);
const FE_SRC = read('frontend/src/features/notifications/notifications.js');
// notifications.js has one bundle import (`agoStamp`, lib/timestamp.ts). The
// vm evaluates the shipped source raw, so the import line is dropped and the
// real helper is put in the sandbox under its name.
const CONTROLLER_SRC = FE_SRC.replace(/^import \{ agoStamp \}.*$/m, '');

const { agoStamp } = loadTsx('frontend/src/lib/timestamp.ts');
const { createStore } = loadTsx('frontend/src/lib/plain-store.js');

const MIN = 60 * 1000;
const at = (minutesAgo) => new Date(Date.now() - minutesAgo * MIN).toISOString();
const DAY = 24 * 60;

// ── the real row descriptors, from the shipped module ───────────────────

function screenViews(items) {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Promise,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { search: '', hash: '' },
    document: {
      title: '',
      getElementById: () => null,
      addEventListener: () => {},
      querySelectorAll: () => ({ forEach: () => {} }),
      body: { appendChild: () => {} },
    },
    PlatformUI: { isTouch: () => false },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.agoStamp = agoStamp;
  vm.createContext(sandbox);
  vm.runInContext(CONTROLLER_SRC, sandbox);
  const views = sandbox.window.Notifications._screenViews(items);
  // Across the vm realm into this one, so the assertions below compare
  // values, not prototypes.
  return JSON.parse(JSON.stringify(views));
}

// A feed with something in every bucket, newest first — the order the server
// serves and the sheet keeps.
//
//   Mentions: a collapsed run of 2 messages (ids 101+102), a kudos (103),
//             and an older mention (109) that lands in Earlier.
//   Votes:    a new proposal (104) and the daily digest (107).
//   Builds:   a finished session (105) and a stalled proposal (108, read in
//             one variant so the Unread tab is smaller than All).
//   Unmapped: a platform-limit row (106) — a kind CATEGORY_FOR_KIND does not
//             name, which shows only under Everything.
//
// Nine notifications, eight rows: the run of two collapses into one.
const feed = ({ allRead = false } = {}) => [
  { id: 101, kind: 'conversation_message', conversationId: 7, sourceUsername: 'ada', createdAt: at(2), readAt: null },
  { id: 102, kind: 'conversation_message', conversationId: 7, sourceUsername: 'ada', createdAt: at(3), readAt: null },
  { id: 103, kind: 'kudos', appId: 3, createdAt: at(5), readAt: null },
  { id: 104, kind: 'pr_proposed', appId: 3, sourceUsername: 'evan', prTitle: 'Fix the header spacing', createdAt: at(8), readAt: null },
  { id: 105, kind: 'session_done', appId: 3, sessionTitle: 'Notes app', createdAt: at(20), readAt: null },
  { id: 106, kind: 'platform_limit', detail: 'apps_warn:40:50', createdAt: at(40), readAt: null },
  { id: 107, kind: 'vote_digest', detail: '2', createdAt: at(50), readAt: null },
  { id: 108, kind: 'stale_pr', appId: 3, prTitle: 'Fix the header spacing', createdAt: at(2 * DAY * 60), readAt: allRead ? at(DAY * 60) : null },
  { id: 109, kind: 'conversation_mention', conversationId: 8, sourceUsername: 'grace', createdAt: at(3 * DAY * 60), readAt: null },
];

// Only the mapped buckets the request names, plus the unmapped kind: no
// votes, no builds — the seed for "a category with nothing in it shows no
// chip".
const sparseFeed = () => feed().filter(
  (n) => !['pr_proposed', 'vote_digest', 'session_done', 'stale_pr'].includes(n.kind),
);

// ── rendering ───────────────────────────────────────────────────────────

function renderSheet(list, { tab = 'unread', filter = 'everything' } = {}) {
  const notificationsStore = createStore({
    saved: [], invites: [], screenList: list, touch: false, loadingMore: false,
    screenCanLoadMore: false, messagesCanLoadMore: false, loadingOlderMessages: false,
  });
  const notificationsSheetStore = createStore({ open: true, adopted: false });
  // The sheet's two useState calls seed their state from constants — the tab
  // from 'unread', the filter from 'everything' — so this build can force
  // either to the value a tap would set: the tab's useState is the one called
  // with 'unread', the filter's the one called with 'everything'. Every other
  // hook, everywhere in the bundle, is real React. A static render makes one
  // pass, so the bypassed hook slots cannot misalign anything.
  const React = require(require.resolve('react', { paths: [path.join(ROOT, 'frontend')] }));
  const stubbed = new Proxy(React, {
    get(target, prop) {
      if (prop === 'useState') {
        return (initial) => {
          if (initial === 'unread') return [tab, () => {}];
          if (initial === 'everything') return [filter, () => {}];
          return target.useState(initial);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const mod = loadTsx(SHEET_PATH, {
    stubs: {
      './notifications-store.js': { notificationsStore },
      './notifications-sheet-store.js': { notificationsSheetStore },
      react: stubbed,
    },
  });
  return renderToHtml(createElement(mod.NotificationsSheetView));
}

// The default feed's views, built once. Everything unread, so the Unread tab
// holds the whole feed.
const views = () => screenViews(feed());

// ── where the rail sits ─────────────────────────────────────────────────

test('the rail is a sibling AFTER the tab strip, with the three tabs in their pinned order', () => {
  const html = renderSheet(views());
  assert.match(html, /id="notifications-screen-tabs"/, 'the tab strip renders');
  const tabs = html.slice(html.indexOf('id="notifications-screen-tabs"'));
  assert.ok(
    tabs.indexOf('id="notifications-tab-unread"') < tabs.indexOf('id="notifications-tab-messages"')
    && tabs.indexOf('id="notifications-tab-messages"') < tabs.indexOf('id="notifications-tab-all"'),
    'Unread, then Messages, then All, as the declared check pins',
  );
  // Sibling, not child: the strip's own div closes before the rail opens.
  assert.match(html, /id="notifications-screen-tabs"[^]*?<\/div><div id="notifications-filter-rail" role="group" aria-label="Notification kinds"/,
    'the rail opens right after the tab strip closes');
  // The tab strip's own structure is what dapp.json selects on.
  assert.match(html, /id="notifications-tab-unread"[^]*?id="notifications-tab-messages"[^]*?id="notifications-tab-all"/);
});

test('the rail shows on Unread and on All, and never on Messages', () => {
  assert.match(renderSheet(views()), /id="notifications-filter-rail"/, 'Unread carries the rail');
  assert.match(renderSheet(views(), { tab: 'all' }), /id="notifications-filter-rail"/, 'All carries the rail');
  assert.doesNotMatch(renderSheet(views(), { tab: 'messages' }), /notifications-filter-rail/,
    'Messages lists one kind already; a filter over it would say nothing');
});

test('an empty tab shows no rail', () => {
  const onlyRead = screenViews(feed({ allRead: true })).map((view) => ({ ...view, unread: false }));
  const html = renderSheet(onlyRead);
  assert.doesNotMatch(html, /notifications-filter-rail/, 'nothing on Unread to narrow');
  assert.match(html, /You’re all caught up\./, 'the empty state still says so');
  assert.match(renderSheet(onlyRead, { tab: 'all' }), /id="notifications-filter-rail"/,
    'and All, which holds the row, still offers the chips');
});

// ── the chips and their counts ──────────────────────────────────────────

test('each chip carries a notification count, and a collapsed run counts as its run', () => {
  const html = renderSheet(views());
  // Mentions: 2 (the run) + kudos + the older mention = 4. Votes: 2. Builds:
  // 2. Everything: all 9. Rows would have said 1 where the run says 2.
  assert.match(html, />Everything \(9\)</);
  assert.match(html, />Mentions \(4\)</);
  assert.match(html, />Votes \(2\)</);
  assert.match(html, />Builds \(2\)</);
});

test('a category with nothing in it shows no chip at all', () => {
  const html = renderSheet(screenViews(sparseFeed()));
  assert.match(html, />Mentions \(\d+\)</, 'the non-empty category is offered');
  assert.doesNotMatch(html, /notifications-filter-votes/, 'no Votes chip over nothing');
  assert.doesNotMatch(html, />Votes \(/, 'and no zero written on it');
  assert.doesNotMatch(html, /notifications-filter-builds/, 'no Builds chip over nothing');
  assert.match(html, />Everything \(/, 'Everything always shows while the rail does');
});

test('the chips are buttons with a pressed state, Everything pressed by default', () => {
  const html = renderSheet(views());
  assert.match(html, /<button id="notifications-filter-everything" type="button" aria-pressed="true"/);
  assert.match(html, /<button id="notifications-filter-mentions" type="button" aria-pressed="false"/);
});

// ── the narrowing ───────────────────────────────────────────────────────

test('selecting Mentions leaves only its rows, with Today and Earlier and their order intact', () => {
  const html = renderSheet(views(), { filter: 'mentions' });
  for (const id of [101, 103, 109]) {
    assert.match(html, new RegExp(`data-notif-id="${id}"`), `mention row ${id} survives`);
  }
  for (const id of [104, 105, 106, 107, 108]) {
    assert.doesNotMatch(html, new RegExp(`data-notif-id="${id}"`), `row ${id} is not a mention`);
  }
  // The collapsed run's row is the one row for ids 101 and 102 both.
  assert.doesNotMatch(html, /data-notif-id="102"/, 'the run renders as its newest member');
  assert.match(html, /aria-label="2 notifications"/, 'and still says it stands for two');
  // Both sections survive the filter, newest first.
  const today = html.indexOf('Today');
  const earlier = html.indexOf('Earlier');
  assert.ok(today > -1 && earlier > today, 'Today leads, Earlier follows');
  assert.ok(html.indexOf('data-notif-id="101"') < html.indexOf('data-notif-id="109"'),
    'and the rows keep their feed order across the boundary');
});

test('a kind the map does not name shows only under Everything', () => {
  // The platform-limit row (106) is unmapped: there under Everything, gone
  // under each of the three.
  assert.match(renderSheet(views()), /data-notif-id="106"/);
  for (const filter of ['mentions', 'votes', 'builds']) {
    assert.doesNotMatch(renderSheet(views(), { filter }), /data-notif-id="106"/,
      `${filter} hides what it does not name`);
  }
});

// ── what a filter must NOT hide ─────────────────────────────────────────

test('a filter that hides rows does not hide the way back to them', () => {
  // Everything unread, so the Unread tab already holds all the feed: the
  // footer compares the tab's UNFILTERED list, so Mentions hiding rows must
  // not conjure a "See older" that leads nowhere.
  const html = renderSheet(views(), { filter: 'mentions' });
  assert.doesNotMatch(html, /notifications-see-older/,
    'no older rows exist beyond the tab; a filter must not invent the link');
  // With a read row in the feed the link is real — and it stays while the
  // filter hides the rows it points past.
  const withRead = screenViews(feed({ allRead: true }));
  const filtered = renderSheet(withRead, { filter: 'mentions' });
  assert.match(filtered, /notifications-see-older/, 'the way to All survives the filter');
  assert.doesNotMatch(filtered, /data-notif-id="105"/, 'the filter is still doing its work');
});

// ── the reset ───────────────────────────────────────────────────────────

test('every tab switch resets the chips, because the handlers own the reset', () => {
  assert.match(SHEET_SRC,
    /const selectTab = useCallback\(\(next: Tab\) => \{\s*setTab\(next\);\s*setFilter\('everything'\);/,
    'selectTab switches the tab and clears the filter in one place');
  const direct = SHEET_SRC.match(/setTab\('(?:unread|messages|all)'\)/g) || [];
  assert.deepEqual(direct, ["setTab('messages')"],
    'only the mount deep link sets a tab directly — it runs once, before any '
    + 'chip can be selected, and an existing test pins that line');
});
