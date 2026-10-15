'use strict';

// #4212 and #4241: a request's number on its card, and its `#N` chip as a
// way to that card.
//
//   1. A request's card says which request it is ("Request #51"), so the
//      bot's "RecipeBot #51" reads as the card under it. Other cards keep
//      their kind alone.
//   2. A chip finds the card its request already has in the conversation:
//      a shared or head card by its link, the activity card by
//      `data-bot-activity-request`, the nearest one above, else below, and
//      only in its own pane.
//   3. With none there, it opens the request's card under the message; a
//      second press folds it; a modified click is the browser's.
//
// Run with: node --test tests/messages-ref-chip-cards.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── 1. The number on the card ───────────────────────────────────────────

test('#4212: a request’s card names its number; other cards their kind', () => {
  const { ObjectCard, objectEyebrow } = loadTsx('frontend/src/features/messages/format.tsx');
  assert.equal(objectEyebrow({ type: 'issue', issueNumber: 51 }), 'Request #51');
  assert.equal(objectEyebrow({ type: 'issue' }), 'Request', 'no number, no "#"');
  assert.equal(objectEyebrow({ type: 'proposal', issueNumber: 51 }), 'Change');
  const html = renderToHtml(createElement(ObjectCard, { object: {
    type: 'issue', available: true, appSlug: 'recipebot', issueNumber: 51,
    title: 'Prefill new recipe with search text', subtitle: 'RecipeBot', state: 'open',
    href: '#app/recipebot/dev/issues/51',
  } }));
  assert.match(html, />Request #51<\/div><div class="text-base font-semibold[^"]*">Prefill new recipe with search text</);
  assert.match(html, /RecipeBot · open/);
});

test('#4241: the activity card names its request for a chip to find (not a first version’s)', () => {
  const source = read('frontend/src/features/messages/bot-activity.tsx');
  assert.match(source, /data-bot-activity-request=\{meta\.appSlug && meta\.issueNumber && !meta\.firstVersion \? `\$\{meta\.appSlug\}#\$\{meta\.issueNumber\}` : undefined\}/);
});

// ── 2. Finding the card ─────────────────────────────────────────────────

// A transcript in document order, just big enough for findRequestCard.
function transcript(specs) {
  const doc = {};
  const els = [];
  const pane = (name) => ({ name, querySelectorAll: () => els.filter((el) => el.pane === name && el.card) });
  const panes = { main: pane('main'), thread: pane('thread') };
  doc.querySelectorAll = () => els.filter((el) => el.card);
  for (const [i, spec] of specs.entries()) {
    const el = {
      ...spec,
      order: i,
      ownerDocument: doc,
      getAttribute: (name) => (spec.attrs || {})[name] ?? null,
      matches: (sel) => sel === 'a.messages-object-card' && spec.card === 'object',
      closest: (sel) => (sel === '.messages-thread-scroll' && spec.pane ? panes[spec.pane] : null),
      compareDocumentPosition: (other) => (other.order > i ? 4 : 2),
    };
    els.push(el);
  }
  return els;
}

test('a chip goes to its request’s card: its link or the activity card’s name, nearest above, else below', () => {
  globalThis.Node = { DOCUMENT_POSITION_FOLLOWING: 4 };
  const { findRequestCard } = loadTsx('frontend/src/features/messages/ref-cards.tsx');
  const href = '#app/recipebot/dev/issues/7';
  const els = transcript([
    { id: 'old', card: 'object', attrs: { href } },
    { id: 'other', card: 'object', attrs: { href: '#app/recipebot/dev/issues/8' } },
    { id: 'activity', card: 'activity', attrs: { 'data-bot-activity-request': 'recipebot#7' } },
    { id: 'elsewhere', card: 'object', attrs: { href: '#app/another/dev/issues/7' } },
    { id: 'chip' },
    { id: 'after', card: 'object', attrs: { href } },
  ]);
  const chip = els.find((el) => el.id === 'chip');
  assert.equal(findRequestCard(chip, 'recipebot', 7).id, 'activity', 'the nearest above');
  assert.equal(findRequestCard(chip, 'recipebot', 8).id, 'other');
  assert.equal(findRequestCard(chip, 'recipebot', 9), null, 'none loaded');
  assert.equal(findRequestCard(chip, 'another', 7).id, 'elsewhere', 'by project as well as number');

  const first = transcript([{ id: 'chip' }, { id: 'below', card: 'object', attrs: { href } }, { id: 'further', card: 'object', attrs: { href } }]);
  assert.equal(findRequestCard(first[0], 'recipebot', 7).id, 'below', 'else the first below');

  const panes = transcript([
    { id: 'main-card', card: 'object', pane: 'main', attrs: { href } },
    { id: 'chip', pane: 'thread' },
  ]);
  assert.equal(findRequestCard(panes[1], 'recipebot', 7), null, 'a thread pane searches itself');
});

// ── 3. The press ────────────────────────────────────────────────────────

test('a chip press: the card nearby, else one under the message, folded by a second press', () => {
  const format = read('frontend/src/features/messages/format.tsx');
  const fn = format.slice(format.indexOf('export function MessageMarkdown('), format.indexOf('\n}\n', format.indexOf('export function MessageMarkdown(')));
  assert.match(fn, /const native = event\.defaultPrevented \|\| event\.button !== 0 \|\| event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey;/);
  assert.match(fn, /if \(appSlug && chip\.matches\('\.gc-ref-issue'\) && Number\.isInteger\(n\) && n > 0 && !native\) \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*event\.preventDefault\(\);/);
  assert.match(fn, /if \(opened\.includes\(n\)\) \{ setOpened\(\(list\) => list\.filter\(\(x\) => x !== n\)\); return; \}/);
  assert.match(fn, /const card = findRequestCard\(chip, appSlug, n\);\s*if \(card\) revealCard\(card\);\s*else setOpened/);
  assert.match(fn, /return appSlug && opened\.length \? <>\{body\}<RefCards appSlug=\{appSlug\} numbers=\{opened\} \/><\/> : body;/);
});

test('the card opened under a message: the server’s reading, else the request by its number', () => {
  let answered = false;
  let answer = null;
  const { RefCards } = loadTsx('frontend/src/features/messages/ref-cards.tsx', {
    stubs: {
      './link-cards': {
        useLinkCards: (links) => (answer ? [{ link: links[0], card: answer }] : []),
        linkCardAnswered: () => answered,
      },
    },
  });
  const draw = () => renderToHtml(createElement(RefCards, { appSlug: 'recipebot', numbers: [7] }));
  let html = draw();
  assert.match(html, /<div class="messages-object-list mt-1 max-w-\[480px\]" data-ref-cards=""><div data-ref-card="7" aria-busy="true"><a href="#app\/recipebot\/dev\/issues\/7" class="messages-object-card"/);
  assert.match(html, />Request #7<\/div><div[^>]*>Loading…</);
  answered = true;
  assert.match(draw(), />Open this request</, 'one this reader cannot see still opens its page');
  answer = { type: 'issue', available: true, issueNumber: 7, title: 'Dark mode', subtitle: 'RecipeBot', state: 'open', author: 'ada', href: '#elsewhere' };
  html = draw();
  assert.match(html, />Request #7<\/div><div[^>]*>Dark mode</);
  assert.match(html, /href="#app\/recipebot\/dev\/issues\/7"/);
  assert.doesNotMatch(html, /by ada|· open|aria-busy/);
});

test('a found card is scrolled to and its message flashed, as a linked message is', () => {
  const source = read('frontend/src/features/messages/ref-cards.tsx');
  assert.match(source, /const FLASH_MS = 2400;/);
  assert.match(read('public/css/app.css'), /\.messages-message-focus \{ animation: messages-focus-flash 2\.4s ease-out; \}/);
  assert.match(source, /lit\.classList\.add\('messages-message-focus'\);/);
});
