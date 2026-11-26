// The email password reset, in the sign-in sheet: "Forgot password?" (and
// #login/forgot) emails a link, and the link (#reset-password/<token>) opens
// the sheet's new-password step over the landing. The full-page sign-in
// screen that held both views is gone; the sheet is the one sign-in.
//
// Source pins for what effects do (they do not run under
// renderToStaticMarkup), and the exchanges themselves run against a fake
// fetch.
//
// Run with: node --test tests/password-reset-ui.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const SHEET = 'frontend/src/features/auth/sign-in-sheet.tsx';
const ROUTES = 'frontend/src/features/auth/sign-in-routes.ts';
const TOKEN = 'a'.repeat(64);

/** Run `fn` with these globals in place, and put the old ones back after. */
async function withGlobals(globals, fn) {
  const prior = {};
  for (const key of Object.keys(globals)) {
    prior[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value: globals[key], configurable: true, writable: true });
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(globals)) {
      if (prior[key]) Object.defineProperty(globalThis, key, prior[key]);
      else delete globalThis[key];
    }
  }
}

/** A fetch that answers from `routes` (url → [status, body]) and records every call. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const answer = typeof routes === 'function' ? routes(url, init) : routes[url];
    if (answer instanceof Error) throw answer;
    const [status, body] = answer || [404, {}];
    return { ok: status < 400, status, headers: { get: () => null }, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

// ─── the magic-link route ──────────────────────────────────────────

test('#reset-password/<token> is the landing, with the sheet open at its new-password step', () => {
  const js = read('public/js/auth-screens.js');
  assert.match(js, /'reset-password': 'auth-landing-screen'/, 'the route is the landing\'s');
  assert.match(js, /const SIGN_IN_ROUTES = \['login', 'signup', 'register', 'reset-password'\];/);
  assert.match(js, /AuthScreens\._signInRoute = signIn \? \{ route, seg: seg \|\| null \} : null;\s+AuthScreens\._landingOnShow\(\);/,
    'show() keeps the route and its token for the landing');
  const { sheetOpening } = loadTsx(ROUTES);
  const opening = sheetOpening('reset-password', TOKEN, null);
  assert.equal(opening.step, 'reset');
  assert.equal(opening.token, TOKEN);
});

test('the emailed link format matches the route the front end registers', () => {
  const mail = read('src/services/mail/index.js');
  // Segment style (like #more/<token>): routeFromHash splits on '/'.
  assert.match(mail, /#reset-password\/\$\{token\}/);
});

// ─── asking for the link ───────────────────────────────────────────

test('the reset step asks for a link, and says the same whether or not the address matched', () => {
  const sheet = read(SHEET);
  assert.match(sheet, /fetch\('\/api\/auth\/password-reset\/request'/);
  assert.match(sheet, /id="sign-in-sheet-reset-email"/);
  assert.match(message('auth:signInSheet.forgot.sent'), /If that address matches an account/i,
    'success copy must not confirm the account exists');
});

test('the way back for an address never confirmed is the support team, said once a link went (#1158, #2969)', () => {
  const support = message('auth:signInSheet.forgot.support');
  assert.match(support, /temporary password/);
  assert.match(support, /support@usernodelabs\.org/);
  assert.match(read(SHEET), /\{resetSent \? \(\s+<p data-sign-in-sheet-reset-support=""/);
});

test('#login/forgot opens the reset step, and so do the capture states (#1158, QA Q16)', () => {
  const { sheetOpening } = loadTsx(ROUTES);
  assert.equal(sheetOpening('login', 'forgot', null).step, 'forgot', 'the address of its own');
  assert.equal(sheetOpening('login', null, 'password-recovery').step, 'forgot');
  const sent = sheetOpening('login', null, 'password-recovery-sent');
  assert.equal(sent.step, 'forgot');
  assert.equal(sent.resetSent, true, 'the sent state is painted, with nothing sent');
  assert.match(read(SHEET), /setResetSent\(route\?\.resetSent === true\);/);
  assert.match(read('public/js/app.js'), /shot !== 'password-recovery'/,
    'the shot boots the anonymous shell like ?shot=anon');
});

// ─── choosing the new password ─────────────────────────────────────

test('the new password goes to the confirm endpoint with the token, checked first', async () => {
  const { confirmPasswordReset } = loadTsx(ROUTES);
  const ok = fakeFetch({ '/api/auth/password-reset/confirm': [200, { ok: true }] });
  await withGlobals({ fetch: ok }, async () => {
    assert.deepEqual(await confirmPasswordReset(TOKEN, 'correct horse', 'correct horse'), { ok: true });
  });
  assert.deepEqual(ok.calls.map((c) => [c.url, c.init.method]), [['/api/auth/password-reset/confirm', 'POST']]);
  assert.deepEqual(JSON.parse(ok.calls[0].init.body), { token: TOKEN, newPassword: 'correct horse' });

  // Refused without a round trip: a link that cannot be one, a short
  // password, two that differ.
  const none = fakeFetch({});
  await withGlobals({ fetch: none }, async () => {
    assert.deepEqual(await confirmPasswordReset('not-a-token', 'correct horse', 'correct horse'), { ok: false, error: message('auth:signInSheet.reset.expired') });
    assert.deepEqual(await confirmPasswordReset(null, 'correct horse', 'correct horse'), { ok: false, error: message('auth:signInSheet.reset.expired') });
    assert.deepEqual(await confirmPasswordReset(TOKEN, 'short', 'short'), { ok: false, error: message('auth:signInSheet.reset.passwordTooShort') });
    assert.deepEqual(await confirmPasswordReset(TOKEN, 'correct horse', 'correct house'), { ok: false, error: message('auth:signInSheet.reset.passwordMismatch') });
  });
  assert.equal(none.calls.length, 0);

  // A used or expired link is the generic message; anything else the server's words.
  const used = fakeFetch({ '/api/auth/password-reset/confirm': [401, { error: 'Invalid token' }] });
  await withGlobals({ fetch: used }, async () => {
    assert.deepEqual(await confirmPasswordReset(TOKEN, 'correct horse', 'correct horse'), { ok: false, error: message('auth:signInSheet.reset.expired') });
  });
  const weak = fakeFetch({ '/api/auth/password-reset/confirm': [400, { error: 'Password too common' }] });
  await withGlobals({ fetch: weak }, async () => {
    assert.deepEqual(await confirmPasswordReset(TOKEN, 'password1', 'password1'), { ok: false, error: 'Password too common' });
  });
  const offline = fakeFetch(() => new Error('offline'));
  await withGlobals({ fetch: offline }, async () => {
    assert.deepEqual(await confirmPasswordReset(TOKEN, 'correct horse', 'correct horse'), { ok: false, error: message('auth:signInSheet.networkError') });
  });
});

test('the new-password step is a form, so Return and its button take the same path', () => {
  const sheet = read(SHEET);
  const start = sheet.indexOf("{step === 'reset' ? (\n          <form");
  assert.ok(start > 0, 'the step is a form');
  const form = sheet.slice(start, sheet.indexOf('</form>', start));
  assert.match(form, /onSubmit=\{\(e\) => \{ e\.preventDefault\(\); void chooseNewPassword\(\); \}\}/);
  assert.match(form, /<Button type="submit"/, 'drawn with the Button primitive (tests/button-primitive-ratchet.test.js)');
  assert.match(form, /id="sign-in-sheet-new-password"[^>]*autoComplete="new-password"/);
  assert.match(form, /id="sign-in-sheet-confirm-password"[^>]*autoComplete="new-password"/);
});

test('a saved password clears the fields, takes the spent link off the address, and asks for a fresh sign-in', () => {
  const sheet = read(SHEET);
  const start = sheet.indexOf('const chooseNewPassword = useCallback');
  const handler = sheet.slice(start, sheet.indexOf('const registerAccount = useCallback', start));
  assert.match(handler, /newPasswordField\.current\.value = ''/);
  assert.match(handler, /confirmPasswordField\.current\.value = ''/);
  assert.match(handler, /leaveResetAddress\(\);\s+setStep\('password'\);\s+setPasswordChanged\(true\);/);
  assert.doesNotMatch(handler, /finish\(/,
    'resetting still requires a fresh sign-in, matching the server contract');
  // The spent token is replaced, not left behind a pushed entry.
  const leave = sheet.slice(sheet.indexOf('function leaveResetAddress()'), sheet.indexOf('export function SignInSheet('));
  assert.match(leave, /if \(!\/\^#reset-password\(\?:\\\/\|\$\)\/\.test\(location\.hash\)\) return;/);
  assert.match(leave, /history\.replaceState\(null, '', screens\?\.deepLinkUrl\?\.\('#login'\) \|\| '\/#login'\);/);
  // Leaving the step without saving takes the link off the address too.
  assert.match(sheet, /data-sign-in-sheet-reset-back="" [^>]*onClick=\{\(\) => \{ leaveResetAddress\(\); toStep\('password'\); \}\}/);
});

test('the password step then carries a durable, accessible notice', () => {
  const sheet = read(SHEET);
  assert.match(sheet, /<div role="status" aria-live="polite" data-sign-in-sheet-reset-done="" className=\{DONE_NOTE\}>/);
  assert.match(sheet, /\{t\('auth:signInSheet\.passwordChanged\.title'\)\}[\s\S]{0,120}?\{t\('auth:signInSheet\.passwordChanged\.body'\)\}/);
  assert.equal(message('auth:signInSheet.passwordChanged.title'), 'Password changed');
  assert.match(message('auth:signInSheet.passwordChanged.body'), /signed out everywhere/);
  // Moving to any other step drops the one-time result.
  assert.match(sheet, /setResetSent\(false\); setPasswordChanged\(false\);/);
});

test('the completed state is directly checkable without consuming a reset token', () => {
  const { sheetOpening } = loadTsx(ROUTES);
  const done = sheetOpening('login', null, 'password-reset-complete');
  assert.equal(done.step, 'password');
  assert.equal(done.notice, 'password-changed');
  const manifest = JSON.parse(read('dapp.json'));
  const check = manifest.tests.find((item) => String(item.name || '').includes('completed password reset'));
  assert.ok(check, 'the final success state has a declared browser check');
  assert.equal(check.path, '/?shot=password-reset-complete#login');
  assert.match(check.expectSelector, /\[data-sign-in-sheet="password"\]/);
  assert.match(check.expectSelector, /\[data-sign-in-sheet-reset-done\]/);
  assert.match(read('public/js/app.js'), /shot !== 'password-reset-complete'/,
    'the signed-in capture user is held on the anonymous screens');
});

test('a link that cannot be one says so as the step opens, with a way back', () => {
  const sheet = read(SHEET);
  assert.match(sheet, /\(route\?\.step === 'reset' && !RESET_TOKEN_RE\.test\(route\.token \|\| ''\) \? translate\('auth:signInSheet\.reset\.expired'\) : null\)/);
  assert.match(message('auth:signInSheet.reset.expired'), /invalid or has expired/i);
  assert.match(message('auth:signInSheet.reset.expired'), /Forgot password\?/, 'points the person back at asking for a fresh link');
  assert.equal(message('auth:signInSheet.reset.back'), 'Sign in');
});

test('the prerendered document carries none of it', () => {
  const html = read('public/index.html');
  assert.doesNotMatch(html, /sign-in-sheet-new-password|sign-in-sheet-reset-email|reset-password-view/,
    'the sheet is drawn once it opens, never in the shipped HTML');
});
