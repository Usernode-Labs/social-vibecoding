'use strict';

// #7232: a project's Discussion reads in the reader's language, as Messages
// does. A post or a reply by somebody else, written in another language, is
// drawn translated with the line under it that says where it came from and
// offers the way back; your own words, Homeroom bot's and a visitor's stay
// as written.
//
//   frontend/src/features/dev-board/workshop/hub-discussion.tsx  the words, and who may translate them
//   frontend/src/features/messages/translate.tsx                  the ask and the line (tests/translate-toggle.test.js)
//
// What this pins:
//   1. THE WORDS swap to the translation while it is shown, in the post's
//      own markdown (line breaks kept), and the line says "Translated from
//      …" with Show original; Show translation brings the original back.
//   2. NO TRANSLATION, no line: the words stay as written and nothing is
//      added under them, and a reply only ever takes its own translation.
//   3. WHO MAY: somebody else's words, by a person, that are still there and
//      have text in them, for a reader who is signed in and not a visitor.
//   4. THE WIRING: the row asks as it comes into view, and the ⋯ menu is
//      offered Translate.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CARD = 'frontend/src/features/dev-board/workshop/hub-discussion.tsx';

const SINCE = '2026-11-26T02:03:00.000Z';
const card = loadTsx(CARD);

const said = (over = {}) => ({
  id: 1,
  who: { id: 2, username: 'nisarena1' },
  content: 'Pagi semua, udah jumat nih',
  at: SINCE,
  deleted: false,
  reactions: [],
  files: 0,
  attachments: [],
  cards: [],
  spec: null,
  rootId: null,
  replyCount: 0,
  lastReplyAt: null,
  ...over,
});

const view = (state, over = {}) => ({
  state,
  texts: state === 'shown' ? ['Morning everyone, it is Friday already'] : ['Pagi semua, udah jumat nih'],
  from: state === 'shown' ? 'id' : null,
  origin: 'auto',
  ask() {},
  askAuto: () => true,
  toggle() {},
  ...over,
});

/** One message's words, under the translation its row would hand them. */
const render = (message, translation, className = 'dh-words') => renderToHtml(createElement(
  card.TranslationContext.Provider,
  { value: translation ? { id: message.id, view: translation } : null },
  createElement(card.Words, { said: message, className }),
));

test('a post written in another language is drawn in the reader’s, with the line under it', () => {
  const post = said();
  const shown = render(post, view('shown'));
  assert.match(shown, /class="dh-words"[\s\S]*Morning everyone, it is Friday already/);
  assert.doesNotMatch(shown, /Pagi semua/, 'the words it replaced are not drawn');
  assert.match(shown, /Translated from Indonesian/);
  assert.match(shown, /Show original/);

  // Show original: the author's own words, and the way back.
  const original = render(post, view('original'));
  assert.match(original, /Pagi semua, udah jumat nih/);
  assert.doesNotMatch(original, /Morning everyone/);
  assert.match(original, /Show translation/);

  // Nothing to show (not asked, still the same language, or it failed): the
  // words stay as written and no line is added.
  for (const state of ['idle', 'same', 'failed']) {
    const quiet = render(post, view(state));
    assert.match(quiet, /Pagi semua, udah jumat nih/, state);
    assert.doesNotMatch(quiet, /Show original|Show translation/, state);
  }
  const bare = render(post, null);
  assert.match(bare, /^<div class="dh-words">/, 'a row with no translation to hand draws its words alone');
  assert.match(bare, /Pagi semua, udah jumat nih/);
  assert.doesNotMatch(bare, /Translated|Show original/);
});

test('the translated words keep the author’s line breaks, as the post’s own do', () => {
  const post = said({ content: 'Baris satu\nBaris dua' });
  const html = render(post, view('shown', { texts: ['Line one\nLine two'] }));
  assert.match(html, /Line one<br>Line two/);
  assert.doesNotMatch(html, /Baris satu/);
});

test('a reply takes its own translation, never its post’s', () => {
  const reply = said({ id: 7, rootId: 1, content: 'Gas! Aku main jam 8 malam.' });
  const html = render(reply, view('shown', { texts: ['Let’s go! I’ll play at 8 tonight.'] }), 'dh-reply-words');
  assert.match(html, /class="dh-reply-words"[\s\S]*Let’s go! I’ll play at 8 tonight\./);
  assert.match(html, /Translated from Indonesian[\s\S]*Show original/);

  // The post's translation handed to a different message is not its words.
  const other = renderToHtml(createElement(
    card.TranslationContext.Provider,
    { value: { id: 99, view: view('shown') } },
    createElement(card.Words, { said: reply, className: 'dh-reply-words' }),
  ));
  assert.match(other, /Gas! Aku main jam 8 malam\./);
  assert.doesNotMatch(other, /Show original/);
});

test('whose words may be translated', () => {
  const { canTranslateSaid } = card;
  assert.equal(canTranslateSaid(said(), 'usernode-capture', false), true);
  assert.equal(canTranslateSaid(said(), 'nisarena1', false), false, 'your own words are never translated');
  assert.equal(canTranslateSaid(said({ who: { id: null, username: 'Homeroom bot', bot: true } }), 'usernode-capture', false), false, 'nor Homeroom bot\'s');
  assert.equal(canTranslateSaid(said({ deleted: true }), 'usernode-capture', false), false, 'a deleted post has nothing to translate');
  assert.equal(canTranslateSaid(said({ content: '   ' }), 'usernode-capture', false), false, 'nor a post with no words');
  assert.equal(canTranslateSaid(said({ content: '', files: 1 }), 'usernode-capture', false), false, 'a post of files alone');
  assert.equal(canTranslateSaid(said(), null, false), false, 'a signed-out reader sees the original');
  assert.equal(canTranslateSaid(said(), 'usernode-capture', true), false, 'and so does a visitor of a public project');
});

test('the row asks for its translation as it comes into view, and the menu offers it', () => {
  const src = read(CARD);
  assert.match(src, /import \{ TranslateNote, observeAutoTranslate, useTranslate, worthAsking, type TranslateView \} from '\.\.\/\.\.\/messages\/translate';/);
  assert.match(src, /const canRead = canTranslateSaid\(said, me, !!room\.visitor\);/);
  assert.match(src, /const autoTranslate = canRead && worthAsking\(said\.content\);/);
  assert.match(src, /useTranslate\(said\.content \? \[said\.content\] : \[\], \{ enabled: canRead, auto: autoTranslate \}\)/);
  assert.match(src, /return observeAutoTranslate\(el, askAuto\);/, 'the row is watched as it scrolls into view');
  assert.match(src, /translation: canRead \? translation : null,/, 'the ⋯ menu gets it, and only where there is one to offer');
  assert.match(src, /const translated = view && view\.state === 'shown' \? view\.texts\[0\] : null;/);
  assert.match(src, /<MessageMarkdown content=\{translated \?\? said\.content\}/, 'the translated words are drawn as the post\'s own are');
  assert.match(src, /<TranslateNote view=\{view\} className="mt-1" \/>/);
});
