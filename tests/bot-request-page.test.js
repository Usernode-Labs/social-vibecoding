'use strict';

// A request's story is its own page (31 Oct 2026, from the review of how
// threads show). In the chat with Homeroom bot, news about a request opened
// a thread of the chat's own: the request's card again, "No replies yet",
// "Reply about this request…". That was a second view of the request's
// public thread that neither Main Chat nor the bot page's list of threads
// led to. Now a thread in that chat is only one the person started (or a
// draft the bot opened for them), and everything about a request opens the
// request's page. Pinned here:
//
//   1. Which page a bot message stands for (request-page.ts), and that the
//      bot's own private threads (a draft, a design) are not one of them.
//   2. Every way in goes there: a thread opened by id and a link to an old
//      thread. (14 Nov 2026: a moment's "↳ in …" label, one more way in,
//      went with Main Chat, and so did the one-line news rows of the chat's
//      own stream, whose tap was another; the activity drawer on 5 Nov
//      2026.)
//   3. A row draws nothing of a request's story: the stream that did is
//      drawn on no screen, and a bot row is always in a thread.
//
// Run with: node --test tests/bot-request-page.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PAGE = 'frontend/src/features/messages/request-page.ts';
const STORE = 'frontend/src/features/messages/store.ts';

const BOT = { id: 2, username: 'homeroom_bot', bot: true };
const ADA = { id: 7, username: 'ada' };
const msg = (sender, homeroomBot, extra = {}) => ({ id: 40, sender, content: 'x', metadata: { homeroomBot }, ...extra });
const plain = (v) => JSON.parse(JSON.stringify(v));

test('a bot message about a request stands for the request\'s page; a first version for its project\'s hub', () => {
  const { requestPageOf } = loadTsx(PAGE);
  assert.deepEqual(plain(requestPageOf(msg(BOT, { kind: 'activity', appSlug: 'plant-pal', appName: 'Plant Pal', issueNumber: 18, requestTitle: 'Dark mode' }))), {
    route: 'app/plant-pal/dev/issues/18', label: 'Dark mode', place: { slug: 'plant-pal', name: 'Plant Pal' }, issueNumber: 18,
  });
  assert.equal(requestPageOf(msg(BOT, { kind: 'question', appSlug: 'plant-pal', issueNumber: 7 })).label, 'Request #7');
  assert.deepEqual(plain(requestPageOf(msg(BOT, { kind: 'activity', appSlug: 'plant-pal', appName: 'Plant Pal', firstVersion: true }))), {
    route: 'app/plant-pal/dev', label: 'Plant Pal', place: { slug: 'plant-pal', name: 'Plant Pal' }, issueNumber: null,
  });
});

test('the bot\'s own private threads, a person\'s message and a message about no request are none', () => {
  const { requestPageOf } = loadTsx(PAGE);
  assert.equal(requestPageOf(msg(BOT, { kind: 'opened_draft', appSlug: 'plant-pal', draft: 'post_reply', issueNumber: 18 })), null);
  assert.equal(requestPageOf(msg(BOT, { kind: 'opened_design', appSlug: 'plant-pal' })), null);
  assert.equal(requestPageOf(msg(ADA, { kind: 'activity', appSlug: 'plant-pal', issueNumber: 18 })), null);
  assert.equal(requestPageOf(msg(BOT, { kind: 'chat', appSlug: 'plant-pal' })), null);
  assert.equal(requestPageOf(msg(BOT, null)), null);
  assert.equal(requestPageOf(null), null);
});

test('it opens beside the bot page, in its column, when the panel takes it, else the page, which goes back', () => {
  const source = read(PAGE);
  assert.match(source, /if \(w\.UsernodeReact\?\.sidePanel\?\.take\?\.\(page\.route, \{ place: page\.place, label: page\.label \}\)\) return;/);
  // 14 Nov 2026: Main Chat's composer carried the request; there is no Main
  // Chat, so opening a request's page attaches it to nothing.
  assert.doesNotMatch(source, /messages-object-selected|conversationId/);
  assert.match(source, /Improve\?\.enterTopicFrom\?\.\(window\.location\.hash/);
  assert.match(source, /AppView\?\._landOnHub\?\.\(page\.place\.slug\)/, 'a door to a project\'s hub lands on the hub');
  assert.match(source, /window\.location\.hash = page\.route;/);
});

test('every way into a request\'s story goes to its page', () => {
  // The one-line news rows of the chat's own stream, whose tap opened the
  // page, went with that stream (14 Nov 2026), and their door with them.
  assert.ok(!fs.existsSync(path.join(ROOT, 'frontend/src/features/messages/bot-news-line.tsx')));
  const row = read('frontend/src/features/messages/message-row.tsx');
  // The "↳ in …" label over a moment Main Chat also listed was one more way
  // in; it went with Main Chat and the stamp that drew it (14 Nov 2026).
  assert.doesNotMatch(row, /openRequestPage|data-bot-thread-label/, 'a row has no door of its own to a request\'s story');
  // The activity drawer, which opened its rows the same way, is gone (5 Nov 2026).
  assert.doesNotMatch(read('frontend/src/features/messages/bot-strip.tsx'), /openRequestPage|openThreadAt/, 'no door of its own');
  const store = read(STORE);
  assert.doesNotMatch(store, /openThreadAt|threadFocusId/, 'and nothing opens a thread of the chat at a request\'s news');
  const open = store.slice(store.indexOf('export function openThread(rootId: number)'));
  assert.match(open.slice(0, 600), /const page = requestPageFor\(findRow\(rootId\)\);\n {2}if \(page\) \{ openRequestPage\(page\); return; \}/, 'a thread opened by id');
  const load = store.slice(store.indexOf('export async function loadReplyThread('));
  assert.match(load.slice(0, 2400), /const story = requestPageFor\(page\.root \|\| findRow\(rootId\)\);\n {4}if \(story\) \{\n {6}closeThread\(\);\n {6}openRequestPage\(story\);/, 'a link to an old thread');
  const pane = read('frontend/src/features/messages/index.tsx');
  assert.match(pane, /if \(botChat && kind === 'direct' && requestPageOf\(root\)\) return null;/, 'and the pane never draws one');
});

test('the store asks only in the chat with the bot', () => {
  const store = read(STORE);
  const fn = store.slice(store.indexOf('function requestPageFor('), store.indexOf('/** Open the thread that hangs off'));
  assert.match(fn, /state\.active\?\.kind !== 'direct' \|\| !threadsAllowed\(state\.active\)\) return null;/);
});

test('"See progress" opens the request\'s page, never Main Chat or a thread of the request\'s own', () => {
  const store = read(STORE);
  const fn = store.slice(store.indexOf('export async function openBotRequest('), store.indexOf('/** What the composer\'s box asks'));
  // 14 Nov 2026: it opened Main Chat at the last thing said about the
  // request. A request's news is on its page, so that is where it goes.
  assert.match(fn, /const page = requestPage\(\{ appSlug: slug, issueNumber: Number\(number\) \}\);\n {2}if \(page\) openRequestPage\(page\);/);
  assert.doesNotMatch(fn, /focusMessageId: at|threadRootId: null/);
  assert.doesNotMatch(fn, /openThreadAt\(track\.rootId/);
  // A plan said in the private thread its request started in opens there, at the plan.
  assert.match(fn, /if \(track\?\.askId && track\.askThreadId\) \{\s*openBotTab\(\{ threadRootId: track\.askThreadId, focusMessageId: track\.askId \}\);\s*return;\s*\}/);
});

test('the Hub\'s Review the plan follows a first version\'s plan into its maker\'s private thread', () => {
  const hub = read('frontend/src/features/dev-board/workshop/hub-cards.tsx');
  assert.match(hub, /if \(action === 'review' && fv\.plan_at\?\.threadRootId\) \{[\s\S]{0,120}openBotTab\(\{ threadRootId: fv\.plan_at\.threadRootId, focusMessageId: fv\.plan_at\.messageId \?\? null \}\);/);
  const apps = read('src/routes/apps.js');
  assert.match(apps, /\.\.\.\(mine && state\.plan && Number\(state\.plan\.threadRootId\) > 0 \? \{\s*plan_at: \{/);
});

test('an answer to a moment from an old story thread is said in Main Chat; a thread of one\'s own keeps its answers', () => {
  const store = read(STORE);
  const fn = store.slice(store.indexOf('function botThreadOf('), store.indexOf('/**', store.indexOf('function botThreadOf(')));
  assert.match(fn, /if \(!root \|\| state\.route\.threadRootId === root\) return root;/);
  assert.match(fn, /if \(rootRow\) return requestPageFor\(rootRow\) \? null : root;/);
});

test('a row has no thread of a request\'s to offer: a bot row is drawn in a thread', () => {
  const row = read('frontend/src/features/messages/message-row.tsx');
  // The chat's own stream drew a request's card with "N updates" under it,
  // and no thread at all for a request's news. Nothing draws that stream.
  assert.match(row, /const threadRoot = !live \|\| inThread \|\| !threads \? null : message\.threadRootId \|\| message\.id;/);
  assert.match(row, /\{message\.thread && !inThread \? \(\s+<ThreadSummaryChip/);
  assert.doesNotMatch(row, /requestPageOf|data-bot-thread-link|row\.botThread/);
  const screen = read('frontend/src/features/messages/index.tsx');
  const stream = screen.slice(screen.indexOf('function ConversationThread('), screen.indexOf('function ThreadActivityRow('));
  assert.doesNotMatch(stream, /botChat|botDm|isBotNews|BotNewsLine|asksInChat/, 'the conversation\'s own transcript draws nothing the bot\'s way');
  // Every row drawn the bot's way is in a thread's pane.
  const pane = screen.slice(screen.indexOf('function ReplyThreadPanel('), screen.indexOf('function AppReplyThreadPanel('));
  for (const m of pane.match(/<MessageRow [^\n]*/g) || []) assert.match(m, / inThread botChat=\{botChat\}/);
});
