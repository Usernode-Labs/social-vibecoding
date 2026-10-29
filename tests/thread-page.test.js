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
  assert.match(src, /useEffect\(\(\) => \{\s+if \(!revision\) setData\(null\);/, 'cleared on a new page, kept while a move re-reads it');
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

// ── Stage 6: moves and ballots on the page ─────────────────────────────

test('competing changes are one ballot; a pick is votes, cast only where they change', () => {
  const { ballotOf, ballotVotes, moveLines, splittable } = loadTsx(MODEL);
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const a = { type: 'change', id: 51, number: 8, title: 'Toggle', status: 'promoted', state: 'review', replies: 0, epoch: 2, myVote: null, closes: [7] };
  const b = { type: 'change', id: 52, number: 9, title: 'Schedule', status: 'promoted', state: 'review', replies: 0, epoch: 0, myVote: 'yes', closes: [7] };
  assert.equal(ballotOf(payload([request, a])), null, 'one change is no ballot');
  // Parts of one request are not rivals: neither closes it (or each closes
  // a different request), so both go live and no pick takes a Yes back.
  assert.equal(ballotOf(payload([request, { ...a, closes: [] }, { ...b, closes: [] }])), null, 'two parts, no ballot');
  assert.equal(ballotOf(payload([request, { ...a, closes: [7] }, { ...b, closes: [11] }])), null, 'different requests, no ballot');
  assert.equal(ballotOf(payload([request, a, { ...b, closes: [] }])), null, 'a part beside a change that closes it, no ballot');
  const ballot = ballotOf(payload([request, a, b]));
  assert.deepEqual(ballot.options.map((o) => o.id), [51, 52]);
  assert.equal(ballot.pick, 52, 'her Yes on one is her pick');
  assert.deepEqual(plain(ballotVotes(ballot, 51)), [
    { sessionId: 51, vote: 'yes', epoch: 2 }, { sessionId: 52, vote: null, epoch: 0 },
  ], 'Yes on the pick, the other Yes taken back rather than turned into a No');
  assert.deepEqual(plain(ballotVotes(ballot, 52)), [], 'nothing to cast for the pick already made');
  assert.deepEqual(plain(ballotVotes(ballot, 'neither')), [
    { sessionId: 51, vote: 'no', epoch: 2 }, { sessionId: 52, vote: 'no', epoch: 0 },
  ]);
  assert.equal(ballotOf(payload([request, { ...a, myVote: 'no' }, { ...b, myVote: 'no' }])).pick, 'neither');
  assert.equal(message('project:topic.thread.ballot.neither'), 'Neither');
  // A waiting move says what it does and when.
  const lines = moveLines({ id: 1, kind: 'merge', state: 'pending', input: { intoNumber: 12 }, deadline: new Date(Date.now() + 23.2 * 3600000).toISOString(), agreed: [], governanceId: null });
  assert.equal(`${words(lines.what)}. ${words(lines.when)}`, 'Proposed: merge into #12. Happens in 24 hours unless someone objects');
  assert.equal(words(moveLines({ id: 2, kind: 'split', state: 'voting', input: { items: [{ type: 'request', number: 9 }] }, deadline: '', agreed: [], governanceId: 4 }).when),
    'Up for a vote, as someone objected');
  // A split may take anything but the lead.
  assert.deepEqual(splittable(payload([request, a])).map((i) => i.id), [51]);
});

test('the merge closes the rivals of the change that went live, and never waits on it', () => {
  const watcher = read('src/services/issue-close-watcher.js');
  assert.match(watcher, /if \(look === 1 && pool && appId && prNumber\) await require\('\.\/threads'\)\.closeRivals\(pool, \{ appId, prNumber \}\);/);
  const threads = read('src/services/threads.js');
  const fn = threads.slice(threads.indexOf('async function closeRivals('), threads.indexOf('module.exports = {'));
  assert.match(fn, /status = 'promoted'/, 'only changes still up for a vote');
  assert.match(fn, /COALESCE\(linked_issues, '\{\}'\) && \$3::int\[\]/, 'and only those that close a request it closes');
  assert.match(fn, /if \(!won \|\| !won\.closes\.length\) return \[\];/, 'a change that closes nothing has no rivals');
  assert.match(fn, /reason: 'superseded'/);
  assert.match(fn, /\} catch \(err\) \{\s+log\.warn\('threads', 'Could not look for a merged change\\'s rivals'/, 'never throws');
});
