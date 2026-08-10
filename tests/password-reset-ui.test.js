// Content pins for the email password-reset UI (login screen recovery
// flow + the #reset-password/<token> magic-link route).
//
// The shell's markup is frozen (tests/shell-markup-parity.test.js), so —
// like every post-fixture feature — the reset UI is built at runtime by
// public/js/auth-screens.js rather than added to frontend/src/Shell.tsx.
// These are source pins in the style of tests/landing-directory.test.js:
// they hold that contract in place so a refactor that silently drops a
// piece fails loudly here.
//
// Run with: node --test tests/password-reset-ui.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ─── the magic-link route ──────────────────────────────────────────

test('reset-password is a login-screen route with a dispatcher and depth', () => {
  const js = read('public/js/auth-screens.js');
  assert.match(js, /'reset-password':\s*'auth-login-screen'/,
    'route renders on the login screen, like signup');
  assert.match(js, /_resetOnShow/, 'show() dispatches to a reset handler');
});

test('the emailed link format matches the route the front end registers', () => {
  const mail = read('src/services/mail/index.js');
  // Segment style (like #more/<token>) — routeFromHash splits on '/'.
  assert.match(mail, /#reset-password\/\$\{token\}/);
});

// ─── recovery screen: the email-request form ───────────────────────

test('recovery screen builds an email form that posts to the request endpoint', () => {
  const js = read('public/js/auth-screens.js');
  assert.match(js, /recovery-email-input/, 'email input exists');
  assert.match(js, /\/api\/auth\/password-reset\/request/);
});

test('the request result copy is anti-enumeration (same message either way)', () => {
  const js = read('public/js/auth-screens.js');
  assert.match(js, /If that address matches an account/i,
    'success copy must not confirm the account exists');
});

test('the stale "no email on file" claim is rewritten at runtime', () => {
  const js = read('public/js/auth-screens.js');
  // The frozen markup still carries the pre-email copy; the module must
  // replace it so the admin path reads as the fallback, not the rule.
  assert.match(js, /recovery-admin/, 'admin fallback block is still used');
  assert.match(js, /No confirmed email on your account\?/,
    'fallback copy repositions the admin path');
});

// ─── the confirm view ──────────────────────────────────────────────

test('the reset view posts token + new password to the confirm endpoint', () => {
  const js = read('public/js/auth-screens.js');
  assert.match(js, /\/api\/auth\/password-reset\/confirm/);
  assert.match(js, /reset-new-password/, 'new-password input exists');
  assert.match(js, /reset-confirm-password/, 'confirm input exists');
});

test('a refused token gets the generic expired-link message with a way back', () => {
  const js = read('public/js/auth-screens.js');
  assert.match(js, /invalid or has expired/i);
  assert.match(js, /request a new/i, 'points the user back at requesting a fresh link');
});

// ─── frozen-markup contract ────────────────────────────────────────

test('Shell.tsx is untouched: no reset-password markup crept into the frozen shell', () => {
  const shell = read('frontend/src/Shell.tsx');
  assert.doesNotMatch(shell, /reset-password-view|recovery-email-input/,
    'reset UI must be runtime-built (markup parity contract, step 1)');
});
