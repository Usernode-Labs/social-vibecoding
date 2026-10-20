// #4092: the Build log panel once an app's retries are used up. It leads
// with the last recorded error, says whose problem it looks like when the
// record can tell, and says the limit in a small line under it; the retry
// route's 429 carries what the panel needs to say so.
//
// Run with: node --test tests/build-log-retry-limit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const { connectionExhaustionMessage } = require('../src/db/connection-census');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'build-log.js'), 'utf8');

function load({ canAdminWrite = false, retryReply = null } = {}) {
  const overlays = [];
  const handlers = {};
  const sandbox = {
    console,
    PlatformI18n: englishPlatformI18n(),
    PlatformUI: { hasKit: () => false, toast(text) { sandbox.toasted = text; } },
    App: { user: { id: 7, canAdminWrite }, _isScreenVisible: () => false },
    fetch: async () => retryReply,
    toasted: null,
    document: {
      createElement: () => {
        const el = { innerHTML: '', addEventListener() {}, remove() {} };
        Object.defineProperty(el, 'firstElementChild', {
          get: () => ({
            classList: { add() {} },
            querySelector: (sel) => (sel === '#build-log-retry' && el.innerHTML.includes('id="build-log-retry"')
              ? { addEventListener: (_, fn) => { handlers.retry = fn; }, textContent: '', disabled: false }
              : null),
          }),
        });
        overlays.push(el);
        return el;
      },
      body: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__BL = BuildLog;`, sandbox);
  return { BuildLog: sandbox.__BL, html: () => overlays[overlays.length - 1].innerHTML, handlers, sandbox };
}

const failure = (extra = {}) => ({
  stage: 'healthcheck', reason: 'Error: boom <b>', log: 'line', at: new Date(Date.now() - 7200e3).toISOString(), ...extra,
});
const app = (extra = {}) => ({ status: 'error', created_by: 7, retry_count: 3, retryLimit: 3, lastFailure: failure(), ...extra });

test('at the limit: the error first, whose problem it is, then the limit; no Retry for the creator', () => {
  const { BuildLog, html } = load();
  BuildLog._render('my-app', app());
  const out = html();
  const reasonAt = out.indexOf('Error: boom &lt;b&gt;');
  const originAt = out.indexOf('id="build-log-origin"');
  const limitAt = out.indexOf('id="build-log-limit"');
  assert.ok(reasonAt > 0 && originAt > reasonAt && limitAt > originAt, 'error, then origin, then limit');
  assert.ok(out.includes(message('session:buildLog.origin.app')));
  assert.ok(out.includes(message('session:buildLog.limit', { count: 3 })));
  assert.ok(!out.includes('id="build-log-retry"'), 'the creator cannot retry past the limit');
  assert.ok(!out.includes('<b>'), 'the reason is escaped');
});

test('an admin at the limit keeps Retry and is told so', () => {
  const { BuildLog, html } = load({ canAdminWrite: true });
  BuildLog._render('my-app', app());
  assert.ok(html().includes('id="build-log-retry"'));
  assert.ok(html().includes(message('session:buildLog.limitAdmin', { count: 3 })));
});

test('below the limit, or after an interrupted attempt, there is no limit line and the creator can retry', () => {
  for (const a of [app({ retry_count: 1 }), app({ lastFailure: failure({ interrupted: true }) })]) {
    const { BuildLog, html } = load();
    BuildLog._render('my-app', a);
    assert.ok(!html().includes('build-log-limit'));
    assert.ok(html().includes('id="build-log-retry"'));
  }
});

test('the platform\'s own steps read as the platform, and say why there is no log', () => {
  for (const f of [failure({ stage: 'clone', log: '' }), failure({ stage: 'repo', log: '' }), failure({ reason: `[exited] ${connectionExhaustionMessage(null, { where: 'started' })}`, log: '' })]) {
    const { BuildLog, html } = load();
    BuildLog._render('a', app({ lastFailure: f }));
    assert.match(html(), /data-origin="platform"/);
    assert.ok(html().includes(message('session:buildLog.origin.platform')));
    assert.ok(html().includes(message('session:buildLog.noLogPipeline')));
  }
});

test('a failure that cannot say whose it is gets no origin line', () => {
  for (const stage of ['timeout', 'other']) {
    const { BuildLog, html } = load();
    BuildLog._render('a', app({ lastFailure: failure({ stage, log: '' }) }));
    assert.ok(!html().includes('build-log-origin'));
    assert.ok(html().includes(message('session:buildLog.noLog')));
  }
});

test('no recorded failure at the limit says it cannot tell, not "retry to record a log"', () => {
  const { BuildLog, html } = load();
  BuildLog._render('a', app({ lastFailure: null }));
  assert.ok(html().includes(message('session:buildLog.emptyAtLimit')));
  assert.ok(!html().includes(message('session:buildLog.empty')));
});

test('a Retry refused at the limit re-renders the panel from the 429, not a toast', async () => {
  const reply = {
    ok: false,
    status: 429,
    json: async () => ({ code: 'retry_limit', retryCount: 3, retryLimit: 3, lastFailure: failure({ stage: 'clone', reason: 'fatal: expected flush after ref listing' }) }),
  };
  const t = load({ retryReply: reply });
  t.BuildLog._render('a', app({ retry_count: 2 }));
  assert.ok(t.handlers.retry, 'Retry is offered below the limit');
  await t.handlers.retry();
  assert.equal(t.sandbox.toasted, null);
  assert.ok(t.html().includes('fatal: expected flush after ref listing'));
  assert.ok(t.html().includes('id="build-log-limit"'));
  assert.match(t.html(), /data-origin="platform"/);
});

test('the retry route answers the limit with its code, the counts and the last failure; GET names the limit', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'apps.js'), 'utf8');
  const at = src.indexOf("code: 'retry_limit'");
  assert.ok(at > 0);
  const reply = src.slice(at, at + 400);
  assert.match(reply, /retryCount: appRow\.retry_count/);
  assert.match(reply, /retryLimit: MAX_RETRY_COUNT/);
  assert.match(reply, /lastFailure:/);
  assert.match(src, /retryLimit: MAX_RETRY_COUNT,\n\s+lastFailure: \(canSeeFailure/);
});

test('the home card\'s Retry opens the panel when the limit refuses it', () => {
  const src = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'features', 'home', 'home.js'), 'utf8');
  assert.match(src, /data\.code === 'retry_limit'\) window\.BuildLog\.open\(slug\)/);
  assert.equal((src.match(/Home\._retryOrExplain\(/g) || []).length, 2);
});
