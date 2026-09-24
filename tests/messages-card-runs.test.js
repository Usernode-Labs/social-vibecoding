'use strict';

// Three Messages fixes filed together by the platform admin:
//
//   #2884 — a channel that is mostly cards (proposals put up, merged, shared)
//           folds a run of three or more consecutive cards into the first one
//           and a "… N more" row that expands the rest in place. A plain
//           message between two cards breaks the run.
//   #2882 — the composer has one outline, the card's: the field inside it
//           draws no edge of its own in any engine.
//   #2883 — on a desktop the transcript reads one step down the existing
//           type scale (17 → 15, 15 → 13); the phone keeps its reading size.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const CSS = read('public/css/app.css');
const RUNS = 'frontend/src/lib/card-runs.ts';
const TRANSCRIPT = 'frontend/src/features/group-chat/transcript.tsx';

// ── The rule ──────────────────────────────────────────────────────────

test('three or more cards in a row are a run; two are not', () => {
  const { cardRunStarts, CARD_RUN_MIN } = loadTsx(RUNS);
  assert.equal(CARD_RUN_MIN, 3);
  const isCard = (c) => c === 'c';
  const runs = (s) => Object.fromEntries(cardRunStarts([...s], isCard));
  assert.deepEqual(runs('ccc'), { 0: 3 });
  assert.deepEqual(runs('cc'), {}, 'two cards are just two cards');
  assert.deepEqual(runs('mcccccm'), { 1: 5 });
  assert.deepEqual(runs('cccmccc'), { 0: 3, 4: 3 }, 'a plain message between cards breaks the run');
  assert.deepEqual(runs('ccmcc'), {}, 'and what is left on each side is too short to fold');
  assert.deepEqual(runs(''), {});
});

test('the caller can break a run on something that is not a row, such as a day divider', () => {
  const { cardRunStarts } = loadTsx(RUNS);
  const items = [{ day: 1 }, { day: 1 }, { day: 2 }, { day: 2 }, { day: 2 }];
  const runs = cardRunStarts(items, () => true, (a, b) => a.day === b.day);
  assert.deepEqual(Object.fromEntries(runs), { 2: 3 });
});

test('the folded row says how many it holds', () => {
  const { cardRunLabel } = loadTsx(RUNS);
  assert.equal(cardRunLabel(4), '… 4 more');
});

// ── An app's channel: the group-chat transcript ───────────────────────

const base = {
  kind: 'system', username: '', time: '09:05 AM', timeTitle: 'Sep 16, 2026, 09:05 AM',
  bodyHtml: '', systemText: 'a notice', mine: false, editedTitle: null, unread: false,
  bookmarked: false, canEdit: false, flash: false, showEdit: false, showBookmark: false,
  showReact: false, quote: null, reactions: [], attachments: [], voteRowClass: '',
  voteRef: null, specShare: null, event: null, eventHref: null,
};
let seq = 500;
const icon = { tint: 'bg-sky-500/15 text-sky-700 dark:text-sky-400', path: 'M14 10h4', small: true };
const card = () => ({
  ...base, id: (seq += 1), kind: 'vote', votePhase: 'settled',
  event: { type: 'submitted', sessionId: '5', prNumber: String(seq), title: 'A change', actor: 'evan', sender: 'evan', mine: false, force: false, votes: '', icon },
});
const human = (text) => ({ ...base, id: (seq += 1), kind: 'message', username: 'alice', bodyHtml: `<p>${text}</p>` });
const lead = { earlier: false, placeholder: null };
const rows = (messages, foldCards) => renderToHtml(createElement(loadTsx(TRANSCRIPT).TranscriptRows, { view: { messages, lead }, source: 'main', foldCards }));
const eventIds = (html) => [...html.matchAll(/gc-event" data-msg-id="(\d+)"/g)].map((m) => Number(m[1]));

test('a Messages channel draws a run of cards as the first and a "… N more" row', () => {
  const messages = [card(), card(), card(), card()];
  const html = rows(messages, true);
  assert.deepEqual(eventIds(html), [messages[0].id], 'only the first card of the run');
  assert.match(html, new RegExp(`data-msg-id="${messages[0].id}"[\\s\\S]*</div><div class="gc-card-run"><button type="button" class="gc-card-run-more" data-card-run-more="3" aria-expanded="false" aria-label="Show 3 more cards">… 3 more</button></div>$`));
});

test('a person saying something between the cards breaks the run', () => {
  const messages = [card(), card(), human('what do we think?'), card(), card(), card()];
  const html = rows(messages, true);
  assert.deepEqual(eventIds(html), [messages[0].id, messages[1].id, messages[3].id]);
  assert.match(html, /what do we think\?/);
  assert.equal((html.match(/data-card-run-more="2"/g) || []).length, 1);
});

test('the app\'s own Discussion page, and a topic thread, still draw every card', () => {
  const messages = [card(), card(), card()];
  assert.deepEqual(eventIds(rows(messages, false)), messages.map((m) => m.id));
  assert.doesNotMatch(rows(messages, false), /gc-card-run/);
  const thread = renderToHtml(createElement(loadTsx(TRANSCRIPT).TranscriptRows, { view: { messages, lead }, source: 'thread', foldCards: true }));
  assert.doesNotMatch(thread, /gc-card-run/);
});

test('the channel transcript is told it is a channel by where it is mounted', () => {
  const mount = read('frontend/src/features/group-chat/mount.ts');
  assert.match(mount, /const channel = !!host\.closest\('#messages-screen'\);\s*\n\s*mountLegacyPortal\(host, createElement\(Transcript, \{ source: key, foldCards: channel \}\)\);/);
});

// ── A conversation: #general, a group, a DM ───────────────────────────

test('a conversation folds messages that are only a shared item, never ones a person wrote in', () => {
  const src = read('frontend/src/features/messages/index.tsx');
  const fn = src.slice(src.indexOf('function isCardMessage'), src.indexOf('function dayKey'));
  assert.match(fn, /message\.objects\.length > 0 && !message\.content && !message\.attachments\.length\s*\n\s*&& !message\.reply && !message\.pending && !message\.failed/);
  assert.match(src, /cardRunStarts\(snap\.messages, isCardMessage, \(a, b\) => dayKey\(a\) === dayKey\(b\)\)/, 'a day divider breaks a run');
  assert.match(src, /className="messages-card-run-more"\s*\n\s*data-card-run-more=\{hidden\}/);
});

test('the #general demo carries a run of four cards for the declared check', () => {
  const src = read('src/routes/conversations.js');
  for (const id of [9100406, 9100407, 9100408, 9100409]) assert.match(src, new RegExp(`\\[${id}, \\d+, '`));
});

// ── #2882 / #2883: the stylesheet ─────────────────────────────────────

function rule(selector, from = 0) {
  const i = CSS.indexOf(`\n${selector} {`, from);
  assert.ok(i >= 0, `expected a \`${selector}\` rule in app.css`);
  return CSS.slice(i, CSS.indexOf('\n}', i));
}

test('#2882: neither composer field draws an edge of its own; the card keeps its ring', () => {
  for (const selector of ['.messages-composer-input', '.gc-composer-card .gc-composer-input']) {
    const body = rule(selector);
    assert.match(body, /-webkit-appearance: none;\s*\n\s*appearance: none;\s*\n\s*box-shadow: none;/, `${selector} resets the native box`);
    assert.match(body, /-webkit-tap-highlight-color: transparent;/);
  }
  assert.match(rule('.messages-composer-input'), /\n\s*outline: none;/);
  assert.match(rule('.messages-composer-card:focus-within'), /0 0 0 2px var\(--accent\)/, 'the outer outline stays');
});

test('#2883: from 768px up the transcript steps down the existing scale, and the phone keeps 17px', () => {
  const at = CSS.indexOf('#2883: THE TRANSCRIPT READS ONE STEP DOWN');
  assert.ok(at >= 0);
  const block = CSS.slice(CSS.indexOf('@media (min-width: 768px) {', at), CSS.indexOf('\n}\n', at));
  assert.match(block, /\.messages-message-head \{ min-height: 20px; font-size: 15px; \}/);
  assert.match(block, /\.messages-message-head time ~ span \{ font-size: 13px; \}/);
  assert.match(block, /\.messages-markdown\.gc-msg-content \{ font-size: 15px; line-height: 1\.4; \}/);
  assert.match(block, /\.messages-composer-input \{ font-size: 15px; \}/);
  assert.match(block, /\.messages-edit textarea \{ font-size: 15px; \}/);
  for (const size of block.match(/font-size: \d+px/g)) assert.match(size, /font-size: (15|13)px/, 'nothing off the scale');
  assert.match(rule('.messages-markdown.gc-msg-content'), /font-size: 17px;/, 'the phone keeps its reading size');
});
