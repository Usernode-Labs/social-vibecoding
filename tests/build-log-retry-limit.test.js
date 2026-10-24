// The Build log panel at the retry limit: banner with the last error, when,
// and whose problem it looks like; Retry disabled for non-admins; and the
// 429 body the retry route sends so the panel can explain itself.
//
// Run with: node --test tests/build-log-retry-limit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'build-log.js'), 'utf8');

function load({ canAdminWrite = false } = {}) {
  let overlay = null;
  const sandbox = {
    console,
    PlatformUI: { hasKit: () => false, toast() {} },
    App: { user: { id: 7, canAdminWrite }, _isScreenVisible: () => false },
    document: {
      createElement: () => {
        const el = { innerHTML: '', classList: { add() {} }, addEventListener() {} };
        Object.defineProperty(el, 'firstElementChild', {
          get: () => ({ classList: { add() {} }, querySelector: () => null }),
        });
        overlay = el;
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
  return { BuildLog: sandbox.__BL, html: () => overlay.innerHTML };
}

const failure = (extra = {}) => ({
  stage: 'healthcheck', reason: 'Error: boom <b>', log: 'line', at: new Date(Date.now() - 7200e3).toISOString(), ...extra,
});
const app = (extra = {}) => ({ status: 'error', created_by: 7, retry_count: 3, retryLimit: 3, lastFailure: failure(), ...extra });

test('at the limit the banner names the count, the time and the app as the culprit', () => {
  const { BuildLog, html } = load();
  BuildLog._render('my-app', app({ lastFailure: failure({ origin: 'app' }) }));
  const out = html();
  assert.match(out, /Retry limit reached \(3 of 3\)\. Ask an admin to investigate\./);
  assert.match(out, /Last error 2h ago/);
  assert.match(out, /looks like a problem in the app, not the platform/);
  assert.match(out, /id="build-log-retry"[^>]* disabled title=/);
  assert.ok(!out.includes('<b>'), 'reason text is escaped');
});

test('platform origin, stage fallback for old records, and unknown origin', () => {
  let t = load();
  t.BuildLog._render('a', app({ lastFailure: failure({ origin: 'platform' }) }));
  assert.match(t.html(), /looks like a problem on the platform/);
  t = load();
  t.BuildLog._render('a', app({ lastFailure: failure({ stage: 'clone' }) }));
  assert.match(t.html(), /looks like a problem on the platform/);
  t = load();
  t.BuildLog._render('a', app({ lastFailure: failure({ stage: 'other', origin: null }) }));
  assert.match(t.html(), /can.t tell whether the app or the platform/);
});

test('no recorded failure falls back to "Last error unavailable"', () => {
  const { BuildLog, html } = load();
  BuildLog._render('a', app({ lastFailure: null }));
  assert.match(html(), /Last error unavailable/);
});

test('below the limit there is no banner and Retry is enabled; admins can still retry', () => {
  let t = load();
  t.BuildLog._render('a', app({ retry_count: 1 }));
  assert.ok(!t.html().includes('build-log-limit'));
  assert.doesNotMatch(t.html(), /id="build-log-retry"[^>]* disabled title=/);
  t = load({ canAdminWrite: true });
  t.BuildLog._render('a', app());
  assert.match(t.html(), /As an admin you can still retry/);
  assert.doesNotMatch(t.html(), /id="build-log-retry"[^>]* disabled title=/);
});

test('the retry route answers the limit with code, counts and the last failure', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'apps.js'), 'utf8');
  const block = src.slice(src.indexOf("router.post('/api/apps/:slug/retry'"));
  const limit = block.slice(block.indexOf('status(429)'), block.indexOf('status(429)') + 500);
  for (const k of ["code: 'retry_limit'", 'retryCount:', 'retryLimit: MAX_RETRY_COUNT', 'lastFailure:']) {
    assert.ok(limit.includes(k), k);
  }
});
