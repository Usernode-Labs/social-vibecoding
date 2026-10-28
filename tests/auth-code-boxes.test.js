// Six boxes over one real one-time-code field, for every six-digit code in
// the sign-in and sign-up flow (#5989).
//
// ── What this is guarding ──────────────────────────────────────────────
//
// The sign-in sheet's emailed code drew six boxes over a single transparent
// field (#5253); the waitlist, the phone codes and the sign-up screen each
// asked for the same code in one long field. They all draw the shared
// component now, and what has to stay true is exactly what made #5253 work:
//
//   * ONE real input, so a paste and the keyboard's one-time-code suggestion
//     fill all six in one go, and the ids the checks and e2e steps select on
//     (`#waitlist-code`, `#otp-code`, `#add-phone-code`,
//     `#sign-in-sheet-code`, `#sign-in-sheet-phone-code`) are still on it;
//   * the six boxes drawn from the digits the screen holds, hidden from
//     readers, because the field already says the whole code;
//   * every screen still labels its field with `htmlFor`, including the two
//     steps that hide the label (`sr-only`), so a reader hears what it is.
//
// Run with: node --test tests/auth-code-boxes.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { interiorHtmlFor } = require('./lib/lazy-interiors');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const BOXES = 'frontend/src/features/auth/code-boxes.tsx';
const SHEET = 'frontend/src/features/auth/sign-in-sheet.tsx';
const WAITLIST = 'frontend/src/features/auth/waitlist.tsx';
const LOGIN = 'frontend/src/features/auth/login.tsx';
const ADD_PHONE = 'frontend/src/features/auth/add-phone.tsx';

/** The component rendered with `props`, as static markup. */
function renderBoxes(props = {}) {
  const { CodeBoxes } = loadTsx(BOXES);
  return renderToHtml(createElement(CodeBoxes, {
    id: 'demo-code',
    inputRef: { current: null },
    digits: '',
    onDigits: () => {},
    ...props,
  }));
}

/** The one `<input>` in `html`, as its opening tag, attribute names lower-cased (the renderer keeps the prop's spelling). */
function onlyInput(html) {
  const tags = html.match(/<input\b[^>]*>/g) || [];
  assert.equal(tags.length, 1, 'exactly one real field');
  return tags[0].toLowerCase();
}

test('one hidden grid of six boxes over one real field', () => {
  const html = renderBoxes();
  const grid = /<div class="grid grid-cols-6 gap-2" aria-hidden="true">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(grid, 'the boxes are one grid, hidden from readers');
  assert.equal((grid[1].match(/<span\b/g) || []).length, 6, 'six boxes');

  const input = onlyInput(html);
  assert.match(input, /id="demo-code"/, 'the id the caller passes is on the real field');
  assert.match(input, /autocomplete="one-time-code"/);
  assert.match(input, /inputmode="numeric"/);
  assert.match(input, /enterkeyhint="go"/);
  assert.match(input, /maxlength="6"/);
  assert.match(input, /type="text"/);
  // The boxes carry no data attribute: no new name reaches the shell baseline.
  assert.doesNotMatch(html, /data-[a-z-]+=/);
});

test('the boxes draw the digits the screen holds', () => {
  const digitsOf = (html) => [...html.matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(digitsOf(renderBoxes()), ['', '', '', '', '', '']);
  assert.deepEqual(digitsOf(renderBoxes({ digits: '58' })), ['5', '8', '', '', '', '']);
  assert.deepEqual(digitsOf(renderBoxes({ digits: '583914' })), ['5', '8', '3', '9', '1', '4']);
});

test('a screen can keep a longer field, so a pasted "Code: 583 914" reaches the cleaning whole', () => {
  assert.match(onlyInput(renderBoxes({ maxLength: 32 })), /maxlength="32"/);
});

test('codeDigits takes the six digits out of whatever is typed or pasted', () => {
  const { codeDigits, CODE_LENGTH } = loadTsx(BOXES);
  assert.equal(CODE_LENGTH, 6);
  assert.equal(codeDigits('583914'), '583914');
  assert.equal(codeDigits('583 914'), '583914');
  assert.equal(codeDigits('Code: 583914.'), '583914');
  assert.equal(codeDigits('58391412'), '583914');
  assert.equal(codeDigits('ab'), '');
  assert.equal(codeDigits(''), '');
});

test('every code step in the sign-in and sign-up flow draws the boxes', () => {
  for (const [src, id] of [
    [SHEET, 'sign-in-sheet-code'],
    [SHEET, 'sign-in-sheet-phone-code'],
    [WAITLIST, 'waitlist-code'],
    [LOGIN, 'otp-code'],
    [ADD_PHONE, 'add-phone-code'],
  ]) {
    const text = read(src);
    assert.ok(text.includes('<CodeBoxes'), `${src}: draws the shared boxes`);
    assert.ok(text.includes(`id="${id}"`), `${src}: keeps #${id}`);
    assert.ok(text.includes(`htmlFor="${id}"`), `${src}: its label still points at #${id}`);
  }
});

test('the waitlist renders its code field, and the sign-up screen its own', () => {
  // A rendered interior, not only the source: both screens mount the boxes
  // inside the flow, and the field a declared check selects is there.
  // Attribute names are read case-insensitively, as tests/waitlist-field-
  // primitives.test.js does: the interior renderer keeps the prop's spelling.
  const waitlist = interiorHtmlFor('auth-waitlist-screen');
  const field = /<input\b[^>]*\bid="waitlist-code"[^>]*>/i.exec(waitlist);
  assert.ok(field, '#waitlist-code renders');
  const fieldAttrs = field[0].toLowerCase();
  assert.match(fieldAttrs, /autocomplete="one-time-code"/);
  assert.match(fieldAttrs, /maxlength="32"/);
  assert.match(waitlist.toLowerCase(), /<label[^>]*\bfor="waitlist-code"/);

  const SHOWN = { '../../lib/mount-on-reveal': { useMountedOnReveal: () => true } };
  const { LoginScreen } = loadTsx(LOGIN, { stubs: SHOWN });
  const login = renderToHtml(createElement(LoginScreen));
  const otp = /<input\b[^>]*\bid="otp-code"[^>]*>/i.exec(login);
  assert.ok(otp, '#otp-code renders');
  const otpAttrs = otp[0].toLowerCase();
  assert.match(otpAttrs, /autocomplete="one-time-code"/);
  assert.match(otpAttrs, /enterkeyhint="go"/);
  assert.match(login.toLowerCase(), /<label[^>]*\bfor="otp-code"/);
});
