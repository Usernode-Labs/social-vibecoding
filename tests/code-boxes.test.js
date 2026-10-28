'use strict';

// Every digit code of the sign-in and sign-up flows is six boxes over one
// real field (#5989): the sign-in sheet's phone code, the first run's Add a
// phone code and the sign-in screen's email code draw
// frontend/src/features/auth/code-boxes.tsx, the pattern the sheet's email
// code introduced (#5253). What this pins:
//
//   1. one real field still carries every one-time-code attribute, so the
//      keyboard's suggestion, Messages' and Mail's autofill and a paste all
//      land in it, and a reader sees one labelled field, not six boxes;
//   2. what is typed or pasted is kept as digits, in the field and the
//      boxes, and the box the next digit goes into is ringed while the
//      field has focus;
//   3. the callers keep reading the code off their own ref, as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const BOXES = 'frontend/src/features/auth/code-boxes.tsx';

test('the pattern: six boxes hidden from readers, over one real one-time-code field', () => {
  const src = read(BOXES);
  assert.match(src, /<div className="grid grid-cols-6 gap-2" aria-hidden="true">/);
  assert.match(src, /Array\.from\(\{ length: CODE_LENGTH \}/);
  assert.match(src, /<label htmlFor=\{id\} className="sr-only">\{label\}<\/label>/, 'one labelled field for a reader');
  assert.match(src, /id=\{id\}\s+\{\.\.\.ONE_TIME_CODE_FIELD\}\s+enterKeyHint="go"\s+maxLength=\{6\}/, 'the field says it is a one-time code, in every way a browser reads');
  assert.match(src, /className=\{CODE_FIELD_OVER_BOXES\}/);
  assert.match(src, /text-transparent caret-transparent/, 'the field is drawn by the boxes, not itself');
  // The field stays uncontrolled: every caller reads the code off its ref.
  assert.doesNotMatch(src, /value=\{code\}/);
  assert.match(src, /if \(el\.value !== digits\) el\.value = digits;/);
});

test('codeDigits keeps the six digits of whatever was typed or pasted', () => {
  const { codeDigits, CODE_LENGTH } = loadTsx(BOXES);
  assert.equal(CODE_LENGTH, 6);
  assert.equal(codeDigits('583914'), '583914');
  assert.equal(codeDigits('583 914'), '583914');
  assert.equal(codeDigits('Code: 583914.'), '583914');
  assert.equal(codeDigits('58391412'), '583914');
  assert.equal(codeDigits('ab'), '');
  // The sheet still exports them for its own callers.
  const sheet = loadTsx('frontend/src/features/auth/sign-in-sheet.tsx');
  assert.equal(sheet.codeDigits('Code: 583914.'), '583914');
  assert.equal(sheet.CODE_LENGTH, 6);
});

test('it renders six empty boxes, the label and the field, with the id and attribute it was given', () => {
  const { CodeBoxes } = loadTsx(BOXES);
  const html = renderToHtml(createElement(CodeBoxes, {
    id: 'otp-code', inputRef: { current: null }, label: 'Code', boxAttr: 'data-otp-code-box',
  }));
  assert.equal((html.match(/data-otp-code-box="\d"/g) || []).length, 6, 'six boxes');
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /<label for="otp-code" class="sr-only">Code<\/label>/);
  assert.match(html, /<input id="otp-code" type="text" inputMode="numeric" pattern="\[0-9\]\*" autoComplete="one-time-code" autoCapitalize="none" autoCorrect="off" spellCheck="false" enterKeyHint="go" maxLength="6"[^>]*name="one-time-code"/);
  assert.doesNotMatch(html, /ring-violet-600/, 'nothing is ringed until the field has focus');
  // The default attribute, when a caller names none.
  const plain = renderToHtml(createElement(CodeBoxes, { id: 'x', inputRef: { current: null }, label: 'Code' }));
  assert.equal((plain.match(/data-code-box="\d"/g) || []).length, 6);
});

test('the sheet\'s phone code, Add a phone and the sign-in screen draw it, with their ids kept', () => {
  const sheet = read('frontend/src/features/auth/sign-in-sheet.tsx');
  assert.match(sheet, /<CodeBoxes id="sign-in-sheet-phone-code" inputRef=\{phoneCodeField\} label=\{t\('auth:signInSheet\.phoneCode\.label'\)\} clearKey=\{cooldownUntil\}/);
  assert.match(sheet, /const code = \(phoneCodeField\.current\?\.value \|\| ''\)\.trim\(\);/, 'verifyPhone still reads the field');
  const addPhone = read('frontend/src/features/auth/add-phone.tsx');
  assert.match(addPhone, /<CodeBoxes id="add-phone-code" inputRef=\{codeField\} label=\{t\('auth:addPhone\.codeLabel'\)\} clearKey=\{resendAt\}/);
  assert.match(addPhone, /const code = \(codeField\.current\?\.value \|\| ''\)\.trim\(\);/);
  assert.doesNotMatch(addPhone, /tracking-\[0\.4em\]/, 'the one wide field is gone');
  const login = read('frontend/src/features/auth/login.tsx');
  assert.match(login, /<CodeBoxes id="otp-code" inputRef=\{otpCode\} label=\{t\('auth:login\.otp\.codeLabel'\)\} clearKey=\{cooldownUntil\}/);
  assert.match(login, /const code = \(otpCode\.current\?\.value \|\| ''\)\.trim\(\);/);
  assert.doesNotMatch(login, /CODE_FIELD\b/, 'the wide mono field is gone');
  // Each keeps the label a reader and the manifest's checks look for.
  assert.match(sheet, /<label htmlFor="sign-in-sheet-phone-code" className=\{LABEL\}>/);
  assert.match(addPhone, /<label htmlFor="add-phone-code" className=\{LABEL\}>/);
  assert.match(login, /<label htmlFor="otp-code" className=\{AUTH_LABEL\}>/);
});

test('the sheet\'s email code still draws its own boxes, because its sixth digit sends it', () => {
  // #5253's step is unchanged: it needs onCodeInput's auto-send, so it keeps
  // its own copy of the markup and shares the box styles and the digits.
  const sheet = read('frontend/src/features/auth/sign-in-sheet.tsx');
  assert.match(sheet, /import \{ CODE_BOX, CODE_BOX_NEXT, CODE_LENGTH, codeDigits, CodeBoxes \} from '\.\/code-boxes';/);
  assert.match(sheet, /export \{ CODE_LENGTH, codeDigits \};/);
  assert.doesNotMatch(sheet, /^const CODE_BOX = /m, 'one definition of the box styles');
});
