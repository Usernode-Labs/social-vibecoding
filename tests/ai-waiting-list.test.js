'use strict';

// #7103: the Homeroom bot tab's Needs you count opens Waiting on you.
//
// What this pins:
//   1. The view has its own address (frontend/src/features/ai/filter-address.ts):
//      `#homeroom-bot/waiting` is asked, keeps the project filter, and the
//      bare tab (any query) is not it.
//   2. The head's Needs you count is a button that opens it, only when
//      something needs the person; a zero stays plain text.
//   3. Waiting on you lists every row of Needs you, each with its action
//      pill and no Show more, in place of In progress and Done; its heading,
//      its way back, its empty, loading and failed states say what the
//      catalog says.
//   4. A vote that a `work_state` push closes leaves the rows and the count
//      at once (frontend/src/features/ai/model.ts applyWorkState).

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ADDRESS = 'frontend/src/features/ai/filter-address.ts';
const MODEL = 'frontend/src/features/ai/model.ts';
const LISTS = 'frontend/src/features/ai/lists.tsx';

const garden = { slug: 'garden', name: 'Garden club', icon_url: null, icon_emoji: null };
const club = { slug: 'book-swap', name: 'Book swap', icon_url: null, icon_emoji: null };

function need(key, title, app, number) {
  return {
    key, title, app, who: 'all', unread: 0,
    sub: { id: 'messages:ai.row.where', values: { project: app.name, number } },
    pill: { id: 'messages:ai.pill.vote' },
    href: `#app/${app.slug}/dev/issues/${number}`,
    rootId: null,
    threadId: number,
  };
}

function lists(extra = {}) {
  return renderComponent(LISTS, 'AiLists', {
    hero: null,
    ready: true,
    owed: 0,
    rows: [],
    progress: [],
    waiting: [],
    live: [],
    openRow() {},
    openThread() {},
    ...extra,
  });
}

test('Waiting on you has its own address, kept beside the project filter', () => {
  const a = loadTsx(ADDRESS);
  assert.equal(a.waitingAsked('#homeroom-bot/waiting'), true);
  assert.equal(a.waitingAsked('#homeroom-bot/waiting?project=garden,book-swap'), true);
  assert.equal(a.waitingAsked('#homeroom-bot/waiting/'), true, 'a trailing slash is the same place');
  assert.equal(a.waitingAsked('#homeroom-bot'), false);
  assert.equal(a.waitingAsked('#homeroom-bot/history'), false);
  assert.equal(a.waitingAsked('#homeroom-bot/request/garden/1'), false);
  assert.equal(a.historyAsked('#homeroom-bot/waiting'), false, 'not History');
  assert.equal(a.waitingAddress(['garden', 'book-swap']), '#homeroom-bot/waiting?project=garden,book-swap');
  assert.equal(a.waitingAddress(), '#homeroom-bot/waiting');
  assert.equal(a.bareTab('#homeroom-bot'), true);
  assert.equal(a.bareTab('#homeroom-bot?project=garden'), true, 'the tab itself, narrowed');
  assert.equal(a.bareTab('#homeroom-bot/waiting'), false);
  assert.equal(a.bareTab('#homeroom-bot/request/garden/1'), false);
});

test('the head\'s Needs you count opens the list, and only when something needs you', () => {
  const rows = [need('need:proposal:1', 'Add a high score table', garden, 473), need('need:question:2', 'Crop before posting', club, 31)];
  const linked = lists({ rows, owed: 2, onOpenWaiting() {} });
  assert.match(linked, /<button[^>]*data-ai-waiting-open=""[^>]*>Needs you: 2<\/button>/, 'the count is the way in');
  assert.match(linked, new RegExp(`aria-label="${message('messages:ai.waiting.open', { count: 2 })}"`));
  assert.match(linked, /data-ai-hero-sub=""/, 'still the head\'s line');
  // Nothing needs you: no link to a list of nothing.
  const none = lists({ rows: [], owed: 0, history: { rows: [], next: null, ready: true, loading: false, failed: false, more() {}, retry() {} }, onOpenWaiting() {} });
  assert.doesNotMatch(none, /data-ai-waiting-open/, 'a zero is not a link');
  assert.doesNotMatch(lists({ rows, owed: 2 }), /data-ai-waiting-open/, 'no opener, no link');
});

test('Waiting on you lists every pending item with its action, and nothing else', () => {
  const rows = Array.from({ length: 9 }, (_, i) => need(`need:proposal:${i + 1}`, `Release note ${i + 1}`, i % 2 ? club : garden, 500 + i));
  const html = lists({ rows, owed: 9, waitingOpen: true, onOpenWaiting() {}, onCloseWaiting() {} });
  assert.match(html, /data-ai-sheet="waiting"/);
  assert.match(html, /data-ai-list="waiting"/);
  assert.match(html, new RegExp(`>${message('messages:ai.waiting.title')}<`), 'its heading is Waiting on you');
  assert.match(html, /data-ai-band-count="">9</, 'the count is the rows');
  for (let i = 1; i <= 9; i += 1) assert.match(html, new RegExp(`Release note ${i}<`), `row ${i}`);
  assert.equal((html.match(/data-ai-line="need"/g) || []).length, 9, 'every row, none folded');
  assert.doesNotMatch(html, /data-ai-group-more/, 'no Show more');
  assert.doesNotMatch(html, /data-ai-list="busy"/, 'no In progress');
  assert.doesNotMatch(html, /data-ai-list="live"/, 'no Done');
  assert.match(html, /data-ai-row-end="act"/, 'each row keeps its action pill');
  assert.match(html, new RegExp(message('messages:ai.waiting.all')), 'the way back');
  assert.match(html, /data-ai-waiting-close=""/);
  // The head, its search and its filter stay above it.
  assert.match(html, /data-ai-sheet="head"/);
  assert.match(html, /data-ai-project-more=""/);
});

test('Waiting on you says when it is empty, loading or unreadable', () => {
  const open = { waitingOpen: true, onCloseWaiting() {} };
  const empty = lists(open);
  assert.match(empty, /data-ai-empty="waiting"/);
  assert.match(empty, new RegExp(`>${message('messages:ai.waiting.empty')}<`));
  const loading = lists({ ...open, ready: false });
  assert.match(loading, /data-ai-loading=""/);
  assert.match(loading, new RegExp(message('messages:ai.waiting.loading')));
  const failed = lists({ ...open, failed: 'failed', ready: false });
  assert.match(failed, /data-ai-failed="failed"/);
  // A search with no match says the search's words, not "Nothing is waiting".
  const searched = lists({ ...open, rows: [need('need:proposal:1', 'Dark mode', garden, 403)], owed: 1, query: 'zzz' });
  assert.match(searched, /data-ai-empty="waiting"/);
  assert.match(searched, new RegExp(message('messages:ai.search.noneThreads', { query: 'zzz' })));
  assert.doesNotMatch(searched, new RegExp(`>${message('messages:ai.waiting.empty')}<`));
});

test('a vote a work_state push closes leaves the rows and the count at once', () => {
  const { needsYou, owedCount, applyWorkState } = loadTsx(MODEL);
  const needs = [
    { kind: 'proposal', id: 5, title: 'Quieter notification sounds', app: garden, threadId: 1 },
    { kind: 'question', id: 6, title: 'Which colour?', app: garden, threadId: 2 },
  ];
  const before = needsYou(needs, null);
  assert.equal(owedCount(before), 2);
  const push = {
    type: 'work_state',
    appId: 1,
    appSlug: 'garden',
    item: { kind: 'change', ref: 5, issueNumber: 500, sessionId: 5 },
    state: { stage: 'live', change: { id: 5 } },
  };
  const after = applyWorkState(null, needs, push).needs;
  const rows = needsYou(after, null);
  assert.deepEqual(rows.map((row) => row.title), ['Which colour?'], 'the decided vote is gone');
  assert.equal(owedCount(rows), 1, 'and the count it is drawn beside');
});
