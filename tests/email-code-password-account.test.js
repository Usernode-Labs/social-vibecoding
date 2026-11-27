// Email sign-in for an account that already has a password (#1586).
//
// Reported as one sentence: "Sign in with email doesn't work if I have
// already created a password." A correct code was consumed and then answered
// with `invalid_or_expired_code` — the same sentinel a mistyped code gets —
// because `verifyCode()` refused every account whose `password_set` was true,
// which is every account that ever finished the flow.
//
// The server half is EXECUTED against a real database in
// tests/email-signup-postgres.test.js: the three branches, the consumed code
// on all of them, and the session-mint boundary. This file covers the client
// half, where the branch becomes something a person sees: the sign-in
// sheet's code step (the one sign-in since the full-page sign-in screen
// went), with source pins plus the routes' real answers, because effects
// (and so `verify`) do not run under renderToStaticMarkup.
//
// Run with: node --test tests/email-code-password-account.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const SHEET = 'frontend/src/features/auth/sign-in-sheet.tsx';
const ROUTES_TSX = 'frontend/src/features/auth/sign-in-routes.ts';
const ROUTES = 'src/routes/auth.js';

/** The sheet's code-step callback, whole. */
function verifyBody() {
  const handler = /const verify = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\);/.exec(read(SHEET));
  assert.ok(handler, 'verify is still one callback');
  return handler[0];
}

// ─── what the sheet says ────────────────────────────────────────────

test('the sheet says the server\'s sentence, and its own when there is none', () => {
  const body = verifyBody();
  assert.match(body, /setError\(errorText\(data\) \|\| translate\('auth:signInSheet\.code\.passwordAccount'\)\);/,
    'the server\'s words first, the catalog\'s when it gives none');
  assert.match(message('auth:signInSheet.code.passwordAccount'), /signs in with its password/);
  for (const line of [message('auth:signInSheet.code.passwordAccount')]) {
    assert.doesNotMatch(line, /—|&mdash;|&#8212;/, 'no em dash in user-facing copy');
  }
});

// ─── the three branches of verify ───────────────────────────────────

test('a refused-but-correct code lands on the password step, address carried over', () => {
  const body = verifyBody();
  // The only refusal that routes to the password: a confirmed-email account
  // that still has a password is signed in, so this is the unconfirmed one.
  assert.match(body, /data\.code === 'password_required'/);
  assert.doesNotMatch(body, /admin_password_required/, 'admins are signed in like anyone');
  assert.match(body, /identifierPrefill\.current = email;\s+setStep\('password'\);/,
    'the address just typed is carried to the step that can actually succeed');
  // The branch must be taken BEFORE the generic "invalid or expired" message.
  assert.ok(body.indexOf("data.code === 'password_required'") < body.indexOf("'auth:signInSheet.code.rejected'"));
  assert.equal(message('auth:signInSheet.code.rejected'), 'Invalid or expired code.');
});

test('a code that signs you straight in finishes the sign-in instead of asking for anything', () => {
  const body = verifyBody();
  assert.match(body, /if \(data\.next === 'signed-in'\) \{\s+await finish\('existing'\);/,
    'the server branch is honoured');
  assert.match(body, /setStep\('account'\);/, 'the account step still runs for a brand new account');
  assert.ok(body.indexOf("data.next === 'signed-in'") < body.indexOf("setStep('account')"));
});

test('verification crosses the session-mint boundary on both sides', () => {
  // It can mint a session, so the server guards it and the client uses the
  // wrapper that recovers from a stale one (#1608).
  const mintPaths = /const SESSION_MINT_PATHS = \[([\s\S]*?)\];/.exec(read(ROUTES))[1];
  assert.match(mintPaths, /'\/api\/auth\/otp\/verify'/,
    'the verify path is listed in SESSION_MINT_PATHS');
  const body = verifyBody();
  assert.match(body, /fetchSessionMint\('\/api\/auth\/otp\/verify'/);
  assert.match(body, /sessionMintFailureMessage\(err\)/);
  // Requesting a code must NOT be guarded: the wallet-recovery dialog and the
  // mobile wallet claim both ask for one while signed in.
  assert.doesNotMatch(mintPaths, /'\/api\/auth\/otp\/request'/);
});

test('the client does not guess at the cause it now gets told', () => {
  assert.doesNotMatch(read(SHEET), /If your account already has a password/i);
});

// ─── the screenshot-state deep link ─────────────────────────────────

test('the refusal state is URL-reachable, display-only, and boots anonymous', () => {
  const { sheetOpening } = loadTsx(ROUTES_TSX);
  // #login with the shot: the password step, carrying the explanation.
  const opening = sheetOpening('login', null, 'email-code-password-account');
  assert.equal(opening.step, 'password');
  assert.equal(opening.notice, 'password-account');
  // The sheet paints it as it opens, with no request: the notice becomes the
  // step's error, the same words a refusal with no sentence of its own shows.
  const sheet = read(SHEET);
  assert.match(sheet, /\(route\?\.notice === 'password-account' \? translate\('auth:signInSheet\.code\.passwordAccount'\) : null\)/);
  assert.doesNotMatch(read(ROUTES_TSX).slice(read(ROUTES_TSX).indexOf('export function sheetOpening'), read(ROUTES_TSX).indexOf('// ── A code sent')), /fetch\(/,
    'the shot must not call the server');
  assert.match(read('public/js/app.js'), /shot !== 'email-code-password-account'/,
    'the shot boots the anonymous shell like ?shot=password-recovery');
});

test('the declared check selects on what the sheet draws for it', () => {
  const entry = JSON.parse(read('dapp.json')).tests
    .find((t) => t.path === '/?shot=email-code-password-account#login');
  assert.ok(entry, 'dapp.json declares the check');
  assert.match(entry.expectSelector, /\[data-sign-in-sheet="password"\]:has\(#sign-in-sheet-identifier\) \[role="alert"\]/);
  assert.ok(message('auth:signInSheet.code.passwordAccount').includes(entry.expectText));
  const sheet = read(SHEET);
  assert.match(sheet, /<div data-sign-in-sheet=\{step\}/);
  assert.match(sheet, /id="sign-in-sheet-identifier"/);
  assert.match(sheet, /\{error \? \(\s+<div role="alert"/);
});
