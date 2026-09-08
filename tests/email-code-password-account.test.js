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
// half, where the branch becomes something a person sees — and it does so with
// source pins plus the screen's real initial render, because effects (and so
// `onOtpVerify`) do not run under renderToStaticMarkup.
//
// Run with: node --test tests/email-code-password-account.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { interiorHtmlFor } = require('./lib/lazy-interiors');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const LOGIN_TSX = 'frontend/src/features/auth/login.tsx';
const SERVICE = 'src/services/email-signup.js';
const ROUTES = 'src/routes/auth.js';

// ─── the two halves say the same thing ──────────────────────────────

test('the refusal copy the screen falls back to matches the one the server sends', () => {
  const server = /^const PASSWORD_REQUIRED_MESSAGE =\n\s*'([^']+)';$/m.exec(read(SERVICE));
  assert.ok(server, 'the service names its refusal message');
  const client = /^const PASSWORD_ACCOUNT_MSG =\n\s*'([^']+)';$/m.exec(read(LOGIN_TSX));
  assert.ok(client, 'the screen names its fallback');
  assert.equal(client[1], server[1],
    'a real refusal and the ?shot= state must read identically');
  // The rule for user-facing strings, on the copy this change adds.
  for (const line of [server[1], client[1]]) {
    assert.doesNotMatch(line, /—|&mdash;|&#8212;/, 'no em dash in user-facing copy');
  }
});

// ─── the three branches of onOtpVerify ──────────────────────────────

test('a refused-but-correct code lands on the password form, address carried over', () => {
  const tsx = read(LOGIN_TSX);
  const handler = /const onOtpVerify = useCallback\(async \(\) => \{[\s\S]*?\n  \}, \[[^\]]*\]\);/.exec(tsx);
  assert.ok(handler, 'onOtpVerify is still one callback');
  const body = handler[0];

  // Both refusals route the same way: they are not mistyped codes.
  assert.match(body, /data\.code === 'password_required' \|\| data\.code === 'admin_password_required'/);
  assert.match(body, /showLoginBaseView\(\);/,
    'the code step is left for the form that can actually succeed');
  assert.match(body, /username\.current\.value = st\.otpEmail \|\| ''/,
    'the address just typed is prefilled, not asked for twice');
  assert.match(body, /setLoginError\(data\.error \|\| PASSWORD_ACCOUNT_MSG\)/,
    'the explanation is shown on the form it applies to');
  // The branch must be taken BEFORE the generic "invalid or expired" message.
  assert.ok(body.indexOf('admin_password_required') < body.indexOf('Invalid or expired code.'));
});

test('a code that signs you straight in finishes the login instead of asking for a password', () => {
  const body = /const onOtpVerify = useCallback\(async \(\) => \{[\s\S]*?\n  \}, \[[^\]]*\]\);/.exec(read(LOGIN_TSX))[0];
  assert.match(body, /if \(data\.next === 'signed-in'\) \{[\s\S]{0,160}finishLogin\(\);/,
    'the new server branch is honoured');
  assert.match(body, /otpShowStep\('password'\)/,
    'the password-setup branch still runs for a brand new account');
  // …and the setup step is the fallback, not the thing tried first.
  assert.ok(body.indexOf("data.next === 'signed-in'") < body.indexOf("otpShowStep('password')"));
});

test('verification crosses the session-mint boundary on both sides', () => {
  // It can mint a session now, so the server guards it and the client uses
  // the wrapper that recovers from a stale one (#1608).
  const mintPaths = /const SESSION_MINT_PATHS = \[([\s\S]*?)\];/.exec(read(ROUTES))[1];
  assert.match(mintPaths, /'\/api\/auth\/otp\/verify'/,
    'the verify path is listed in SESSION_MINT_PATHS');
  const body = /const onOtpVerify = useCallback\(async \(\) => \{[\s\S]*?\n  \}, \[[^\]]*\]\);/.exec(read(LOGIN_TSX))[0];
  assert.match(body, /fetchSessionMint\('\/api\/auth\/otp\/verify'/);
  assert.match(body, /sessionMintFailureMessage\(error\)/);
  // Requesting a code must NOT be guarded: the wallet-recovery dialog and the
  // mobile wallet claim both ask for one while signed in.
  assert.doesNotMatch(mintPaths, /'\/api\/auth\/otp\/request'/);
});

test('the client no longer guesses at the cause it now gets told', () => {
  // The screen used to append "If your account already has a password..." to
  // every failed verification, because the server could not say so. It can.
  assert.doesNotMatch(read(LOGIN_TSX), /If your account already has a password/i);
});

// ─── the screenshot-state deep link ─────────────────────────────────

test('the refusal state is URL-reachable, display-only, and boots anonymous', () => {
  const tsx = read(LOGIN_TSX);
  assert.match(tsx, /shot === 'email-code-password-account'/,
    'the login screen paints the state for the shot');
  // Reached by typing a code in production, so the link writes nothing and
  // works in every environment — which is what gives the "before" shot
  // something to photograph once this ships.
  assert.doesNotMatch(
    /if \(!openSignup && shot === 'email-code-password-account'\) \{[\s\S]*?\n      \}/.exec(tsx)[0],
    /fetch\(/,
    'the shot must not call the server');
  assert.match(read('public/js/app.js'), /shot !== 'email-code-password-account'/,
    'the shot boots the anonymous shell like ?shot=password-recovery');
});

test('the declared check selects on nodes the screen actually ships', () => {
  const entry = JSON.parse(read('dapp.json')).tests
    .find((t) => t.path === '/?shot=email-code-password-account#login');
  assert.ok(entry, 'dapp.json declares the check in the same commit');
  assert.match(entry.expectSelector, /#login-form:not\(\.hidden\) #login-error:not\(\.hidden\)/);
  assert.match(entry.expectText, /signs in with a password/);

  // The three ids the selector walks are in the login screen's interior. The
  // check's own `:not(.hidden)` is what proves the state painted; this proves
  // the nodes exist to be unhidden at all.
  const html = interiorHtmlFor('auth-login-screen');
  for (const id of ['login-form', 'login-error', 'login-username']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  // …and #login-error ships hidden, so a passing check cannot be the empty
  // box that was always there.
  assert.match(html, /<div id="login-error" class="[^"]*\bhidden\b/);
});

// ─── the step-one copy ──────────────────────────────────────────────

test('the code step no longer describes itself as signup only', () => {
  const html = interiorHtmlFor('auth-login-screen');
  const step = /<div id="otp-step-email"[\s\S]*?<\/p>/.exec(html)[0];
  assert.match(step, /code to sign in/i, 'signing in is what it leads with now');
  assert.match(step, /New here\?/, 'account creation is the secondary case');
});
