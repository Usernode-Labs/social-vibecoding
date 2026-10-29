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
  // A request's page reads its thread once, draws its changes and its vote
  // to close under the request (thread-changes.tsx), and lists the rest.
  const head = read('frontend/src/features/dev-board/topic/request-head.tsx');
  assert.match(head, /const threadRead = useThreadPayload\(slug, r\.number\);/);
  assert.match(head, /<ThreadChanges slug=\{slug\} data=\{threadRead\.data\} number=\{r\.number\} changes=\{layout\.changes\} close=\{layout\.close\} onChanged=\{threadRead\.reread\} \/>/);
  assert.match(head, /<ThreadItems slug=\{slug\} number=\{r\.number\} here=\{here\} payload=\{threadRead\.data\} items=\{layout\.listed\} onChanged=\{threadRead\.reread\} \/>/);
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
  const ballot = ballotOf(payload([request, a, b]));
  assert.deepEqual(ballot.options.map((o) => o.id), [51, 52]);
  assert.equal(ballot.pick, 52, 'her Yes on one is her pick');
  assert.deepEqual(plain(ballotVotes(ballot, 51)), [
    { kind: 'change', sessionId: 51, vote: 'yes', epoch: 2 }, { kind: 'change', sessionId: 52, vote: null, epoch: 0 },
  ], 'Yes on the pick, the other Yes taken back rather than turned into a No');
  assert.deepEqual(plain(ballotVotes(ballot, 52)), [], 'nothing to cast for the pick already made');
  assert.deepEqual(plain(ballotVotes(ballot, 'neither')), [
    { kind: 'change', sessionId: 51, vote: 'no', epoch: 2 }, { kind: 'change', sessionId: 52, vote: 'no', epoch: 0 },
  ]);
  assert.equal(ballotOf(payload([request, { ...a, myVote: 'no' }, { ...b, myVote: 'no' }])).pick, 'neither');
  assert.equal(message('project:topic.thread.ballot.neither'), 'Neither');
  // Only changes that would close the same request compete (#5997 on prod:
  // a change that is part of a request closes nothing and is no rival).
  assert.equal(ballotOf(payload([request, a, { ...b, closes: [] }])), null, 'a change that closes nothing is on no ballot');
  assert.equal(ballotOf(payload([request, a, { ...b, closes: [12] }])), null, 'nor one that closes another request');
  assert.deepEqual(ballotOf(payload([request, a, b, { ...b, id: 53, closes: [12] }])).options.map((o) => o.id), [51, 52]);
  assert.equal(ballotOf(payload([request, a, { ...b, closes: [12] }]), new Set(), [12]), null, 'drawn for the requests a page is about');
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
  const fn = threads.slice(threads.indexOf('async function closeRivals('), threads.indexOf('async function closeThreadChanges('));
  assert.match(fn, /status = 'promoted'/, 'only changes still up for a vote');
  assert.match(fn, /COALESCE\(linked_issues, '\{\}'::int\[\]\) && COALESCE\(\$3::int\[\], '\{\}'::int\[\]\)/, 'only changes closing a request it closes');
  assert.match(fn, /reason: 'superseded'/);
  assert.match(fn, /\} catch \(err\) \{\s+log\.warn\('threads', 'Could not look for a merged change\\'s rivals'/, 'never throws');
});

// ── Follow-up: the request's page draws its changes ────────────────────

test('a request\'s page draws its changes and its vote to close; the list keeps the rest', () => {
  const { threadLayout } = loadTsx(MODEL);
  const vote = { ...close, target: 7 };
  const settled = { ...close, id: 6, status: 'closed' };
  const other = { type: 'request', id: 12, number: 9, title: 'Night mode', status: 'open', replies: 0 };
  const layout = threadLayout(payload([request, change, vote, settled, other]), { type: 'request', id: 7 });
  assert.deepEqual(layout.changes.map((c) => c.id), [51]);
  assert.equal(layout.close.id, 5);
  assert.deepEqual(layout.listed.map((i) => `${i.type}:${i.id}`), ['request:11', 'close:6', 'request:12'],
    'settled votes and the other requests stay listed (the page itself is left out by threadRows)');
  const onChange = threadLayout(payload([request, change, vote]), { type: 'change', id: 51 });
  assert.deepEqual(onChange.changes, [], 'a change\'s own page lists the thread as before');
});

test('a change and a vote to close compete; Close it stands in for Neither', () => {
  const { ballotOf, ballotVotes } = loadTsx(MODEL);
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const a = { type: 'change', id: 51, number: 8, title: 'Toggle', status: 'promoted', state: 'review', replies: 0, epoch: 2, myVote: 'yes', closes: [7] };
  const vote = { ...close, target: 7, myVote: null };
  const ballot = ballotOf(payload([request, a, vote]));
  assert.deepEqual(ballot.options.map((o) => o.id), [51]);
  assert.equal(ballot.close.id, 5, 'one change and a close are a ballot');
  assert.equal(ballot.pick, 51);
  assert.deepEqual(plain(ballotVotes(ballot, 'close')), [
    { kind: 'change', sessionId: 51, vote: 'no', epoch: 2 }, { kind: 'close', issueId: 5, vote: 'yes' },
  ], 'Close it is a No on every change and a Yes on the close');
  const closing = ballotOf(payload([request, { ...a, myVote: 'no' }, { ...vote, myVote: 'yes' }]));
  assert.equal(closing.pick, 'close');
  assert.deepEqual(plain(ballotVotes(closing, 51)), [
    { kind: 'change', sessionId: 51, vote: 'yes', epoch: 2 }, { kind: 'close', issueId: 5, vote: null },
  ], 'a change picked takes the close\'s Yes back');
  assert.equal(ballotOf(payload([request, a, { ...vote, target: 12 }])), null,
    'a vote to close another request does not compete with this one\'s change');
  assert.equal(message('project:topic.thread.ballot.close'), 'Close it');
});

test('proposing counts as your yes on the ballot where the gate counts it', () => {
  const { ballotOf, ballotVotes } = loadTsx(MODEL);
  const { authorCounts } = loadTsx('frontend/src/features/dev-board/topic/thread-changes.tsx');
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const mine = { type: 'change', id: 51, number: 8, title: 'Mine', status: 'promoted', state: 'review', replies: 0, epoch: 2, myVote: null, mine: true, closes: [7] };
  const theirs = { type: 'change', id: 52, number: 9, title: 'Theirs', status: 'promoted', state: 'review', replies: 0, epoch: 1, myVote: null, closes: [7] };
  // The rule decides (governance-rules.ts): Two yeses and Open floor count a person's change.
  assert.equal(authorCounts(mine, { approval_mode: 'rules', approval_preset: 'two_yeses' }), true);
  assert.equal(authorCounts(mine, { approval_mode: 'rules', approval_preset: 'open_floor' }), true);
  assert.equal(authorCounts(mine, { approval_mode: 'rules', approval_preset: 'you_or_the_group', creator_yes: true }), true);
  assert.equal(authorCounts(mine, { approval_mode: 'rules', approval_preset: 'group_vote' }), false, 'Group vote counts votes as cast');
  assert.equal(authorCounts({ ...mine, byBot: true }, { approval_mode: 'rules', approval_preset: 'open_floor' }), false, 'the bot\'s change is nobody\'s yes');
  assert.equal(authorCounts(theirs, { approval_mode: 'rules', approval_preset: 'open_floor' }), false);
  const counts = new Set([51]);
  const ballot = ballotOf(payload([request, mine, theirs]), counts);
  assert.equal(ballot.pick, 51, 'their own change is their pick');
  assert.deepEqual(plain(ballotVotes(ballot, 51, counts)), [], 'nothing to cast: proposing was the yes');
  assert.deepEqual(plain(ballotVotes(ballot, 52, counts)), [
    { kind: 'change', sessionId: 51, vote: 'no', epoch: 2 }, { kind: 'change', sessionId: 52, vote: 'yes', epoch: 1 },
  ], 'picking another takes a No to stop their own change counting');
  assert.equal(ballotOf(payload([request, mine, theirs])).pick, null, 'without the rule it is no pick');
});

test('the bar\'s pill says where the request\'s work stands', () => {
  const { requestPill, threadLayout } = loadTsx(MODEL);
  const here = { type: 'request', id: 7 };
  const layoutOf = (items) => threadLayout(payload([request, ...items]), here);
  const review = { type: 'change', id: 51, number: 8, title: 'A', status: 'promoted', state: 'review', replies: 0, closes: [7] };
  assert.equal(requestPill(layoutOf([]), null), null, 'nothing has moved');
  assert.equal(requestPill(layoutOf([review]), 'closed'), null, 'a closed request says how it ended in its line');
  assert.equal(requestPill(layoutOf([review]), null).key, 'vote');
  assert.equal(requestPill(layoutOf([review, { ...review, id: 52 }]), null).key, 'choosing');
  assert.equal(requestPill(layoutOf([{ ...close, target: 7 }]), null).key, 'close');
  assert.equal(requestPill(layoutOf([{ ...review, state: 'underway' }]), null).tone, 'progress');
  assert.equal(requestPill(layoutOf([]), 'building').key, 'building', 'the bot building it');
  assert.equal(requestPill(layoutOf([{ ...review, state: 'merged' }]), null).tone, 'ok');
  assert.equal(message('project:topic.thread.pill.choosing'), 'Pick one');
});

test('the request\'s changes are drawn from their own pages\' reads, and the ballot lives with them', () => {
  const src = read('frontend/src/features/dev-board/topic/thread-changes.tsx');
  assert.match(src, /readChangeDetail\(\{ id: item\.id, status: item\.status \}, false, abort\.signal\)/, 'read as its own page reads it');
  assert.match(src, /const built = av\._topicViewFor\('proposal', row\);/);
  assert.match(src, /<ChangeGates id=\{item\.id\} card=\{view\.card\} v=\{view\.v\} \/>/, 'its own page\'s two cards');
  assert.match(src, /changeDetailAsk\(\(event as CustomEvent\)\.detail, item\.id\)/, 'and it moves when its page would');
  assert.match(src, /av\.castIssueVote\?\.\(v\.issueId, 'up', \{ reason: null \}\)/, 'a close is voted the platform\'s way');
  const head = read('frontend/src/features/dev-board/topic/change-head.tsx');
  assert.match(head, /export const ChangeGates = forwardRef/);
  const items = read(ITEMS);
  assert.match(items, /data\.follow && here\.type !== 'request' \? <ThreadBallot slug=\{slug\} data=\{data\} here=\{here\} onChanged=\{changed\} \/> : null/,
    'a change\'s page still draws its ballot in the list');
});

// #6019 follow-up: a big request broken into smaller requests in the same
// thread, decided as a merge is.
test('a break-up says what it does and when; its form needs two parts', () => {
  const { moveLines } = loadTsx(MODEL);
  const lines = moveLines({
    id: 3, kind: 'breakup', state: 'pending', deadline: new Date(Date.now() + 5 * 3600000).toISOString(),
    input: { request: 20, parts: [{ title: 'Plot map' }, { title: 'Sowing calendar' }] }, agreed: [], governanceId: null,
  });
  assert.equal(`${words(lines.what)}. ${words(lines.when)}`, 'Proposed: break #20 up into 2 smaller requests. Happens in 5 hours unless someone objects');
  const src = read('frontend/src/features/dev-board/topic/thread-moves.tsx');
  assert.match(src, /const breakable = data\.thread\.lead === 'request'\s+&& data\.items\.some\(\(i\) => i\.type === 'request' && i\.number === number && i\.status === 'open'\);/);
  assert.match(src, /disabled=\{busy \|\| filledParts\.length < 2\}/);
  assert.match(src, /kind: 'breakup', request: number, parts: filledParts\.map/);
});
