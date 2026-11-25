'use strict';

// #7157: the Homeroom bot tab's In progress count opens In progress, the way
// the Needs you count opens Waiting on you.
//
// What this pins:
//   1. The view has its own address (frontend/src/features/ai/filter-address.ts):
//      `#homeroom-bot/progress` is asked, keeps the project filter, and is
//      neither the bare tab nor Waiting on you.
//   2. The head's In progress count is a button that opens it, only when
//      something is in progress; a zero stays plain text.
//   3. In progress lists every thread of the band, none folded and no Show
//      more, in place of Needs you and Done; its heading, its way back, its
//      empty, loading and failed states say what the catalog says.
//   4. Only one of the two lists is open at a time (index.tsx).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ADDRESS = 'frontend/src/features/ai/filter-address.ts';
const LISTS = 'frontend/src/features/ai/lists.tsx';

const garden = { slug: 'garden', name: 'Garden club', icon_url: null, icon_emoji: null };
const club = { slug: 'book-swap', name: 'Book swap', icon_url: null, icon_emoji: null };

// An In progress thread, as index.tsx hands them over (AiThread).
function building(threadId, title, app, number) {
  return {
    threadId, number, kind: 'request', title, app, change: null, unread: 0,
    href: `#app/${app.slug}/dev/issues/${number}`,
    group: 'next',
    work: { stage: 'building' },
    at: null,
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

test('In progress has its own address, kept beside the project filter', () => {
  const a = loadTsx(ADDRESS);
  assert.equal(a.progressAsked('#homeroom-bot/progress'), true);
  assert.equal(a.progressAsked('#homeroom-bot/progress?project=garden,book-swap'), true);
  assert.equal(a.progressAsked('#homeroom-bot/progress/'), true, 'a trailing slash is the same place');
  assert.equal(a.progressAsked('#homeroom-bot'), false);
  assert.equal(a.progressAsked('#homeroom-bot/waiting'), false, 'not Waiting on you');
  assert.equal(a.progressAsked('#homeroom-bot/history'), false);
  assert.equal(a.progressAsked('#homeroom-bot/request/garden/1'), false);
  assert.equal(a.waitingAsked('#homeroom-bot/progress'), false, 'and Waiting on you is not it');
  assert.equal(a.progressAddress(['garden', 'book-swap']), '#homeroom-bot/progress?project=garden,book-swap');
  assert.equal(a.progressAddress(), '#homeroom-bot/progress');
});

test('the head\'s In progress count opens the list, and only when something is in progress', () => {
  const progress = [building(1, 'Display app logos in profile Projects', garden, 11), building(2, 'Reduce top spacing', club, 12)];
  const linked = lists({ progress, onOpenProgress() {} });
  assert.match(linked, /<button[^>]*data-ai-progress-open=""[^>]*>In progress: 2<\/button>/, 'the count is the way in');
  assert.match(linked, new RegExp(`aria-label="${message('messages:ai.progress.open', { count: 2 })}"`));
  // The Nothing needs you wording: the In progress half is a link there too.
  const clear = lists({ progress, onOpenProgress() {} });
  assert.match(clear, /Nothing needs you/);
  assert.match(clear, /data-ai-progress-open=""/);
  // Nothing in progress: no link to a list of nothing.
  assert.doesNotMatch(lists({ progress: [], onOpenProgress() {} }), /data-ai-progress-open/, 'a zero is not a link');
  assert.doesNotMatch(lists({ progress }), /data-ai-progress-open/, 'no opener, no link');
});

test('the Needs you link still renders beside it', () => {
  const rows = [{
    key: 'need:proposal:1', title: 'Add a high score table', app: garden, who: 'all', unread: 0,
    sub: { id: 'messages:ai.row.where', values: { project: garden.name, number: 473 } },
    pill: { id: 'messages:ai.pill.vote' }, href: '#app/garden/dev/issues/473', rootId: null, threadId: 473,
  }];
  const progress = [building(1, 'Display app logos', garden, 11)];
  const html = lists({ rows, owed: 1, progress, onOpenWaiting() {}, onOpenProgress() {} });
  assert.match(html, /data-ai-waiting-open=""/);
  assert.match(html, /data-ai-progress-open=""/);
});

test('In progress lists every thread of the band, and nothing else', () => {
  const progress = Array.from({ length: 9 }, (_, i) => building(i + 1, `Release note ${i + 1}`, i % 2 ? club : garden, 500 + i));
  const html = lists({ progress, progressOpen: true, onOpenProgress() {}, onCloseProgress() {} });
  assert.match(html, /data-ai-sheet="progress"/);
  assert.match(html, /data-ai-list="progress"/);
  assert.match(html, new RegExp(`>${message('messages:ai.band.progress')}<`), 'its heading is In progress');
  assert.match(html, /data-ai-band-count="">9</, 'the count is the rows');
  for (let i = 1; i <= 9; i += 1) assert.match(html, new RegExp(`Release note ${i}<`), `row ${i}`);
  assert.doesNotMatch(html, /data-ai-group-more/, 'no Show more');
  assert.doesNotMatch(html, /data-ai-list="work"/, 'no Needs you');
  assert.doesNotMatch(html, /data-ai-list="live"/, 'no Done');
  assert.match(html, new RegExp(message('messages:ai.waiting.all')), 'the way back');
  assert.match(html, /data-ai-progress-close=""/);
  // The head, its search and its filter stay above it.
  assert.match(html, /data-ai-sheet="head"/);
  assert.match(html, /data-ai-project-more=""/);
});

test('In progress says when it is empty, loading or unreadable', () => {
  const open = { progressOpen: true, onCloseProgress() {} };
  const empty = lists(open);
  assert.match(empty, /data-ai-empty="progress"/);
  assert.match(empty, new RegExp(`>${message('messages:ai.band.progressEmpty')}<`));
  const loading = lists({ ...open, ready: false });
  assert.match(loading, /data-ai-loading=""/);
  assert.match(loading, new RegExp(message('messages:ai.progress.loading')));
  const failed = lists({ ...open, failed: 'failed', ready: false });
  assert.match(failed, /data-ai-failed="failed"/);
  // A search with no match says the search's words, not "Nothing in progress".
  const searched = lists({ ...open, progress: [building(1, 'Dark mode', garden, 403)], query: 'zzz' });
  assert.match(searched, /data-ai-empty="progress"/);
  assert.match(searched, new RegExp(message('messages:ai.search.noneThreads', { query: 'zzz' })));
  assert.doesNotMatch(searched, new RegExp(`>${message('messages:ai.band.progressEmpty')}<`));
});

test('only one of Waiting on you and In progress is opened at a time', () => {
  // Both lists cannot be on screen: opening either clears the other, and an
  // address for one closes the other (index.tsx).
  const src = fs.readFileSync('frontend/src/features/ai/index.tsx', 'utf8');
  assert.match(src, /const askedProgress = progressAsked\(hash\);/);
  assert.match(src, /if \(!progressWas\.current\) setMoved\(\(n\) => n \+ 1\);/);
  assert.match(src, /progressWas\.current = askedProgress;/);
  const openProgress = /const openProgress = \(\) => \{([\s\S]*?)\n  \};/.exec(src);
  assert.ok(openProgress, 'openProgress is there');
  assert.match(openProgress[1], /setWaitingOpen\(false\)/, 'opening it closes Waiting on you');
  assert.match(openProgress[1], /showAddress\(progressAddress\(picked\)\)/, 'and writes its own address');
  const openWaiting = /const openWaiting = \(\) => \{([\s\S]*?)\n  \};/.exec(src);
  assert.ok(openWaiting, 'openWaiting is there');
  assert.match(openWaiting[1], /setProgressOpen\(false\)/, 'and the other way round');
});
