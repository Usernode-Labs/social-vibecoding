'use strict';

// #4097: a Homeroom bot message about a request shows the request as a card,
// not as the line that names it.
//
// The bot's news about a request opens "**Todo List** · request #93: Only
// close category when last item is checked", then a blank line and what it
// has to say (services/homeroom-bot-dm.js requestLine). The transcript drew
// that line as bold text and a `#93` chip. Pinned here:
//
//   1. Which messages open with the line: the bot's, about the request its
//      metadata names, never a first version and never a lookalike. The
//      server's own line parses, so a change to its shape fails here.
//   2. The card, from the best source there is: the request's card the
//      message carries, else the server's reading for this reader, else the
//      line's own project and title. No "by" and no status (a request whose
//      change went live is GitHub's "closed"), and no fetch it does not need.
//   3. Where it is drawn: in the row in place of the line, the card not drawn
//      again under the words, and in the two-questions card's lead.
//
// Run with: node --test tests/messages-bot-request-card.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const HEAD = 'frontend/src/features/messages/bot-request-head.tsx';

// What useLinkCards was asked for, and what it answers: a stand-in for the
// server's reading (tests/messages-link-embeds.test.js pins the real one).
let asked = [];
let answer = null;
const { requestHead, isHeadCard, RequestHeadWords } = loadTsx(HEAD, {
  stubs: {
    './link-cards': {
      useLinkCards: (links) => {
        asked.push(links.map((link) => link.key));
        return links.length && answer ? [{ link: links[0], card: answer }] : [];
      },
    },
  },
});

const META = { kind: 'build_failed', appSlug: 'todo-list-b91765', appName: 'Todo List', issueNumber: 93, issueTitle: 'Only close category when last item is checked' };
const LINE = '**Todo List** · request #93: Only close category when last item is checked';
const WORDS = 'I couldn\'t finish building this: it took longer than I\'m allowed. Reply here and I\'ll try again.';

// ── 1. Which messages open with the line ────────────────────────────────

test('the bot’s line about the request its metadata names splits from the words after it', () => {
  const head = requestHead(`${LINE}\n\n${WORDS}`, META);
  assert.deepEqual({ ...head, link: head.link && { key: head.link.key, href: head.link.href } }, {
    link: { key: 'issue:todo-list-b91765:93', href: '#app/todo-list-b91765/dev/issues/93' },
    appSlug: 'todo-list-b91765',
    appName: 'Todo List',
    issueNumber: 93,
    title: 'Only close category when last item is checked',
    rest: WORDS,
  });
  assert.equal(requestHead(LINE, META).rest, '', 'a line with nothing after it');
  assert.equal(requestHead(`**Todo List** · request #93\n\n${WORDS}`, { ...META, issueTitle: undefined }).title, null,
    'a request with no title');
  assert.equal(requestHead(`**Todo List** · request #93: Clipped at the li…\n\nx`, { ...META, issueTitle: undefined }).title,
    'Clipped at the li…', 'the line’s title when the metadata has none');
  const demo = requestHead(`${LINE}\n\n${WORDS}`, { ...META, appSlug: undefined });
  assert.equal(demo.link, null, 'a message that names no project (the staging demo) has no page to open');
  assert.equal(demo.appSlug, null);
});

test('nothing else is a request line', () => {
  const text = `${LINE}\n\n${WORDS}`;
  assert.equal(requestHead(text, null), null, 'a person’s message (botMeta is null for any sender but the bot)');
  assert.equal(requestHead(text, { ...META, issueNumber: 94 }), null, 'a line about another request');
  assert.equal(requestHead(text, { ...META, issueNumber: undefined }), null);
  assert.equal(requestHead(text, { ...META, firstVersion: true }), null, 'a first version has no request line');
  assert.equal(requestHead(`Here it is.\n\n${text}`, META), null, 'only the line the message opens with');
  assert.equal(requestHead(`I looked at **Todo List** · request #93 again.\n\n${WORDS}`, META), null);
  assert.equal(requestHead('**Todo List**, its first version\n\nBuilding it now.', META), null);
  assert.equal(requestHead('', META), null);
});

test('the server’s own request line parses, in the news the bot sends', () => {
  const dm = require('../src/services/homeroom-bot-dm');
  const context = { appName: 'Todo List', issueNumber: 93, issueTitle: META.issueTitle };
  const said = dm.dmText('build_failed', { reason: 'the build ran past its time limit' }, context);
  const head = requestHead(said, META);
  assert.ok(head, said);
  assert.equal(head.title, META.issueTitle);
  assert.equal(`${dm.requestLine(context)}\n\n${head.rest}`, said, 'the words are everything after the line');
  assert.doesNotMatch(head.rest, /request #93/);
  assert.ok(requestHead(dm.requestLine({ ...context, issueTitle: null }), { ...META, issueTitle: undefined }),
    'and the line with no title');
  assert.equal(requestHead(dm.requestLine({ ...context, firstVersion: true }), META), null);
});

// ── 2. The card ─────────────────────────────────────────────────────────

const draw = (head, objects = []) => {
  asked = [];
  return renderToHtml(createElement(RequestHeadWords, { head, objects }));
};

test('the card the message carries is the card, and nothing is fetched for it', () => {
  answer = { type: 'issue', available: true, title: 'Read title', subtitle: 'Todo List', state: 'open' };
  const head = requestHead(`${LINE}\n\n${WORDS}`, META);
  const carried = {
    type: 'issue', available: true, appSlug: 'todo-list-b91765', issueNumber: 93,
    title: 'Only close a category when its last item is checked', subtitle: 'Todo List', state: 'closed', author: 'usernode-bot',
    href: '#app/todo-list-b91765/dev/issues/93',
  };
  const html = draw(head, [carried]);
  assert.deepEqual(asked, [[]], 'no link asked for');
  assert.match(html, /^<div class="mb-1\.5 mt-1 max-w-\[480px\]" data-bot-request-card="93"><a href="#app\/todo-list-b91765\/dev\/issues\/93" class="messages-object-card"/,
    'the card leads, linking the request');
  assert.match(html, />Request</);
  assert.match(html, /Only close a category when its last item is checked/);
  assert.match(html, />Todo List</, 'its project alone');
  assert.doesNotMatch(html, /closed|by usernode-bot|request #93|#93</,
    'no status (a live request is GitHub\'s "closed", which read as turned down), no "by", and no line');
  assert.ok(html.indexOf('messages-object-card') < html.indexOf('messages-markdown'), 'then the words');
  assert.match(html, /<div class="messages-markdown gc-msg-content">I couldn't finish building this/);
  assert.equal(isHeadCard(head, carried), true, 'which the row then leaves out from under the words');
  assert.equal(isHeadCard(head, { ...carried, issueNumber: 94 }), false);
  assert.equal(isHeadCard(head, { type: 'proposal', appSlug: 'todo-list-b91765', sessionId: 93 }), false, 'a change’s card stays');
});

test('else the server’s reading of the request for this reader; until it comes, the line’s own', () => {
  const head = requestHead(`${LINE}\n\n${WORDS}`, META);
  answer = { type: 'issue', available: true, title: 'Renamed since', subtitle: 'Todo List', state: 'open', author: 'usernode-bot', href: '#elsewhere' };
  let html = draw(head, [{ type: 'issue', available: false }]);
  assert.deepEqual(asked, [['issue:todo-list-b91765:93']], 'the request’s link, asked once');
  assert.match(html, /Renamed since/);
  assert.match(html, />Todo List</);
  assert.match(html, /<a href="#app\/todo-list-b91765\/dev\/issues\/93"/, 'the request’s page, not the answer’s address');
  assert.doesNotMatch(html, /usernode-bot|· open/);

  answer = null;
  html = draw(head);
  assert.match(html, /Only close category when last item is checked/, 'the title the bot knew');
  assert.match(html, />Todo List</, 'its project');
  assert.match(html, /<a href="#app\/todo-list-b91765\/dev\/issues\/93" class="messages-object-card"/);
  assert.doesNotMatch(html, /Unavailable/);
});

test('a message that names no project draws the card without a link and asks nothing', () => {
  answer = { type: 'issue', available: true, title: 'Never asked' };
  const html = draw(requestHead(`**Staging demo app** · request #12\n\n${WORDS}`, { kind: 'question', appName: 'Staging demo app', issueNumber: 12 }));
  assert.deepEqual(asked, [[]]);
  assert.match(html, /<div class="messages-object-card"><span class="messages-object-icon">#<\/span>/, 'a card, not a link');
  assert.match(html, /Request #12/, 'named by its number when it has no title');
  assert.match(html, />Staging demo app</);
  assert.doesNotMatch(html, /Never asked|href=/);
});

test('a line with nothing after it is the card alone', () => {
  answer = null;
  assert.doesNotMatch(draw(requestHead(LINE, META)), /messages-markdown/);
});

// ── 3. Where it is drawn ────────────────────────────────────────────────

test('the row draws the card in place of the line, and not again under the words', () => {
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /import \{ RequestHeadWords, isHeadCard, requestHead \} from '\.\/bot-request-head';/);
  assert.match(row, /const head = requestHead\(message\.content, botMeta\(message\)\);/,
    'only the bot’s own messages (botMeta reads it off a bot sender only)');
  assert.match(row, /const objects = head \? message\.objects\.filter\(\(object\) => !isHeadCard\(head, object\)\) : message\.objects;/);
  assert.match(row, /\? <RequestHeadWords head=\{head\} objects=\{message\.objects\} channels=\{channels\} \/>/);
  assert.match(row, /\{objects\.length \? <div className="messages-object-list">\{objects\.map\(/);
  assert.doesNotMatch(row, /message\.objects\.map\(/);
});

test('the two-questions card leads with the request’s card too', () => {
  const plan = read('frontend/src/features/messages/bot-plan.tsx');
  assert.match(plan, /const head = meta\.lead \? requestHead\(meta\.lead, meta\) : null;/);
  assert.match(plan, /\{head \? <RequestHeadWords head=\{head\} objects=\{message\.objects\} \/>\s*: meta\.lead \? <MessageMarkdown content=\{meta\.lead\} appSlug=\{meta\.appSlug\} \/> : null\}/);
});

test('the staging preview’s declared check finds the card on the demo DM’s question, followed by its words', () => {
  const check = JSON.parse(read('dapp.json')).tests.find((t) => /^#4097:/.test(t.name));
  assert.ok(check, 'declared');
  assert.equal(check.path, '/?demo=1#messages/910005');
  assert.match(check.expectSelector, /\[data-bot-request-card="12"\]:has\(> \.messages-object-card \.messages-object-icon\) \+ \.messages-markdown$/);
  assert.ok(check.expectSelector.length <= 256, 'within what the runner reads');
  // The fixture it reads (services/staging-messages.js ensureBotDmFixture):
  // the question about request #12, which names no project slug.
  const fixture = read('src/services/staging-messages.js');
  const line = '**Staging demo app** · request #12: Staging demo, sort the list by date';
  assert.ok(fixture.includes(`content: '${line}\\n\\n'`), 'the question opens with the request line');
  const head = requestHead(`${line}\n\nI have a question before I build this:\n\nShould the newest items show first, or the oldest?`,
    { kind: 'question', appName: 'Staging demo app', issueNumber: 12, issueTitle: 'Staging demo, sort the list by date' });
  assert.equal(head.title, check.expectText);
  assert.equal(head.link, null);
});
