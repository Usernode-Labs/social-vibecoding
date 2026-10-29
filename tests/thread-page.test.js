'use strict';

// Threads, stage 3 of #6019: what a request's, a change's and a decision's
// page says about the thread it is in, without a database. The read behind
// it runs against PostgreSQL in thread-followers-postgres.test.js.
//
// What this pins:
//   1. The list is the thread's OTHER items, oldest first, each named and
//      placed in words, a zero said by nothing; a change's or a vote's
//      newest replies fold under its row, a request's never do.
//   2. The one button: Notify me when not following, Mute when following,
//      Muted (pressed) when muted, whose press goes back to the rule.
//   3. Its first render is nothing, so the page's first paint is unchanged.
//   4. All three pages draw it, and a decision's reads its thread by id.
//   5. Old links: a request address with a change's number opens the
//      change, and a change address with a request's number the request.
//   6. The vote sheet's Discussion is the thread's.
//
// Run with: node --test tests/thread-page.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MODEL = 'frontend/src/features/dev-board/topic/thread-model.ts';
const ITEMS = 'frontend/src/features/dev-board/topic/thread-items.tsx';

const payload = (items, follow = { state: 'none', chosen: false }) => ({
  thread: { id: 3, number: 7, kind: 'work', lead: 'request', title: null, state: 'open' },
  items,
  follow,
});
const request = { type: 'request', id: 11, number: 7, title: 'Dark mode', status: 'open', replies: 4 };
const change = {
  type: 'change', id: 51, number: 8, title: 'Dark mode toggle', status: 'promoted', state: 'review', replies: 2,
  folded: [{ id: 90, username: 'maya', text: 'Works on my phone.' }],
};
const close = { type: 'close', id: 5, number: null, title: 'Close #7', status: 'open', replies: 0, folded: [] };

const words = (phrase) => (typeof phrase === 'string' ? phrase : message(phrase.id, phrase.values));

test('the list is the other items, oldest first, each named and placed in words', () => {
  const { threadRows } = loadTsx(MODEL);
  const onRequest = threadRows(payload([request, change, close]), { type: 'request', id: 7 });
  assert.deepEqual(onRequest.map((r) => r.key), ['change:51', 'close:5'], 'the page itself is not listed');
  assert.equal(words(onRequest[0].title), 'Dark mode toggle');
  assert.equal(onRequest[0].facts.map(words).join(' · '), 'Change #8 · Up for a vote · 2 replies');
  assert.equal(onRequest[1].facts.map(words).join(' · '), 'Vote to close · Up for a vote', 'zero replies say nothing');
  assert.deepEqual(JSON.parse(JSON.stringify(onRequest[0].open)), { kind: 'proposal', id: 51 });
  assert.deepEqual(JSON.parse(JSON.stringify(onRequest[1].open)), { kind: 'gov', id: 5 });
  assert.deepEqual(onRequest[0].folded.map((r) => r.text), ['Works on my phone.']);

  const onChange = threadRows(payload([request, change]), { type: 'change', id: 51 });
  assert.deepEqual(onChange.map((r) => r.key), ['request:11']);
  assert.equal(onChange[0].facts.map(words).join(' · '), 'Request #7 · Open · 4 replies');
  assert.deepEqual(JSON.parse(JSON.stringify(onChange[0].open)), { kind: 'issue', id: 7 });
  assert.deepEqual(onChange[0].folded, [], 'a request\'s replies are its own page, never folded');

  const live = threadRows(payload([{ ...change, state: 'merged', replies: 1 }]), { type: 'request', id: 7 });
  assert.equal(live[0].facts.map(words).join(' · '), 'Change #8 · Live · 1 reply');
  const untitled = threadRows(payload([{ ...change, title: null, number: null, state: 'underway' }]), null);
  assert.equal(words(untitled[0].title), 'A change');
  assert.equal(untitled[0].facts.map(words).join(' · '), 'A change · Being made · 2 replies');
  assert.deepEqual(threadRows(null, null), []);
});

test('one button: Notify me, Mute, or Muted whose press goes back to the rule', () => {
  const { followButton } = loadTsx(MODEL);
  const plain = (b) => JSON.parse(JSON.stringify(b));
  assert.equal(followButton(null), null, 'signed out there is no one to notify');
  assert.deepEqual(plain(followButton({ state: 'none', chosen: false })), {
    label: 'project:topic.thread.follow.notifyMe', hint: 'project:topic.thread.follow.notifyMeHint', pressed: false, next: true,
  });
  assert.deepEqual(plain(followButton({ state: 'following', chosen: false })).next, false);
  assert.deepEqual(plain(followButton({ state: 'muted', chosen: true })), {
    label: 'project:topic.thread.follow.muted', hint: 'project:topic.thread.follow.mutedHint', pressed: true, next: null,
  });
  assert.equal(message('project:topic.thread.follow.notifyMe'), 'Notify me');
  assert.equal(message('project:topic.thread.follow.mute'), 'Mute');
  assert.equal(message('project:topic.thread.follow.muted'), 'Muted');
  assert.equal(message('project:topic.thread.label'), 'In this thread');
});

test('its first render is nothing; the thread is read in an effect', () => {
  const html = renderComponent(ITEMS, 'ThreadItems', { slug: 'p', number: 7, here: { type: 'request', id: 7 } });
  assert.equal(html, '');
  const src = read(ITEMS);
  assert.match(src, /useEffect\(\(\) => \{\s+setData\(null\);/);
  assert.match(src, /`\/api\/apps\/\$\{encodeURIComponent\(slug\)\}\/threads\/\$\{number\}`/);
  assert.match(src, /`\/api\/threads\/\$\{threadId\}`/, 'a decision is read by its thread');
  assert.match(src, /fetch\(`\/api\/threads\/\$\{data\.thread\.id\}\/follow`, \{\s+method: 'PUT'/);
  assert.match(src, /import \{ GroupedList, ListRow, SectionHeader \} from '@\/components\/ui\/grouped-list';/,
    'drawn from the shell\'s own list');
});

test('the request, change and decision pages draw it', () => {
  assert.match(read('frontend/src/features/dev-board/topic/request-head.tsx'),
    /<ThreadItems slug=\{pageSlug\(\)\} number=\{r\.number\} here=\{\{ type: 'request', id: r\.number \}\} \/>/);
  assert.match(read('frontend/src/features/dev-board/topic/change-head.tsx'),
    /<ThreadItems slug=\{pageSlug\(\)\} number=\{threadNumber\} here=\{\{ type: 'change', id \}\} \/>/);
  const topic = read('frontend/src/features/dev-board/topic/topic-head.tsx');
  assert.match(topic, /threadNumber=\{Number\(linkedIssues\[0\]\) \|\| Number\(session\?\.pr_number\) \|\| null\}/,
    'a change\'s thread is its first request\'s, else its own');
  assert.match(topic, /threadId=\{Number\(item\.thread_id\)\}/);
});

test('an address with the other kind\'s number opens what the number is', () => {
  const view = read('public/js/app-view.js');
  const helper = view.slice(view.indexOf('async _openByThread(asked, number, still)'));
  assert.ok(helper.length > 100, 'AppView._openByThread exists');
  assert.match(helper, /if \(asked === 'issue' && change\) \{\s+await AppView\.openTopic\('proposal', Number\(change\.id\)\);/);
  assert.match(helper, /if \(asked === 'proposal' && request\) \{\s+await AppView\.openTopic\('issue', n\);/);
  assert.match(view, /if \(await AppView\._openByThread\('proposal', ref\.pr, \(\) => AppView\._devTopic === pending\)\) return;/);
  const fetchItem = view.slice(view.indexOf('async _fetchTopicItem(ref) {'), view.indexOf('async _fetchTopicItem(ref) {') + 700);
  assert.match(fetchItem, /const row = await AppView\._fetchIssueByNumber\(ref\.id\);\s+if \(row\) return row;[\s\S]*await AppView\._openByThread\('issue', ref\.id, \(\) => AppView\._devTopic === here\);\s+return null;/,
    'asked inside the item fetch, so the board fallback keeps its moment');
});

test('the vote sheet\'s Discussion opens the thread the change talks in', () => {
  const sheet = read('frontend/src/features/review-flow/vote-sheet.tsx');
  assert.match(sheet, /<ThreadTalk item=\{item\} \/>/);
  assert.doesNotMatch(sheet, /<FeedThread slug=\{item\.app\.slug\} type="session" refId=\{item\.id\} canPost \/>/);
  assert.match(sheet, /setAnchor\(lead > 0 \? \{ type: 'issue', ref: lead \} : own\);/);
});
