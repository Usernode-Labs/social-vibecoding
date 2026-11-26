'use strict';

// One sign-in: the sheet. The full-page sign-in screen (login.tsx: password,
// email code, recovery, reset) and the activation-code screen (register.tsx)
// are gone, and their addresses open the landing's sign-in sheet at the step
// each page was for:
//
//   #login → password · #login/forgot → reset link · #signup[/<address>] →
//   email (the code sent once per tab) · #reset-password/<token> → new
//   password · #register[/<code>] → activation code
//
// Mails already sent link to every one of these, so each must keep opening
// something. This pins the joins: the router keeps the route for the landing
// (public/js/auth-screens.js), the landing opens the sheet at the step
// (features/auth/landing.tsx, sign-in-routes.ts), and the sheet draws the
// steps the pages had. Effects do not run under renderToStaticMarkup, so the
// router runs in a vm sandbox and the exchanges against a fake fetch.
//
// Run with: node --test tests/sign-in-routes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const AUTH_SCREENS = read('public/js/auth-screens.js');
const SHEET = 'frontend/src/features/auth/sign-in-sheet.tsx';
const ROUTES = 'frontend/src/features/auth/sign-in-routes.ts';
const LANDING = 'frontend/src/features/auth/landing.tsx';

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

/** The router in a sandbox, with the landing's on-show hook recorded. */
function router() {
  const visible = {};
  const shown = [];
  const element = { classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, style: {} };
  const sandbox = {
    URL, URLSearchParams, AbortController, console,
    location: { search: '', hash: '', pathname: '/', origin: 'https://homeroom.example' },
    setTimeout() { return 1; }, clearTimeout() {},
    history: { replaceState() {} },
    document: { addEventListener() {}, getElementById: () => element, querySelectorAll: () => [] },
    addEventListener() {},
  };
  sandbox.window = sandbox;
  vm.runInNewContext(AUTH_SCREENS, sandbox);
  const auth = sandbox.AuthScreens;
  auth._setVisibleFor = visible;
  auth._landingOnShow = () => { shown.push(auth._signInRoute ? { ...auth._signInRoute } : null); };
  sandbox.App = { _setScreenVisible(id, on) { visible[id] = on; } };
  return { auth, shown, visible };
}

// ─── the router ─────────────────────────────────────────────────────

test('each sign-in address is the landing, with its route kept for the sheet', () => {
  const { auth, shown, visible } = router();
  for (const route of ['login', 'signup', 'register', 'reset-password']) {
    assert.equal(auth.routeFromHash(`${route}/x`), route, `#${route} is still a route`);
  }
  auth.show('login', 'forgot');
  assert.deepEqual(shown.pop(), { route: 'login', seg: 'forgot' });
  assert.equal(visible['auth-landing-screen'], true, 'the landing is what shows');
  assert.equal(visible['auth-login-screen'], undefined, 'no screen of its own any more');
  auth.show('signup', 'ada%40example.com');
  assert.deepEqual(shown.pop(), { route: 'signup', seg: 'ada%40example.com' });
  auth.show('reset-password', 'f'.repeat(64));
  assert.deepEqual(shown.pop(), { route: 'reset-password', seg: 'f'.repeat(64) });
  auth.show('register');
  assert.deepEqual(shown.pop(), { route: 'register', seg: null });
  // The landing itself carries no route, so a Back to #landing closes the sheet.
  auth.show('landing');
  assert.equal(shown.pop(), null);
  // The old screens' hooks are gone from the router.
  for (const hook of ['_loginOnShow', '_resetOnShow', '_registerOnShow', '_wireLogin', '_wireRegister', '_walletDetect']) {
    assert.equal(auth[hook], undefined, hook);
  }
});

test('the landing takes the route once, and only one it answers', async () => {
  const { takeSignInRoute } = loadTsx(ROUTES);
  const host = { _signInRoute: { route: 'login', seg: 'forgot' } };
  await withGlobals({ window: { AuthScreens: host } }, () => {
    assert.deepEqual(takeSignInRoute(), { route: 'login', seg: 'forgot' });
    assert.equal(takeSignInRoute(), null, 'read once');
    host._signInRoute = { route: 'waiting', seg: null };
    assert.equal(takeSignInRoute(), null, 'not a sign-in address');
    host._signInRoute = { route: 'register', seg: '' };
    assert.deepEqual(takeSignInRoute(), { route: 'register', seg: null });
  });
});

test('each address opens the step its page was for', () => {
  const { sheetOpening } = loadTsx(ROUTES);
  const step = (route, seg, shot = null) => sheetOpening(route, seg, shot);
  assert.equal(step('login', null).step, 'password');
  assert.equal(step('login', 'forgot').step, 'forgot');
  assert.equal(step('signup', null).step, 'email');
  assert.equal(step('signup', 'ada%40example.com').email, 'ada@example.com');
  assert.equal(step('reset-password', 'f'.repeat(64)).step, 'reset');
  assert.equal(step('register', null).step, 'register');
  assert.equal(step('register', 'ABC%20123').code, 'ABC 123', 'the code arrives decoded, as the page took it');
  // The screenshot states that used to paint the pages paint the sheet.
  assert.equal(step('login', null, 'password-reset-complete').notice, 'password-changed');
  assert.equal(step('login', null, 'email-code-password-account').notice, 'password-account');
  assert.equal(step('login', null, 'password-recovery').step, 'forgot');
  assert.equal(step('signup', 'demo%40example.invalid', 'signup-code-sent').step, 'code');
});

test('the boot draws the landing for each address, and the old roots are nobody\'s', () => {
  const app = read('public/js/app.js');
  assert.doesNotMatch(app, /'auth-login-screen'|'auth-register-screen'/);
  const shared = read('frontend/src/features/auth/shared.ts');
  assert.match(shared, /login: 'auth-landing-screen',\s+signup: 'auth-landing-screen',\s+register: 'auth-landing-screen',/);
  assert.match(shared, /'reset-password': 'auth-landing-screen',/);
  assert.ok(!fs.existsSync(path.join(ROOT, 'frontend/src/features/auth/login.tsx')));
  assert.ok(!fs.existsSync(path.join(ROOT, 'frontend/src/features/auth/register.tsx')));
  assert.doesNotMatch(read('frontend/src/Shell.tsx'), /LoginScreen|RegisterScreen/);
});

// ─── the landing ────────────────────────────────────────────────────

test('the landing opens the sheet for an address, story or no story, and closing it is the landing again', () => {
  const src = read(LANDING);
  // Rendered on its own condition, not under the story's.
  assert.match(src, /\{routeSheet \? \(\s+<SignInSheet\s+open\s+title=\{routeSheet\.opening\.route === 'signup' \? t\('auth:landing\.sheet\.continue'\) : t\('auth:landing\.sheet\.signIn'\)\}/);
  assert.match(src, /route=\{routeSheet\.opening\}/);
  assert.match(src, /onClose=\{closeRouteSheet\}/);
  // The story's own sheet stands down while it is up.
  assert.match(src, /open=\{!gate && !intent && !routeSheet && \(sheet === 'start' \|\| sheet === 'signin'\)\}/);
  // Closed: the landing's own address, with no history entry, through the router.
  const close = src.slice(src.indexOf('const closeRouteSheet = useCallback'), src.indexOf('}, []);', src.indexOf('const closeRouteSheet = useCallback')));
  assert.match(close, /setRouteSheet\(null\);/);
  assert.match(close, /history\.replaceState\(history\.state, '', legacy\(\)\.App\?\._rootUrl\?\.\('#landing'\) \?\? '\/#landing'\);/);
  assert.match(close, /\?\.\('landing'\);/);
  // Every show re-derives it, so Back to #landing takes it down.
  assert.match(src, /setRouteSheet\(signInRoute \? \{/);
});

// ─── the steps the pages had ────────────────────────────────────────

function sheetAt(route, extra = {}) {
  const { SignInSheet } = loadTsx(SHEET);
  return renderToHtml(createElement(SignInSheet, {
    open: true, title: 'Sign in', from: 'signin', onClose() {}, primaryClass: 'pill',
    route: { route: 'login', step: 'password', email: null, codeSent: false, token: null, code: null, resetSent: false, notice: null, ...route },
    ...extra,
  }));
}

test('#reset-password/<token> draws the new password twice, under its title, with a way back', () => {
  const html = sheetAt({ route: 'reset-password', step: 'reset', token: 'f'.repeat(64) });
  assert.match(html, /data-sign-in-sheet="reset"/);
  assert.ok(html.includes(message('auth:signInSheet.reset.title')));
  assert.ok(html.includes(message('auth:signInSheet.reset.lead').replace(/'/g, '&#x27;')));
  assert.match(html, /id="sign-in-sheet-new-password"/);
  assert.match(html, /id="sign-in-sheet-confirm-password"/);
  assert.match(html, /data-sign-in-sheet-reset-back=""/);
  assert.ok(html.includes(message('auth:signInSheet.reset.submit')));
  // It makes no account, so it says no terms.
  assert.doesNotMatch(html, /By continuing/);
});

test('#register[/<code>] draws the code, the username and the password, the code filled in', () => {
  const html = sheetAt({ route: 'register', step: 'register', code: 'ABC-123' });
  assert.match(html, /data-sign-in-sheet="register"/);
  assert.ok(html.includes(message('auth:signInSheet.register.title')));
  assert.match(html, /<input[^>]*id="sign-in-sheet-reg-code"[^>]*value="ABC-123"|<input[^>]*value="ABC-123"[^>]*id="sign-in-sheet-reg-code"/);
  assert.match(html, /id="sign-in-sheet-reg-username"/);
  assert.match(html, /id="sign-in-sheet-reg-password"/);
  assert.ok(html.includes(message('auth:signInSheet.register.submit')));
  assert.match(html, /data-sign-in-sheet-to-password=""/, '"Already have an account? Sign in" is the password step');
  // It makes an account, so its foot says the terms.
  assert.match(html, /By continuing, you agree/);
});

test('#login is the password step with the Email code | Password switch and Forgot password?', () => {
  const html = sheetAt({ step: 'password' });
  assert.match(html, /data-sign-in-sheet="password"/);
  assert.match(html, /data-sign-in-sheet-method-password=""[^>]*>Password</);
  assert.match(html, /aria-checked="true" data-sign-in-sheet-method-password=""/);
  assert.match(html, /data-sign-in-sheet-forgot=""/);
});

// ─── the exchanges ──────────────────────────────────────────────────

test('the activation code makes the account through the session-mint boundary, and a refusal names its field', async () => {
  const { registerWithCode } = loadTsx(ROUTES);
  const ok = fakeFetch({ '/api/auth/register': [200, { user: { id: 7 } }] });
  await withGlobals({ window: {}, fetch: ok }, async () => {
    assert.deepEqual(await registerWithCode(' ABC ', ' ada ', 'correct horse'), { ok: true });
  });
  assert.equal(ok.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(ok.calls[0].init.body), { code: 'ABC', username: 'ada', password: 'correct horse' });
  const named = fakeFetch({ '/api/auth/register': [400, { error: 'Usernames use letters, numbers and underscores.', field: 'username' }] });
  await withGlobals({ window: {}, fetch: named }, async () => {
    assert.deepEqual(await registerWithCode('ABC', 'a b', 'correct horse'), {
      ok: false, error: 'Usernames use letters, numbers and underscores.', field: 'username', details: null,
    });
  });
  const used = fakeFetch({ '/api/auth/register': [400, { error: 'Invalid or already used activation code' }] });
  await withGlobals({ window: {}, fetch: used }, async () => {
    const answer = await registerWithCode('USED', 'ada', 'correct horse');
    assert.equal(answer.field, null);
    assert.equal(answer.error, 'Invalid or already used activation code');
  });
  const bare = fakeFetch({ '/api/auth/register': [500, {}] });
  await withGlobals({ window: {}, fetch: bare }, async () => {
    assert.equal((await registerWithCode('ABC', 'ada', 'correct horse')).error, message('auth:signInSheet.register.failed'));
  });
  // The step finishes like every other sign-in, a new account.
  assert.match(read(SHEET), /setError\(result\.error\);\s+setDetails\(result\.details\);\s+return;\s+\}\s+await finish\('new'\);/);
});

test('inside the Homeroom app, a linked wallet still signs in and resets, and outside it nothing is asked', async () => {
  const { probeWallet, walletSignIn, walletReset } = loadTsx(ROUTES);
  const none = fakeFetch({});
  await withGlobals({ window: {}, fetch: none }, async () => {
    assert.equal(await probeWallet(), null, 'a browser has no wallet to ask');
  });
  assert.equal(none.calls.length, 0);

  const signed = [];
  const app = {
    usernode: { isNative: true },
    NativeChrome: { prepareForLogin: async () => {} },
    getNodeAddress: async () => 'pub-1',
    signMessage: async (challenge) => { signed.push(challenge); return { publicKey: 'pk', signature: 'sig' }; },
  };
  let challenges = 0;
  const fetch = fakeFetch((url) => {
    if (url === '/api/auth/wallet-check') { challenges += 1; return [200, { status: 'linked', isGenesis: true, challenge: `c${challenges}` }]; }
    if (url === '/api/auth/wallet-verify') return [200, { user: {} }];
    if (url === '/api/auth/wallet-reset-verify') return [200, { user: {} }];
    return [404, {}];
  });
  await withGlobals({ window: app, fetch }, async () => {
    const wallet = await probeWallet();
    assert.deepEqual({ ...wallet }, { pubkey: 'pub-1', linked: true, challenge: 'c1' });
    assert.deepEqual(await walletSignIn(wallet), { ok: true });
    assert.equal(wallet.challenge, null, 'a challenge is spent once');
    assert.deepEqual(await walletReset(wallet, 'short', 'short'), { ok: false, error: message('auth:signInSheet.reset.passwordTooShort') });
    assert.deepEqual(await walletReset(wallet, 'correct horse', 'correct horse'), { ok: true });
  });
  assert.deepEqual(signed, ['c1', 'c2'], 'the reset signs a fresh challenge');
  const verify = fetch.calls.find((c) => c.url === '/api/auth/wallet-verify');
  assert.deepEqual(JSON.parse(verify.init.body), { pubkey: 'pub-1', publicKey: 'pk', challenge: 'c1', signature: 'sig' });
  const reset = fetch.calls.find((c) => c.url === '/api/auth/wallet-reset-verify');
  assert.equal(JSON.parse(reset.init.body).newPassword, 'correct horse');

  // A non-genesis wallet can reset but not sign in; an unlinked one neither.
  const plain = fakeFetch({ '/api/auth/wallet-check': [200, { status: 'linked', isGenesis: false, challenge: 'c' }] });
  await withGlobals({ window: app, fetch: plain }, async () => {
    assert.deepEqual({ ...(await probeWallet()) }, { pubkey: 'pub-1', linked: true, challenge: null });
  });
  const unlinked = fakeFetch({ '/api/auth/wallet-check': [200, { status: 'unlinked' }] });
  await withGlobals({ window: app, fetch: unlinked }, async () => {
    assert.deepEqual({ ...(await probeWallet()) }, { pubkey: 'pub-1', linked: false, challenge: null });
  });
  // The sheet draws what each allows.
  const sheet = read(SHEET);
  assert.match(sheet, /\{walletFast \? \(\s+<>\s+<button type="button" data-sign-in-sheet-wallet=""/);
  assert.match(sheet, /\{step === 'forgot' && wallet\?\.linked \? \(\s+<form data-sign-in-sheet-wallet-reset=""/);
  assert.equal(message('auth:signInSheet.wallet.submit'), 'Sign in with Wallet');
});
