'use strict';

// #6035: a channel's message box formats what is being written.
//
// The buttons edit the message source with the markers marked already
// renders (`**`, `_`, `++`) or prefix a line (`# `, `> `, `- `), so the
// tricky half is the pure edit: what the text becomes and where the
// selection goes. That is loadTsx-ed and exercised directly; the composer
// source is then pinned for the things a pure function cannot show — that
// the row is a channel's alone, names its buttons from the catalog, keeps
// the field focused, and takes Ctrl/Cmd+B and I.
//
// Run with: node --test tests/messages-composer-format.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const COMPOSER = read('frontend/src/features/messages/composer.tsx');
const { applyFormat, hasFormatting } = loadTsx('frontend/src/features/messages/composer-format.ts');

test('bold, italic and underline wrap the selection and select the same words', () => {
  const bold = applyFormat('hello world', 0, 5, 'bold');
  assert.equal(bold.value, '**hello** world');
  assert.equal(bold.value.slice(bold.start, bold.end), 'hello');

  const italic = applyFormat('hello world', 6, 11, 'italic');
  assert.equal(italic.value, 'hello _world_');
  assert.equal(italic.value.slice(italic.start, italic.end), 'world');

  const underline = applyFormat('hello world', 6, 11, 'underline');
  assert.equal(underline.value, 'hello ++world++');
  assert.equal(underline.value.slice(underline.start, underline.end), 'world');
});

test('spaces in the selection stay outside the markers', () => {
  const result = applyFormat('say  hi  now', 3, 9, 'bold');
  assert.equal(result.value, 'say  **hi**  now');
  assert.equal(result.value.slice(result.start, result.end), 'hi');
});

test('pressing the same button again takes the markers off', () => {
  const wrapped = applyFormat('**word**', 2, 6, 'bold');
  assert.equal(wrapped.value, 'word');
  assert.equal(wrapped.value.slice(wrapped.start, wrapped.end), 'word');

  const selected = applyFormat('a **word** b', 4, 8, 'bold');
  assert.equal(selected.value, 'a word b');
  assert.equal(selected.value.slice(selected.start, selected.end), 'word');
});

test('nothing selected puts the pair at the caret', () => {
  const result = applyFormat('one two', 4, 4, 'italic');
  assert.equal(result.value, 'one __two');
  assert.deepEqual([result.start, result.end], [5, 5]);
});

test('heading steps through large, medium and small, then plain', () => {
  let text = 'A line';
  const seen = [];
  for (let i = 0; i < 4; i += 1) {
    const result = applyFormat(text, 0, 0, 'heading');
    text = result.value;
    seen.push(text);
    assert.equal(result.start, result.end, 'the caret stays in the line');
  }
  assert.deepEqual(seen, ['# A line', '## A line', '### A line', 'A line']);
});

test('quote and bullet mark every selected line, and a second press clears them', () => {
  const quoted = applyFormat('one\ntwo', 0, 7, 'quote');
  assert.equal(quoted.value, '> one\n> two');
  assert.equal(applyFormat(quoted.value, 0, quoted.value.length, 'quote').value, 'one\ntwo');

  const bullets = applyFormat('one\ntwo', 0, 7, 'bullet');
  assert.equal(bullets.value, '- one\n- two');
  assert.equal(applyFormat(bullets.value, 0, bullets.value.length, 'bullet').value, 'one\ntwo');
});

test('a heading sits after a quote or bullet marker', () => {
  assert.equal(applyFormat('> a line', 2, 2, 'heading').value, '> # a line');
  assert.equal(applyFormat('- a line', 2, 2, 'heading').value, '- # a line');
});

test('quote, bullet and heading show up before a word is typed', () => {
  const bullet = applyFormat('', 0, 0, 'bullet');
  assert.equal(bullet.value, '- ');
  assert.deepEqual([bullet.start, bullet.end], [2, 2]);

  const quote = applyFormat('', 0, 0, 'quote');
  assert.equal(quote.value, '> ');
  assert.deepEqual([quote.start, quote.end], [2, 2]);

  const heading = applyFormat('', 0, 0, 'heading');
  assert.equal(heading.value, '# ');
  assert.deepEqual([heading.start, heading.end], [2, 2]);

  const middle = applyFormat('one\n\ntwo', 4, 4, 'bullet');
  assert.equal(middle.value, 'one\n- \ntwo');
  assert.deepEqual([middle.start, middle.end], [6, 6]);
});

test('a selection with words leaves its blank lines blank', () => {
  assert.equal(applyFormat('a\n\nb', 0, 5, 'bullet').value, '- a\n\n- b');
  assert.equal(applyFormat('a\n\nb', 0, 5, 'quote').value, '> a\n\n> b');
});

test('hasFormatting tells a formatted draft from a plain one', () => {
  for (const plain of ['hello there', '2 * 3 = 6', 'snake_case_name', 'a - b']) {
    assert.equal(hasFormatting(plain), false, `${JSON.stringify(plain)} is plain`);
  }
  for (const formatted of ['**bold**', '_italic_', '++under++', '~~gone~~', '`code`', '# head', '> quote', '- item']) {
    assert.equal(hasFormatting(formatted), true, `${JSON.stringify(formatted)} is formatted`);
  }
});

test('the result is cut at the composer’s 8000 characters', () => {
  const long = 'x'.repeat(8000);
  const result = applyFormat(long, 7990, 8000, 'bold');
  assert.equal(result.value.length, 8000);
  assert.ok(result.start <= 8000 && result.end <= 8000);
});

test('the composer shows the row only for a channel, named from the catalog', () => {
  assert.match(COMPOSER, /\{isChannel \? \(\s*<div className="messages-format-bar" role="toolbar"/);
  assert.match(COMPOSER, /aria-label=\{t\('messages:composer\.format\.bar'\)\}/);
  for (const kind of ['bold', 'italic', 'underline', 'heading', 'quote', 'bullet']) {
    assert.match(COMPOSER, new RegExp(`data-format=\\{kind\\}`), `the ${kind} button carries its kind`);
  }
  for (const label of ['bold', 'italic', 'underline', 'heading', 'quote', 'bullets']) {
    assert.match(COMPOSER, new RegExp(`messages:composer\\.format\\.${label}`), `the ${label} button has a name`);
    assert.ok(message(`messages:composer.format.${label}`), `${label} is in the messages catalog`);
  }
});

test('a press keeps the field focused and takes Ctrl/Cmd+B and I', () => {
  assert.match(COMPOSER, /onMouseDown=\{\(event\) => event\.preventDefault\(\)\} onClick=\{\(\) => formatSelected\(kind\)\}/);
  assert.match(COMPOSER, /input\.focus\(\{ preventScroll: true \}\)/);
  assert.match(COMPOSER, /function onFormatKey\(/);
  assert.match(COMPOSER, /key !== 'b' && key !== 'i'/);
  assert.match(COMPOSER, /if \(onFormatKey\(event\)\) return;/);
});

test('a formatted draft is drawn as it will be sent, above the field', () => {
  // Drea, #6035: the writer sees the formatted result while typing, not
  // only after Send. A plain draft draws no preview (it would be the field
  // twice), and the field keeps the source that gets sent.
  assert.match(COMPOSER, /const preview = isChannel && hasFormatting\(value\) && plainText\(value\)\.length > 0 \? value\.trim\(\) : null;/);
  assert.match(COMPOSER, /className="messages-format-preview" role="group" aria-label=\{t\('messages:composer\.format\.preview'\)\}/);
  assert.match(COMPOSER, /<MessageMarkdown content=\{preview\} \/>/);
  assert.ok(message('messages:composer.format.preview'), 'the preview label is in the messages catalog');
  const previewAt = COMPOSER.indexOf('messages-format-preview');
  const fieldAt = COMPOSER.indexOf('<div className="flex items-end gap-1.5">');
  assert.ok(previewAt > 0 && previewAt < fieldAt, 'the preview sits above the field');
});

test('the shared renderer understands ++underline++ and lets <u> through', () => {
  const DEV_CHAT = read('frontend/src/features/dev-chat/dev-chat.js');
  assert.match(DEV_CHAT, /name: 'underline'/, 'the underline extension is registered');
  assert.match(DEV_CHAT, /'del', 'u',/, '<u> is in the sanitizer allowlist');
  assert.match(DEV_CHAT, /return `<u>\$\{this\.parser\.parseInline\(token\.tokens\)\}<\/u>`/);
});
