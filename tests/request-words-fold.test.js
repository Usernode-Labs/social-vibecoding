'use strict';

// A request's words fold only when the fold hides three lines or more.
//
// RequestWords (frontend/src/features/dev-board/topic/request-head.tsx) draws
// the request's body, a change's summary inside a request
// (thread-changes.tsx) and the change's own page (change-head.tsx). Folded,
// it shows four lines and a "Show more" row; a fold that hid one or two
// lines stood as tall as the words whole and saved nothing. So:
//
//   1. Up to six lines show whole: no clamp, no ellipsis, no Show more.
//      Seven or more fold to four lines with Show more, as before.
//   2. Lines are counted from the measured overflow and the words' computed
//      line height (24px in the card look, 1.5 of the text elsewhere), never
//      from characters.
//   3. Words that do not fold carry no `line-clamp-4`, so no line is cut
//      with an ellipsis that nothing opens.
//   4. It is decided in a layout effect, before the first paint, and again
//      when the words change (a translation) or the column's width does.
//   5. The first render is the old markup exactly (clamped, no control):
//      the server render and tests/request-shots.test.js hold it byte for
//      byte.
//
// Effects do not run under renderToStaticMarkup, so the decision is a pure
// function tested here, and the wiring is held in the source. It was also
// checked in Chromium against the real stylesheets: four to eight lines of
// wrapped text, line breaks, one-line paragraphs and lists, in all three
// places, at 1720, 1280 and 390px.
//
// Run with: node --test tests/request-words-fold.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const HEAD = 'frontend/src/features/dev-board/topic/request-head.tsx';
const SRC = fs.readFileSync(path.join(ROOT, HEAD), 'utf8');

test('a fold is drawn only when it hides three lines or more', () => {
  const { foldHidesEnough, FOLD_HIDES_AT_LEAST } = loadTsx(HEAD);
  assert.equal(FOLD_HIDES_AT_LEAST, 3);
  for (const line of [24, 22.5, 21]) {
    // Five and six lines: the fold would hide one or two.
    assert.equal(foldHidesEnough(1 * line, line), false, `five lines at ${line}px show whole`);
    assert.equal(foldHidesEnough(2 * line, line), false, `six lines at ${line}px show whole`);
    // Six one-line paragraphs: two lines and the 8px breaks between them.
    assert.equal(foldHidesEnough(2 * line + 16, line), false, `six short paragraphs at ${line}px show whole`);
    // Seven and more fold.
    assert.equal(foldHidesEnough(3 * line, line), true, `seven lines at ${line}px fold`);
    assert.equal(foldHidesEnough(Math.floor(3 * line), line), true, 'a rounded-down height still folds');
    assert.equal(foldHidesEnough(10 * line, line), true);
  }
  // A box with no layout yet (a shut section) measures nothing.
  assert.equal(foldHidesEnough(0, 24), false);
  assert.equal(foldHidesEnough(72, 0), false);
  assert.equal(foldHidesEnough(Number.NaN, 24), false);
});

test('a line is the words\' computed line height, not a count of characters', () => {
  const { wordsLineHeight } = loadTsx(HEAD);
  assert.equal(wordsLineHeight({ lineHeight: '24px', fontSize: '15.5px' }), 24, 'the card look');
  assert.equal(wordsLineHeight({ lineHeight: '22.5px', fontSize: '15px' }), 22.5, 'the request page');
  assert.equal(wordsLineHeight({ lineHeight: '21px', fontSize: '14px' }), 21, 'a change summary');
  assert.equal(wordsLineHeight({ lineHeight: '1.5', fontSize: '14px' }), 21, 'a unitless value is a multiple of the size');
  assert.equal(wordsLineHeight({ lineHeight: 'normal', fontSize: '16px' }), 24, 'normal reads as 1.5');
  assert.equal(wordsLineHeight({ lineHeight: 'normal', fontSize: '' }), 0);
  assert.doesNotMatch(SRC, /textContent\.length|\.length\s*>\s*\d{3}/, 'nothing counts characters');
});

test('the decision is measured before the first paint, and again on new words or a new width', () => {
  const words = SRC.slice(SRC.indexOf('export function RequestWords('), SRC.indexOf('/** The author\'s editor'));
  assert.ok(words.length > 0, 'RequestWords is there');
  // Unmeasured, measured as folding, measured as whole.
  assert.match(words, /useState<boolean \| null>\(null\)/);
  assert.match(words, /useLayoutEffect\(\(\) => \{\n    const el = text\.current;\n    if \(!el \|\| open\) return undefined;/);
  assert.match(words, /new ResizeObserver\(/, 'the column\'s width is watched');
  assert.match(words, /\}, \[words, open\]\);/, 'new words (a translation) measure again');
  // The measure reads the overflow from the box, both ways.
  const measure = SRC.slice(SRC.indexOf('function measureFold('), SRC.indexOf('export function RequestWords('));
  assert.match(measure, /foldHidesEnough\(whole - folded, wordsLineHeight\(window\.getComputedStyle\(el\)\)\)/);
  assert.match(measure, /getClientRects\(\)\.length\) return null/, 'no box, no decision');
});

test('words that do not fold carry no clamp, and only a fold draws Show more', () => {
  const words = SRC.slice(SRC.indexOf('export function RequestWords('), SRC.indexOf('/** The author\'s editor'));
  assert.match(words, /className=\{`dev-request-ask-text\$\{open \|\| folds === false \? '' : ' line-clamp-4'\}`\}/);
  assert.match(words, /const showMore = words && \(folds === true \|\| open\);/);
  // The Translate control keeps its row with no Show more in it.
  assert.match(words, /\{translate \? <div className="mt-1 flex flex-wrap items-center gap-4">\{more\}\{translate\}<\/div> : more\}/);
  // The three places draw the same component.
  for (const file of ['thread-changes.tsx', 'change-head.tsx']) {
    const src = fs.readFileSync(path.join(ROOT, 'frontend/src/features/dev-board/topic', file), 'utf8');
    assert.match(src, /<RequestWords html=\{/, `${file} draws RequestWords`);
  }
});

test('the first render is the old markup: clamped, with no control', () => {
  const { RequestWords } = loadTsx(HEAD);
  const html = '<div class="dev-issue-body"><p>One line.</p></div>';
  assert.equal(renderToHtml(createElement(RequestWords, { html })),
    `<div class="dev-request-ask"><div class="dev-request-ask-text line-clamp-4" data-request-words="">${html}</div></div>`);
});
