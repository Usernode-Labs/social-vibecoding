'use strict';

// #1875: the waitlist's Back link was a `position: fixed`, transparent
// "← Back" text link, so on a phone the step label and form scrolled
// underneath it and the two texts painted over each other. It now scrolls
// with the page (`absolute` inside the screen's own scroller) and takes the
// sign-in/register screens' 44px round chevron.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const WAITLIST = read('frontend/src/features/auth/waitlist.tsx');
const REGISTER = read('frontend/src/features/auth/register.tsx');

function backLink(src) {
  const m = src.match(/<a\s+href="[^"]*"\s+data-auth-back=""\s+className="([^"]*)"/);
  assert.ok(m, 'expected a data-auth-back link with a static className');
  return m[1].split(/\s+/);
}

test('the waitlist Back link scrolls with the page instead of staying pinned', () => {
  const classes = backLink(WAITLIST);
  assert.ok(classes.includes('absolute'), `expected absolute, got "${classes.join(' ')}"`);
  assert.ok(!classes.includes('fixed'), 'no longer position: fixed');
  // `absolute` resolves against the screen root, which is its own positioned
  // scroller (fixed inset-0 in the bounded shell, relative in document flow).
  assert.match(WAITLIST, /id="auth-waitlist-screen"\s+className="hidden fixed inset-0[^"]*overflow-y-auto/);
});

test('it is the same 44px round, opaque chevron as the register screen', () => {
  const w = backLink(WAITLIST).filter((c) => c !== 'absolute' && c !== 'fixed');
  const r = backLink(REGISTER).filter((c) => c !== 'absolute' && c !== 'fixed');
  assert.deepEqual(w, r, 'identical styling apart from positioning');
  assert.ok(w.includes('h-11') && w.includes('w-11'), '44px');
  assert.ok(w.includes('bg-white'), 'opaque, so nothing reads through it');
  assert.match(WAITLIST, /data-auth-back=""[\s\S]{0,700}?aria-label="Back"[\s\S]{0,200}?<ChevronLeftIcon/);
  assert.doesNotMatch(WAITLIST, /&larr; Back/, 'the text link is gone');
});

test('it still clears the top content and still points home', () => {
  // Button: 0.75rem + 44px = 56px; the column starts at py-16 (64px).
  assert.match(WAITLIST, /data-auth-back=""[\s\S]{0,700}?top: 'calc\(env\(safe-area-inset-top, 0px\) \+ 0\.75rem\)'/);
  assert.match(WAITLIST, /<div className="max-w-2xl mx-auto px-6 py-16">/);
  assert.match(WAITLIST, /<a\s+href="#landing"\s+data-auth-back=""/);
});
