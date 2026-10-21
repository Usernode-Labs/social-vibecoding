'use strict';

// The sign-in sheet's two small fixes from snait's UX audit (#5678):
//
//   * "Continue with email" says whether it has an address to send to. The
//     filled pill while the field holds one, an outline with muted ink while
//     it is empty. It stays pressable either way, so a field the browser
//     filled in without an event is never a dead button: pressed empty, it
//     says "Enter a valid email address" and puts the caret in the field.
//   * On the code step, "Sent to <address> · Change" stays on one line. A
//     long name part is shortened with an ellipsis, the provider's part and
//     Change are never cut.
//
// Effects do not run here (tests/lib/render-tsx.js), so what the field's
// state does to the step is pinned as source, and the parts that render on
// their own — the button's two classes, and the address component — are
// rendered.
//
// Run with: node --test tests/sign-in-sheet-email-ready.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { message } = require('./lib/platform-i18n');
const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const SHEET = 'frontend/src/features/auth/sign-in-sheet.tsx';
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the empty and ready email buttons are two complete looks', () => {
  const { EMAIL_BUTTON_READY, EMAIL_BUTTON_EMPTY } = loadTsx(SHEET);
  // Today's filled pill, unchanged: it is what a typed address gets.
  for (const cls of ['h-[50px]', 'rounded-full', 'bg-zinc-200', 'text-zinc-900', 'dark:bg-zinc-800']) {
    assert.ok(EMAIL_BUTTON_READY.includes(cls), cls);
  }
  // Empty: the same shape, no fill, muted ink, the sheet's own hairline.
  for (const cls of ['h-[50px]', 'rounded-full', 'bg-transparent', 'text-zinc-400', 'dark:text-zinc-500',
    'shadow-[inset_0_0_0_1px_var(--app-sheet-line)]']) {
    assert.ok(EMAIL_BUTTON_EMPTY.includes(cls), cls);
  }
  assert.doesNotMatch(EMAIL_BUTTON_EMPTY, /bg-zinc-(?:200|800)/, 'no fill while it is empty');
  assert.notEqual(EMAIL_BUTTON_EMPTY, EMAIL_BUTTON_READY, 'the two states look different');
});

test('the choose step draws the empty look, and never disables the button for an empty field', () => {
  const { SignInSheet, EMAIL_BUTTON_EMPTY } = loadTsx(SHEET);
  const html = renderToHtml(createElement(SignInSheet, {
    open: true, title: 'Continue to Homeroom', from: 'story', providers: ['google', 'apple'], onClose() {}, primaryClass: 'pill',
  }));
  assert.match(html, /data-sign-in-sheet="choose"/);
  const button = html.match(/<button type="submit" data-sign-in-provider="email"[^>]*>/);
  assert.ok(button, 'the email button is there');
  assert.ok(button[0].includes(`class="${EMAIL_BUTTON_EMPTY}"`), 'empty field: the outlined look');
  assert.doesNotMatch(button[0].replace(/disabled:opacity-60/g, ''), /\sdisabled(?:=|\s|>)/,
    'still pressable while empty');
  assert.ok(button[0].includes('data-sign-in-email-empty=""'), 'and marked as empty, for the shots');

  const src = read(SHEET);
  // The look follows what is in the field, from the events a field has, plus
  // the read on focus that autofill without an event needs.
  assert.match(src, /className=\{hasAddress \? EMAIL_BUTTON_READY : EMAIL_BUTTON_EMPTY\}/);
  assert.match(src, /onInput=\{\(e\) => setHasAddress\(!!e\.currentTarget\.value\.trim\(\)\)\}/);
  assert.match(src, /onChange=\{\(e\) => setHasAddress\(!!e\.currentTarget\.value\.trim\(\)\)\}/);
  assert.match(src, /onFocus=\{\(e\) => setHasAddress\(!!e\.currentTarget\.value\.trim\(\)\)\}/);
  // Seeded when the step opens, over a field a release link already filled.
  assert.match(src, /if \(!open \|\| step !== 'choose'\) return;\s*setHasAddress\(!!firstField\.current\?\.value\.trim\(\)\);/);
  // Pressed empty, it says what is missing and puts the caret where the
  // answer goes.
  assert.match(src, /setError\(translate\('auth:signInSheet\.email\.invalid'\)\);\s*\/\/[^\n]*\n\s*firstField\.current\?\.focus\(\{ preventScroll: true \}\);/);
  assert.equal(message('auth:signInSheet.email.invalid'), 'Enter a valid email address');
});

test('the sent-to line is one line: the address shortens in its name part, Change stays beside it', () => {
  const { SentAddress } = loadTsx(SHEET);
  const html = renderToHtml(createElement(SentAddress, { title: 'snaitmouloud+uxaudit1020@gmail.com' }, 'snaitmouloud+uxaudit1020@gmail.com'));
  assert.match(html, /^<strong[^>]*title="snaitmouloud\+uxaudit1020@gmail\.com"/, 'the whole address is still reachable');
  assert.match(html, /<span class="truncate">snaitmouloud\+uxaudit1020<\/span>/, 'the name part is the one that shortens');
  assert.match(html, /<span class="shrink-0">@gmail\.com<\/span>/, 'the provider is never cut');
  assert.doesNotMatch(html, /<span class="truncate">@gmail/, 'the ellipsis never eats the provider');
  // No @ at all: one truncating span, and still one line.
  const bare = renderToHtml(createElement(SentAddress, { title: 'nobody' }, 'nobody'));
  assert.match(bare, /<span class="truncate">nobody<\/span>/);

  const src = read(SHEET);
  assert.match(src, /<p data-sign-in-sheet-sent-to="" className="flex min-w-0 items-baseline gap-x-1 whitespace-nowrap[^"]*">/);
  assert.doesNotMatch(src, /data-sign-in-sheet-sent-to="" className="break-words/, 'no wrapping under the address');
  assert.match(src, /<button type="button" className="shrink-0 font-medium text-violet-700/, 'Change keeps its place');
  // The words are the message's, not the markup's.
  assert.match(src, /<RichMessage id="auth:signInSheet\.code\.sentTo" values=\{\{ email \}\}/);
  assert.match(message('auth:signInSheet.code.sentTo'), /<0>\{\{email\}\}<\/0>[\s\S]*<1>/);
});
