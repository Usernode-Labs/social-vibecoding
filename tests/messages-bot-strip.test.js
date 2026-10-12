'use strict';

// One request, one story: the chat with Homeroom bot, redrawn.
//
//   1. "Your requests", the strip pinned under the chat's header
//      (frontend/src/features/messages/bot-strip.tsx): its groups (Needs
//      you, Ready to try, In progress, Done today, each request once), each
//      row's state words and button, the limits and "+N more", the summary
//      bar with Hide / Show (collapsed when nothing waits on the person, and
//      remembered per device), and nothing at all with nothing to show.
//   2. The main chat's news (frontend/src/features/messages/bot-news-line.tsx):
//      every message about a request is ONE short line, by its moment or its
//      kind; a line opens the request's thread, and one from before threads
//      opens in place; the bot's replies, offers and hellos stay messages.
//
// Run with: node --test tests/messages-bot-strip.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const STRIP = 'frontend/src/features/messages/bot-strip.tsx';
const NEWS = 'frontend/src/features/messages/bot-news-line.tsx';

globalThis.window = {
  App: { user: { id: 7, username: 'ada' } },
  location: { search: '', hash: '#messages/42' },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (fn) => fn(),
  setTimeout, clearTimeout,
};

const NOW = new Date('2026-10-09T12:00:00Z');
const ago = (minutes) => new Date(NOW.getTime() - minutes * 60000).toISOString();
const nowhere = { request: null, proposal: null, project: null };
let seq = 0;
const job = (extra = {}) => {
  seq += 1;
  return {
    key: `plant-pal#${extra.issueNumber || seq}`, appSlug: 'plant-pal', appName: 'Plant Pal', iconUrl: null, iconEmoji: null,
    issueNumber: seq, title: `Request ${seq}`, firstVersion: false, href: null, links: nowhere, earlier: [], ...extra,
  };
};
const working = (extra) => job({ phase: 'building', step: null, of: null, stepName: null, doing: null, since: null, ...extra });
const past = (extra) => job({ id: 1, outcome: 'live', doing: null, at: ago(60), ...extra });
const work = (extra) => ({ now: [], needsYou: [], history: [], ...extra });

function strip() { return loadTsx(STRIP); }
function draw(props) {
  const { BotStripView } = strip();
  return renderToHtml(createElement(BotStripView, { now: NOW, ...props }));
}

// ── 1. The strip ─────────────────────────────────────────────────────────

test('the groups, in order, each request once', () => {
  const { stripGroups } = strip();
  const asked = past({ title: 'Dinner rota', outcome: 'question', cardId: 31, ask: { messageId: 40, kind: 'question', question: 'Which night?' } });
  const stuck = past({ title: 'Print view', outcome: 'build_failed', ask: { messageId: 41, kind: 'build_failed' }, cardId: 32 });
  const quietStop = past({ title: 'Old stop', outcome: 'build_failed' });
  const ready = past({ title: 'Grey out', outcome: 'proposed', ready: { messageId: 50, sessionId: 9, epoch: 0, open: true, approve: true, waiting: null } });
  const building = working({ title: 'Totals', stage: 'building' });
  const held = working({ title: 'Held', stage: 'on_hold' });
  const live = past({ title: 'Went live', outcome: 'live', at: ago(50) });
  const oldLive = past({ title: 'Long ago', outcome: 'live', at: ago(60 * 30) });
  const model = stripGroups(work({
    now: [building, held],
    needsYou: [asked],
    history: [stuck, quietStop, ready, live, oldLive, { ...asked }],
  }), NOW);
  const titles = (rows) => rows.map((row) => row.job.title);
  assert.deepEqual(titles(model.needs), ['Dinner rota', 'Print view', 'Held'], 'a stop with an open ask needs them; one without does not');
  assert.deepEqual(titles(model.ready), ['Grey out']);
  assert.deepEqual(titles(model.progress), ['Totals'], 'on hold is not in progress');
  assert.deepEqual(titles(model.done), ['Went live'], 'done is the last day only');
  // The Needs you button opens the request's thread at what waits.
  assert.deepEqual([model.needs[0].rootId, model.needs[0].focusId], [31, 40]);
  assert.deepEqual(stripGroups(null), { needs: [], ready: [], progress: [], done: [] });
});

test('each row says one short thing: no step numbers, no timings', () => {
  const { needsRow, readyState, doingWord, stripTitle } = strip();
  const said = (extra) => needsRow(past(extra));
  assert.deepEqual(said({ outcome: 'question', ask: { messageId: 1, kind: 'question', question: 'Which night?' } }), { state: 'Which night?', action: 'messages:bot.strip.action.answer' });
  assert.equal(said({ outcome: 'question' }).state, 'Needs your answer');
  assert.deepEqual(said({ outcome: 'question', ask: { messageId: 1, kind: 'plan' } }), { state: 'Your plan is ready', action: 'messages:bot.strip.action.buildIt' });
  assert.deepEqual(said({ outcome: 'person', ask: { messageId: 1, kind: 'person' } }), { state: 'Needs your decision', action: 'messages:bot.strip.action.decide' });
  assert.deepEqual(said({ outcome: 'build_failed', stopCause: 'time' }), { state: 'Stopped: took too long', action: 'messages:bot.strip.action.tryAgain' });
  assert.equal(said({ outcome: 'build_failed' }).state, 'Stopped');
  assert.deepEqual(said({ outcome: 'blocked' }), { state: 'Can’t build it as written', action: 'messages:bot.strip.action.addDetail' });
  assert.deepEqual(said({ outcome: 'empty' }), { state: 'Nothing to build yet', action: 'messages:bot.strip.action.addDetail' });
  assert.deepEqual(said({ outcome: 'needs_look' }), { state: 'Needs a person to look', action: 'messages:bot.strip.action.open' });
  assert.equal(said({ outcome: 'stopped', ask: { messageId: 1, kind: 'checks' } }).state, 'Needs a person to look');
  assert.equal(needsRow(working({ stage: 'on_hold' })).state, 'On hold until Monday');
  assert.equal(said({ outcome: null, doing: 'waiting for its secrets' }).state, 'Waiting for its secrets');

  assert.equal(readyState(past({ outcome: 'proposed', ready: { approve: true } })), 'Ready for your yes');
  assert.equal(readyState(past({ outcome: 'proposed', ready: { approve: false, waiting: '@ada' } })), 'Waiting for @ada');
  assert.equal(readyState(past({ outcome: 'proposed' })), 'Waiting for approval');

  const words = (stage, phase = 'building') => doingWord(working({ stage, phase }));
  assert.deepEqual(
    [words('building'), words('planning'), words('reading', 'looking'), words('checks'), words('queued', 'queued'), words('revising', 'following_up'), words('merging', 'merging')],
    ['building', 'planning', 'reading', 'testing', 'in the queue', 'following up', 'going live'],
  );
  assert.equal(doingWord(working({ stage: null, phase: 'looking' })), 'reading', 'by its phase when no stage is said');

  assert.equal(stripTitle(job({ title: 'Dark mode', issueNumber: 4 })), 'Dark mode', 'no "Plant Pal #4:" prefix');
  assert.equal(stripTitle(job({ firstVersion: true, title: null })), 'Plant Pal, first version');
  assert.equal(stripTitle(job({ title: null, issueNumber: 9 })), 'Request #9');
});

test('a Needs you row has ONE button; a Ready row Try it and, when their yes counts, Approve', () => {
  const html = draw({
    work: work({
      needsYou: [past({ title: 'Dinner rota', outcome: 'question', cardId: 31, ask: { messageId: 40, kind: 'question', question: 'Which night?' } })],
      history: [
        past({ title: 'Grey out', outcome: 'proposed', ready: { messageId: 50, sessionId: 9, epoch: 0, open: true, approve: true, waiting: null } }),
        past({ title: 'Counts', outcome: 'proposed', ready: { messageId: null, sessionId: null, epoch: 0, open: true, approve: false, waiting: '@ada' } }),
      ],
    }),
  });
  const needs = html.slice(html.indexOf('data-bot-strip-group="needs"'), html.indexOf('data-bot-strip-group="ready"'));
  assert.equal((needs.match(/<button /g) || []).length, 1, 'one button on the row');
  assert.match(needs, /<button type="button" class="[^"]*bg-violet-600[^"]*" data-bot-strip-act="open">Answer<\/button>/);
  assert.match(needs, /Which night\?/);
  const ready = html.slice(html.indexOf('data-bot-strip-group="ready"'));
  assert.match(ready, /data-bot-strip-act="try">Try it<\/button><button type="button" class="[^"]*bg-violet-600[^"]*" data-bot-strip-act="approve">Approve<\/button>/);
  assert.equal((ready.match(/data-bot-strip-act="approve"/g) || []).length, 1, 'Approve only where their yes counts');
  assert.match(ready, /Waiting for @ada/);
  // Reused, not copied: the ready card's Try it and the vote endpoint it approves with.
  const source = read(STRIP);
  assert.match(source, /import \{ tryChange \} from '\.\/bot-ready';/);
  assert.match(source, /api\.approveChange\(sessionId, ready\?\.epoch \?\? null\)/);
  assert.match(source, /openThreadAt\(row\.rootId, row\.focusId\)/);
});

test('at most three Needs you and two Ready rows, then "+N more"; In progress is one line; Done a count', () => {
  const asks = Array.from({ length: 5 }, (_, i) => past({ title: `Ask ${i}`, outcome: 'question' }));
  const readies = Array.from({ length: 4 }, (_, i) => past({ title: `Ready ${i}`, outcome: 'proposed' }));
  const html = draw({
    work: work({
      needsYou: asks,
      history: [...readies, past({ title: 'Live one', outcome: 'live', at: ago(30) }), past({ title: 'Live two', outcome: 'going_live', at: ago(90) })],
      now: [working({ title: 'Show a total under the list', stage: 'building' }), working({ title: 'Add a search box', stage: 'planning' }),
        working({ title: 'C' }), working({ title: 'D' })],
    }),
  });
  assert.equal((html.match(/data-bot-strip-row="needs"/g) || []).length, 3);
  assert.match(html, /data-bot-strip-more="needs">\+2 more need you ›<\/button>/);
  assert.equal((html.match(/data-bot-strip-row="ready"/g) || []).length, 2);
  assert.match(html, /data-bot-strip-more="ready">\+2 more ready to try ›<\/button>/);
  assert.match(html, /data-bot-strip-group="progress">Show a total under the list \(building\), Add a search box \(planning\) \+2<\/p>/);
  assert.match(html, /aria-expanded="false" data-bot-strip-more="done">2 done today ›<\/button>/);
  assert.doesNotMatch(html, /data-bot-strip-row="done"/, 'Done opens into rows');
  assert.match(html, /5 need you<\/span>[\s\S]*4 ready to try[\s\S]*4 in progress[\s\S]*2 done today/);
});

test('the summary bar: zero parts left out, the need part in the need colour, and Hide', () => {
  const { summaryParts, stripGroups } = strip();
  const one = stripGroups(work({ needsYou: [past({ outcome: 'question' })], history: [past({ outcome: 'proposed' })] }), NOW);
  assert.deepEqual(summaryParts(one).map((part) => part.text), ['1 needs you', '1 ready to try']);
  const html = draw({ work: work({ needsYou: [past({ outcome: 'question' })], now: [working({})] }) });
  assert.match(html, /<section class="max-h-\[33vh\] [^"]*overflow-y-auto[^"]*" aria-label="Your requests" data-bot-strip="open">/);
  assert.match(html, /<span class="text-amber-700 dark:text-amber-400" data-bot-strip-count="needs">1 needs you<\/span><\/span><span><span aria-hidden="true"> · <\/span><span data-bot-strip-count="progress">1 in progress<\/span>/);
  assert.match(html, /aria-expanded="true" data-bot-strip-toggle="">Hide<\/button>/);
  assert.match(html, /NEEDS YOU|>Needs you</);
  assert.match(html, /class="[^"]*uppercase[^"]*text-amber-700[^"]*">Needs you</, 'its eyebrow in the need colour');
});

test('with nothing waiting on them the strip is its summary line; Hide is remembered; with nothing, nothing', () => {
  const quiet = draw({ work: work({ now: [working({})], history: [past({ outcome: 'live', at: ago(20) })] }) });
  assert.match(quiet, /data-bot-strip="closed"/);
  assert.match(quiet, /1 in progress[\s\S]*1 done today/);
  assert.match(quiet, /aria-expanded="false" data-bot-strip-toggle="">Show<\/button><\/div><\/section>$/, 'the summary line alone');
  const busy = work({ needsYou: [past({ outcome: 'question' })] });
  assert.match(draw({ work: busy }), /data-bot-strip="open"/);
  assert.match(draw({ work: busy, remembered: false }), /data-bot-strip="closed"/, 'Hide, remembered');
  assert.match(draw({ work: work({ now: [working({})] }), remembered: true }), /data-bot-strip="open"/, 'Show, remembered');
  assert.equal(draw({ work: work({}) }), '', 'nothing to show: nothing at all');
  assert.equal(draw({ work: null }), '', 'nothing until the first read');
  const { stripOpen } = strip();
  assert.equal(stripOpen({ needs: [], ready: [], progress: [1], done: [] }, null), false);
  // Remembered per device, in localStorage, never trusted to be there.
  const source = read(STRIP);
  assert.match(source, /try \{\s*const value = window\.localStorage\.getItem\(HIDDEN_KEY\);[\s\S]*?\} catch \{\s*return null;\s*\}/);
  assert.match(source, /try \{ window\.localStorage\.setItem\(HIDDEN_KEY, open \? '1' : '0'\); \} catch/);
});

test('the strip is pinned under the bot chat\'s header and its sub-line says what the bot is for', () => {
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /\{embedded \? null : <ThreadHeader \/>\}\s*(?:\{\/\*[^\n]*\*\/\}\s*)?\{botDm && !embedded \? <BotStrip \/> : null\}/);
  assert.doesNotMatch(screen, /BotWorkPanel|BotWorkButton|BotWorkStatusLine/);
});

// ── 2. The main chat's news ──────────────────────────────────────────────

const BOT = { id: 2, username: 'homeroom_bot', bot: true, displayName: 'Homeroom bot' };
let mid = 100;
function botMessage(meta, over = {}) {
  mid += 1;
  return {
    id: mid, conversationId: 42, sender: BOT, createdAt: ago(5), content: 'words', reply: null, reactions: [], attachments: [], objects: [],
    deleted: false, metadata: { homeroomBot: { appName: 'Plant Pal', appSlug: 'plant-pal', issueNumber: 4, issueTitle: 'Dark mode', ...meta } }, ...over,
  };
}
function line(message) {
  const { BotNewsLine } = loadTsx(NEWS);
  return renderToHtml(createElement(BotNewsLine, { message, full: () => createElement('p', null, 'FULL') }));
}

test('each kind of news says a few words after the request\'s title, in the need colour when it waits on them', () => {
  const cases = [
    [{ kind: 'question' }, 'needs your answer', true],
    [{ kind: 'followup_ask' }, 'needs your answer', true],
    [{ kind: 'plan' }, 'plan is ready', true],
    [{ kind: 'person' }, 'needs your decision', true],
    [{ kind: 'blocked' }, 'needs more detail', true],
    [{ kind: 'empty' }, 'needs more detail', true],
    [{ kind: 'proposal' }, 'is ready to try', false],
    [{ kind: 'build_failed' }, 'stopped', true],
    [{ kind: 'checks' }, 'stopped', true],
    [{ kind: 'needs_look' }, 'stopped', true],
    [{ kind: 'followup_failed' }, 'stopped', true],
    [{ kind: 'first_version_failed' }, 'stopped', true],
    [{ kind: 'allowance' }, 'is on hold until Monday', false],
    [{ kind: 'paused' }, 'is on hold until Monday', false],
    [{ kind: 'merged' }, 'is live', false],
    [{ kind: 'activity' }, 'I’ve started on it', false],
    // The moment it rang as wins over its kind.
    [{ kind: 'question', moment: 'needs_you', said: 'plan' }, 'plan is ready', true],
    [{ kind: 'note', moment: 'stopped', said: 'build_time' }, 'stopped', true],
    [{ kind: 'note', moment: 'live', said: 'live' }, 'is live', false],
    [{ kind: 'note', moment: 'ready', said: 'ready_group' }, 'is ready to try', false],
    [{ kind: 'note', moment: 'on_hold', said: 'allowance' }, 'is on hold until Monday', false],
  ];
  for (const [meta, words, need] of cases) {
    const html = line(botMessage(meta));
    const label = JSON.stringify(meta);
    assert.match(html, /<strong class="[^"]*">Dark mode<\/strong>/, label);
    assert.match(html, new RegExp(`<span class="${need ? 'text-amber-700 dark:text-amber-400' : 'text-zinc-600 dark:text-zinc-300'}" data-bot-news-words="">${words}</span>`), label);
  }
});

test('a line keeps the message\'s id and opens its thread; one from before threads opens in place', () => {
  const { newsThread, newsTitle } = loadTsx(NEWS);
  const moment = botMessage({ kind: 'question', requestTitle: 'Dinner rota', alsoInChat: true, threadRootId: 31 }, { threadRootId: 31 });
  const html = line(moment);
  assert.match(html, new RegExp(`^<article id="messages-message-${moment.id}" data-message-id="${moment.id}" class="messages-bot-news px-4 py-1" data-bot-news="question">`));
  assert.match(html, /data-bot-news-open="thread"/);
  assert.match(html, />Dinner rota<\/strong>/, 'the request\'s own title first');
  assert.equal(newsThread(moment), 31);
  // A card with its thread opens that thread, and says how many updates it holds.
  const card = botMessage({ kind: 'activity' }, { thread: { replyCount: 5, lastReplyAt: null, participants: [], lastReply: null } });
  assert.equal(newsThread(card), card.id);
  assert.match(line(card), /I’ve started on it<\/span> <span class="text-violet-700 dark:text-violet-300" data-bot-thread-link="\d+">· 5 updates ›<\/span>/);
  // An old card, from before threads: no thread to open, so it opens in place.
  const old = botMessage({ kind: 'proposal' });
  assert.equal(newsThread(old), null);
  assert.match(line(old), /aria-expanded="false" data-bot-news-open="inline"/);
  const source = read(NEWS);
  assert.match(source, /if \(open\) return <>\{full\(\)\}<\/>;/, 'opened, it is the whole message as it was drawn');
  assert.match(source, /if \(rootId\) openThreadAt\(rootId, message\.threadRootId \? message\.id : null\);\s*else setOpen\(true\);/);
  assert.equal(newsTitle({ kind: 'merged', appName: 'Plant Pal', issueNumber: 1, firstVersion: true }), 'Plant Pal, first version');
  assert.equal(newsTitle({ kind: 'merged', appName: 'Plant Pal', issueNumber: 9 }), 'Request #9');
});

test('the bot\'s replies, offers, hellos and words about no request stay messages', () => {
  const { isBotNews } = loadTsx(NEWS);
  assert.equal(isBotNews(botMessage({ kind: 'question' })), true);
  assert.equal(isBotNews(botMessage({ kind: 'activity', issueNumber: undefined })), true, 'a card is news');
  assert.equal(isBotNews(botMessage({ kind: 'merged', issueNumber: 1, firstVersion: true })), true);
  for (const kind of ['chat', 'ack', 'reply', 'confirm', 'hello', 'welcome']) {
    assert.equal(isBotNews(botMessage({ kind })), false, kind);
  }
  assert.equal(isBotNews(botMessage({ kind: 'question', moment: 'reply' })), false, 'a reply is a reply');
  assert.equal(isBotNews(botMessage({ kind: 'note', issueNumber: undefined })), false, 'about no request');
  assert.equal(isBotNews({ ...botMessage({ kind: 'question' }), sender: { id: 7, username: 'ada' } }), false, 'the person\'s own messages are theirs');
  assert.equal(isBotNews(botMessage({ kind: 'question' }, { deleted: true })), false);
  // The transcript asks for the line in the bot's chat alone, before any other row.
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /if \(botDm && isBotNews\(message\)\) \{\s*rows\.push\(<BotNewsLine/);
});

test('the thread pane opens at the message a Needs you button names, and flashes it', () => {
  const store = read('frontend/src/features/messages/store.ts');
  assert.match(store, /export function openThreadAt\(rootId: number \| null \| undefined, focusId: number \| null \| undefined = null\): void \{/);
  assert.match(store, /publish\(\{ threadFocusId: validId\(focusId\) && focusId !== rootId \? focusId : null \}\);\s*openThread\(rootId\);/);
  const screen = read('frontend/src/features/messages/index.tsx');
  const pane = screen.slice(screen.indexOf('function ReplyThreadPanel()'), screen.indexOf('function AppReplyThreadPanel('));
  assert.match(pane, /const wanted = snap\.threadFocusId \|\| snap\.route\.focusMessageId \|\| null;/);
  assert.match(pane, /el\.querySelector<HTMLElement>\(`\[id="messages-message-\$\{wanted\}"\]`\)/, 'its own row, not the line in the chat beside it');
  assert.match(pane, /focused=\{flashId === message\.id\}/);
});
