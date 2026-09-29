'use strict';

// #1875: the waitlist's Back link was a `position: fixed`, transparent
// "← Back" text link, so on a phone the step label and form scrolled
// underneath it and the two texts painted over each other. It now scrolls
// with the page (`absolute` inside the screen's own scroller) and takes the
// sign-in/register screens' 44px round chevron.
//
// #2444 (UI-consistency audit #2383): that alignment was three hand-copied
// anchors, which is how the waitlist's drifted in the first place. The markup
// is now ONE component — frontend/src/features/auth/back-button.tsx — and this
// file pins that: the disc is defined once and every auth screen renders it.
//
// QA 2026-09-24 Q8: the positioning is shared now too. Sign-in and register
// pinned the disc to the VIEWPORT, so on a phone browser the fixed "Get the
// app" strip (z-45, above the z-40 auth screens) covered it even though the
// screens themselves move down to clear the strip. The waitlist's `absolute`
// moves with its screen, so it is the only positioning left.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const AUTH = 'frontend/src/features/auth/';
const BACK = read(`${AUTH}back-button.tsx`);
const WAITLIST = read(`${AUTH}waitlist.tsx`);
const REGISTER = read(`${AUTH}register.tsx`);
const LOGIN = read(`${AUTH}login.tsx`);

/** The one `<AuthBackButton .../>` element a screen renders, as source text. */
function backControl(src, file) {
  const m = src.match(/<AuthBackButton\b[^>]*\/>/g);
  assert.ok(m, `expected ${file} to render <AuthBackButton />`);
  assert.equal(m.length, 1, `expected exactly one Back control in ${file}`);
  return m[0];
}

/** The shared disc's class string: one complete literal, `absolute` first. */
function sharedClasses() {
  const m = BACK.match(/export const AUTH_BACK_CLASS =\s*\n?\s*'([^']*)'/);
  assert.ok(m, 'expected AUTH_BACK_CLASS as one complete literal');
  return m[1].split(/\s+/);
}

test('every Back control scrolls with its screen instead of staying pinned', () => {
  // `absolute` resolves against the screen root, which is its own positioned
  // scroller (fixed inset-0 in the bounded shell, relative in document flow),
  // so a screen moved down by the install or offline strip takes the disc
  // with it (QA 2026-09-24 Q8).
  const classes = sharedClasses();
  assert.equal(classes[0], 'absolute');
  assert.ok(!classes.includes('fixed'), 'no viewport-pinned variant');
  assert.doesNotMatch(BACK, /AUTH_BACK_FIXED_CLASS|position === 'absolute'/, 'no second positioning');
  for (const [file, src, id] of [
    ['waitlist.tsx', WAITLIST, 'auth-waitlist-screen'],
    ['register.tsx', REGISTER, 'auth-register-screen'],
    ['login.tsx', LOGIN, 'auth-login-screen'],
  ]) {
    assert.doesNotMatch(backControl(src, file), /position=/, `${file} picks no positioning of its own`);
    assert.match(src, new RegExp(`id="${id}"\\s+className="hidden fixed inset-0[^"]*overflow-y-auto`));
  }
});

test('it is the same 44px round, opaque chevron on every screen', () => {
  const w = sharedClasses();
  assert.ok(w.includes('h-11') && w.includes('w-11'), '44px');
  assert.ok(w.includes('bg-white'), 'opaque, so nothing reads through it');
  assert.match(BACK, /data-auth-back=""[\s\S]{0,400}?aria-label="Back"[\s\S]{0,200}?<ChevronLeftIcon/);
  assert.doesNotMatch(WAITLIST, /&larr; Back/, 'the text link is gone');
});

test('there is one implementation, and only back-button.tsx holds the markup', () => {
  for (const [file, src] of [
    ['waitlist.tsx', WAITLIST],
    ['register.tsx', REGISTER],
    ['login.tsx', LOGIN],
  ]) {
    assert.doesNotMatch(
      src,
      /<a\s+href="[^"]*"\s+data-auth-back=""/,
      `${file} must render <AuthBackButton />, not its own copy of the anchor`,
    );
    assert.match(src, /from '\.\/back-button'/, `${file} imports the shared control`);
  }
  assert.match(BACK, /<a\s+href=\{href\}\s+data-auth-back=""/);
});

test('it still clears the top content and still points home', () => {
  // Button: 0.75rem + 44px = 56px; the column starts at py-16 (64px).
  assert.match(BACK, /top: 'calc\(env\(safe-area-inset-top, 0px\) \+ 0\.75rem\)'/);
  assert.match(WAITLIST, /<div className="max-w-2xl mx-auto px-6 py-16">/);
  // The waitlist's anchor navigates natively; the auth flow's href is inert
  // and its handler assigns the hash, exactly as each shipped.
  assert.match(backControl(WAITLIST, 'waitlist.tsx'), /href="#landing"/);
  assert.doesNotMatch(backControl(WAITLIST, 'waitlist.tsx'), /onClick=/);
  for (const [file, src] of [['register.tsx', REGISTER], ['login.tsx', LOGIN]]) {
    assert.match(backControl(src, file), /href="#"[\s\S]*onClick=\{backToLanding\}/);
  }
  assert.match(BACK, /export function backToLanding[\s\S]{0,200}?location\.hash = '#landing'/);
});
