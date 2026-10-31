'use strict';

// A thread's page, tidied (31 Oct 2026, from the review of how threads
// show). What was drawn on it as pills and folds is the page's ⋯ now, a plan
// sits with the change built from it, and a private thread opened from the
// Homeroom bot page takes Main Chat's whole column. Pinned here:
//
//   1. The ⋯'s keys, and that a head publishes its rows there and takes
//      them back (thread-menu.ts).
//   2. Which moves a thread offers, in the ⋯'s order (thread-moves.tsx).
//   3. Mute and the moves are rows on a page with a ⋯, never pills there;
//      Build it with your own Claude Code is a row, not a fold under Build
//      it now.
//   4. A plan goes with the change built from it; only plans not built yet
//      are listed under the request.
//   5. Main Chat's thread is the whole column, with a way back.
//   6. Where a private thread stands says what it is and what it answers.
//
// Run with: node --test tests/thread-page-menu.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const TOPIC = 'frontend/src/features/dev-board/topic';
const plain = (v) => JSON.parse(JSON.stringify(v));

test('the ⋯ a request or a change carries is keyed the way the page registers it', () => {
  const { requestMenuKey, changeMenuKey } = loadTsx(`${TOPIC}/thread-menu.ts`);
  assert.equal(requestMenuKey('request:18:own', 18), 'request:18:own', 'the page\'s own key wins');
  assert.equal(requestMenuKey(null, 18), 'request:18');
  assert.equal(changeMenuKey(null, 63), 'detail:proposal:63');
  assert.equal(changeMenuKey(null, null), '');
  const source = read(`${TOPIC}/thread-menu.ts`);
  assert.match(source, /av\._setThreadCardActions\(key, source, latest\.current\.map\(/, 'published into the card menu');
  assert.match(source, /return \(\) => av\._setThreadCardActions\(key, source, \[\]\);/, 'and taken back when the head goes');
  assert.match(source, /act: \(\) => latest\.current\[i\]\?\.act\(\)/, 'a row acts through the newest closures');
});

test('a thread offers Merge, Split one out where it holds more than its lead, and Break it up where an open request leads it', () => {
  const { moveChoices } = loadTsx(`${TOPIC}/thread-moves.tsx`);
  const item = (type, number, status = 'open') => ({ type, id: number, number, title: null, status, replies: 0 });
  const payload = (over = {}) => ({
    thread: { id: 1, number: 18, kind: 'work', lead: 'request', title: 'Dark mode', state: 'open', ...over.thread },
    items: over.items || [item('request', 18)],
    follow: null,
    moves: over.moves || [],
  });
  assert.deepEqual(plain(moveChoices(payload())), ['merge', 'breakup']);
  assert.deepEqual(plain(moveChoices(payload({ items: [item('request', 18), item('request', 22)] }))), ['merge', 'split', 'breakup']);
  assert.deepEqual(plain(moveChoices(payload({ items: [item('request', 18, 'closed')] }))), ['merge'], 'a closed request is not broken up');
  assert.deepEqual(plain(moveChoices(payload({ thread: { lead: 'change' }, items: [item('change', 18)] }))), ['merge']);
  assert.deepEqual(plain(moveChoices(payload({ thread: { kind: 'decision' } }))), [], 'a decision moves nowhere');
  assert.deepEqual(plain(moveChoices(payload({ thread: { state: 'closed' } }))), []);
  assert.deepEqual(plain(moveChoices(payload({ moves: [{ id: 3, kind: 'merge', state: 'voting' }] }))), [], 'one move at a time');
  assert.deepEqual(plain(moveChoices(null)), []);
  assert.equal(message('project:topic.thread.move.mergeInto'), 'Merge into another thread');
});

test('on a page with a ⋯, Mute and the moves are its rows, never pills on the page', () => {
  const items = read(`${TOPIC}/thread-items.tsx`);
  assert.match(items, /useThreadMenu\(menuKey, 'thread', menuRows\);/);
  assert.match(items, /\{rows\.length \|\| \(button && !inMenu\) \?/, 'the follow pill only where there is no ⋯');
  assert.match(items, /pills=\{false\}/, 'the moves open from the ⋯');
  assert.equal(message('project:topic.thread.follow.unmute'), 'Unmute');
  const moves = read(`${TOPIC}/thread-moves.tsx`);
  assert.match(moves, /\{pills && choices\.length \?/, 'its pills are drawn only where asked for');
  const change = read(`${TOPIC}/change-head.tsx`);
  assert.match(change, /<ThreadItems[^>]*menuKey=\{menuKey \|\| null\}/);
  const topic = read(`${TOPIC}/topic-head.tsx`);
  assert.match(topic, /menuKey=\{card\.rail\?\.menuKey \|\| null\}/, 'a decision\'s too');
});

test('Build it with your own Claude Code is a row of the ⋯, not a fold under Build it now', () => {
  const head = read(`${TOPIC}/request-head.tsx`);
  assert.match(head, /useThreadMenu\(menuKey, 'agent',/);
  assert.match(head, /<OwnAgentLink[^>]*startOpen/);
  const status = head.slice(head.indexOf('function RequestStatus('), head.indexOf('function RequestStatus(') + 4000);
  assert.doesNotMatch(status.slice(0, status.indexOf('\n}\n')), /<OwnAgentLink/);
  const link = read(`${TOPIC}/own-agent-link.tsx`);
  assert.match(link, /open=\{startOpen \|\| undefined\}/);
});

test('a plan goes with the change built from it; the request lists only plans not built yet', () => {
  const { plansByChange } = loadTsx(`${TOPIC}/request-head.tsx`);
  const plan = (session, title) => ({ key: `s${session}`, title, version: 1, by: 'ada', at: null, time: '', timeTitle: '',
    read: { kind: 'shared', sessionId: session, version: 1, previewTitle: title } });
  const copy = { key: 'g1', title: 'GitHub copy', version: null, by: 'bot', at: null, time: '', timeTitle: '',
    read: { kind: 'text', title: 'GitHub copy', markdown: '', html: '' } };
  const { plans, unbuilt } = plansByChange([plan(67, 'Plan A'), plan(68, 'Plan B'), plan(90, 'Plan C'), copy], [{ id: 67 }, { id: 68 }]);
  assert.equal(plans.get(67).title, 'Plan A');
  assert.equal(plans.get(68).title, 'Plan B');
  assert.deepEqual(unbuilt.map((c) => c.title), ['Plan C', 'GitHub copy']);
  const changes = read(`${TOPIC}/thread-changes.tsx`);
  assert.match(changes, /data-thread-change-plan=/);
  assert.equal(message('project:topic.thread.page.fromPlan', { title: 'Plan A' }), 'Built from the plan "Plan A"');
});

test('Main Chat\'s thread takes its whole column, with a way back to the chat', () => {
  const css = read('public/css/app.css');
  assert.match(css, /\.messages-layout\[data-main-chat\]\.messages-has-reply-thread > \.messages-thread-pane \{ display: none; \}/);
  assert.match(css, /\.messages-layout\[data-main-chat\] > \.messages-reply-pane \{\n {2}flex: 1 1 auto;\n {2}width: 100%;/);
  assert.match(css, /\.messages-layout\[data-main-chat\] > \.messages-reply-pane > \.messages-reply-resizer \{ display: none; \}/);
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /data-reply-close="" data-reply-back=""/);
  assert.match(screen, /aria-label=\{t\('messages:replies\.backToMain'\)\}/);
  assert.equal(message('messages:replies.backToMain'), 'Back to Main Chat');
  assert.match(read('frontend/src/features/ai/index.tsx'), /<EmbeddedConversation [^>]*mainChat/);
  assert.match(read('frontend/src/features/ai/phone-drawer.tsx'), /<EmbeddedConversation [^>]*mainChat/);
});

test('where a private thread stands says what it is and what a reply answers', () => {
  const svc = read('src/services/private-threads.js');
  const fn = svc.slice(svc.indexOf('async function stateOf('), svc.indexOf('async function record('));
  assert.match(fn, /LEFT JOIN threads t ON t\.id = p\.target_thread_id/);
  assert.match(fn, /if \(!row\) return \{ state: 'open', kind: 'idea', app: null, target: null \};/);
  assert.match(fn, /kind: row\.kind/);
});
