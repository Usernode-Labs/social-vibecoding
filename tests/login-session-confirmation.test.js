const { loadTsx } = require('./lib/render-tsx');
const { withLanguage } = require("./lib/platform-language");
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const AUTH = fs.readFileSync(path.join(ROOT, 'public/js/auth-screens.js'), 'utf8');

function loginHarness(responses, { search = '', hash = '#login', timeout = false } = {}) {
  const requests = [];
  const users = [];
  const timers = [];
  const location = { search, hash, pathname: '/', origin: 'https://homeroom.example', href: '/#login' };
  const element = { classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, style: {} };
  const sandbox = {
    URL, URLSearchParams, AbortController, console, location,
    setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {},
    history: { replaceState(_state, _title, url) { location.href = url; } },
    document: {
      addEventListener() {}, getElementById: () => element, querySelector: () => element,
      querySelectorAll: () => [], body: element, documentElement: element,
    },
    addEventListener() {}, localStorage: { getItem() { return null; } },
    App: { clearSessionSnapshot() {}, enterAuthed(user) { users.push(user); } },
    fetch(url, options) {
      requests.push({ url, options });
      if (timeout) return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')));
        timers.at(-1)();
      });
      const response = responses.shift();
      return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(AUTH, withLanguage(sandbox));
  return { auth: sandbox.AuthScreens, requests, users, location, sandbox };
}

const success = (user = { id: 7, hasPlatformAccess: true }) => ({
  ok: true, status: 200, json: async () => ({ user }),
});

test('rejected and server responses keep the form and pending destination intact', async () => {
  for (const status of [401, 403, 429, 500, 502, 503]) {
    const { auth, requests, users, location } = loginHarness([{ ok: false, status }]);
    auth._pendingHash = '#app/example';
    const result = await auth.finishLogin();
    assert.equal(result.stage, 'session-check');
    assert.equal(result.status, status);
    assert.equal(result.code, status === 401 || status === 403 ? 'session-rejected' : 'server-response');
    assert.equal(location.href, '/#login');
    assert.equal(auth._pendingHash, '#app/example');
    assert.equal(users.length, 0);
    assert.equal(requests[0].url, '/api/auth/me');
    assert.equal(requests[0].options.credentials, 'same-origin');
    assert.equal(requests[0].options.cache, 'no-store');
  }
});

test('retry confirms the existing session and restores its deep link without another credential POST', async () => {
  const { auth, requests, users, location } = loginHarness([{ ok: false, status: 503 }, success()]);
  auth._pendingHash = '#app/example';
  assert.equal((await auth.finishLogin()).code, 'server-response');
  assert.equal(await auth.finishLogin(), null);
  assert.equal(users.length, 1);
  assert.equal(location.href, '/#app/example');
  assert.equal(auth._pendingHash, '');
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({ url, options }) => url === '/api/auth/me' && !options.method && !options.body));
});

test('network failures and malformed responses return only fixed diagnostic fields', async () => {
  const cases = [
    [new Error('PRIVATE_MESSAGE_WITH_CREDENTIAL'), 'network-error', 'session-check'],
    [{ ok: true, status: 200, json: async () => { throw new Error('PRIVATE_BODY'); } }, 'invalid-response', 'session-response'],
    [{ ok: true, status: 200, json: async () => ({}) }, 'invalid-response', 'session-response'],
    [{ ok: true, status: 200, json: async () => ({ user: 'PRIVATE_USER' }) }, 'invalid-response', 'session-response'],
  ];
  for (const [response, code, stage] of cases) {
    const { auth, location } = loginHarness([response]);
    const result = await auth.finishLogin();
    assert.equal(result.code, code);
    assert.equal(result.stage, stage);
    assert.deepEqual(Object.keys(result).sort(), ['code', 'stage', 'status']);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    assert.equal(location.href, '/#login');
  }
});

test('a stalled session check times out instead of leaving sign-in pending forever', async () => {
  const { auth, location } = loginHarness([], { timeout: true });
  const result = await auth.finishLogin();
  assert.equal(result.code, 'timeout');
  assert.equal(result.status, null);
  assert.equal(location.href, '/#login');
});

test('consent navigation waits for a confirmed session', async () => {
  const { auth, location } = loginHarness([{ ok: false, status: 401 }, success()], {
    search: '?return_to=%2Fcli%2Fauthorize',
  });
  assert.equal((await auth.finishLogin()).code, 'session-rejected');
  assert.equal(location.href, '/#login');
  await auth.finishLogin();
  assert.equal(location.href, '/cli/authorize');
});

test('a confirmed account without platform access still enters through its existing gate', async () => {
  const user = { id: 7, hasPlatformAccess: false };
  const { auth, users } = loginHarness([success(user)]);
  assert.equal(await auth.finishLogin(), null);
  assert.equal(users[0], user);
});

const frontend = path.join(ROOT, 'frontend');
const react = require(require.resolve('react', { paths: [frontend] }));
const server = require(require.resolve('react-dom/server', { paths: [frontend] }));
const jsx = require(require.resolve('react/jsx-runtime', { paths: [frontend] }));
const compiled = ts.transpileModule(fs.readFileSync(
  path.join(frontend, 'src/features/auth/session-confirmation.tsx'), 'utf8'
), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, withLanguage({
  module: mod, exports: mod.exports,
  require(specifier) {
    if (specifier === '../../lib/i18n/runtime') return withLanguage({}).PlatformI18n;
    if (specifier === '../../lib/i18n/react') return loadTsx('frontend/src/lib/i18n/react.tsx');
    if (specifier === 'react') return react;
    if (specifier === 'react/jsx-runtime') return jsx;
    if (specifier === '@/components/ui/alert') return { alertVariants: () => 'notice' };
    if (specifier === '@/components/ui/button') return { Button: ({ children, ...props }) => react.createElement('button', props, children) };
    if (specifier === './shared') return {};
    throw new Error(`Unexpected import: ${specifier}`);
  },
}));
const { browserVersions, sessionConfirmationText, SessionConfirmationNotice } = mod.exports;

test('the iPhone report identifies iOS and Chrome versions without copying the raw user agent', () => {
  const info = browserVersions('Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_2 like Mac OS X) AppleWebKit/605.1.15 CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1 PRIVATE_SUFFIX');
  assert.equal(info.operatingSystem, 'iOS 17.1.2');
  assert.equal(info.browser, 'Chrome iOS 129.0.6668.69');
  assert.doesNotMatch(JSON.stringify(info), /PRIVATE/);
  assert.equal(browserVersions('PRIVATE_USER_AGENT').browser, 'Unknown');
});

test('failure UI is absent initially and offers a session retry plus copyable, bounded diagnostics', () => {
  const empty = server.renderToStaticMarkup(react.createElement(SessionConfirmationNotice, {
    completion: { failure: null, checking: false },
  }));
  assert.equal(empty, '');
  const failure = {
    stage: 'session-check', code: 'session-rejected', status: 401,
    timestamp: '2026-10-02T20:00:00.000Z', platformBuild: 'a'.repeat(40),
    browser: 'Safari 17.1', operatingSystem: 'iOS 17.1.2', surface: 'web',
    appVersion: null, appBuild: null, username: 'PRIVATE_USERNAME', responseBody: 'PRIVATE_BODY',
  };
  const text = sessionConfirmationText(failure);
  assert.match(text, /HTTP status: 401/);
  assert.match(text, /iOS 17\.1\.2/);
  assert.doesNotMatch(text, /PRIVATE|username|password|cookie|token|responseBody/i);
  const html = server.renderToStaticMarkup(react.createElement(SessionConfirmationNotice, {
    completion: { failure, checking: false, finishLogin() {} },
  }));
  assert.match(html, /role="alert"/);
  assert.match(html, /Retry session check/);
  assert.match(html, /<details>/);
  assert.match(html, /Copy details/);
  assert.doesNotMatch(html, /PRIVATE/);
});
