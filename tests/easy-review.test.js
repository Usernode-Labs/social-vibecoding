// #918: the issue-card Easy review path. These focused browser-script tests
// pin the security-sensitive rendering and the clone -> normal promotion
// sequence without needing a full DOM. Route-source assertions complement
// them by keeping the server payload narrow and the acceptance gates server-
// computed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8'
);
const SESSIONS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'sessions.js'), 'utf8'
);

function response(ok, status, body) {
  return { ok, status, json: async () => body };
}

function harness(responses = []) {
  const calls = { fetch: [], nav: [], toasts: [] };
  const dialog = { innerHTML: '' };
  const modal = { remove() {}, querySelector: (sel) => (sel === '[role="dialog"]' ? dialog : null) };
  const button = {
    disabled: false, innerHTML: 'Accept &amp; propose', textContent: '', attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
  };
  const sandbox = {
    console,
    relTime: () => 'now',
    Kudos: { renderButton: () => '' },
    ConfirmModal: { show: async () => true },
    PlatformUI: { toast: (m) => calls.toasts.push(m) },
    document: {
      getElementById: (id) => (id === 'easy-review-modal' ? modal : null),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach() {} }),
      addEventListener() {}, removeEventListener() {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { appendChild() {} },
    },
    fetch: async (url, opts) => {
      calls.fetch.push([url, opts || {}]);
      if (!responses.length) throw new Error('unexpected fetch');
      return responses.shift();
    },
    alert() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
    App: { user: { id: 7 }, switchTab: async (...a) => calls.nav.push(a) },
    DevChat: {
      sessions: [],
      renderMarkdown: (text) => `<p>${String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`,
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._ghIssues = [{ number: 918, headless: { sessionId: 41 } }];
  return { AppView, calls, dialog, button, sandbox };
}

test('Easy review escapes filenames, diffs, check errors and blockers', () => {
  const { AppView, dialog } = harness();
  AppView._renderEasyReview(918, {
    sessionId: 41,
    title: '<img src=x onerror=alert(1)>',
    outcome: 'code',
    summary: 'safe summary',
    checkState: 'failing',
    checkError: '<script>bad()</script>',
    testResults: [{ status: 'failed', name: '<img src=x>', error: '<b>bad</b>' }],
    changedFiles: ['</code><img src=x onerror=alert(1)>'],
    diff: '<script>alert(1)</script>',
    acceptBlockedBy: ['<svg onload=alert(1)>'],
    canAccept: false,
  });
  assert.doesNotMatch(dialog.innerHTML, /<script>|<img src=x|<svg onload/);
  assert.match(dialog.innerHTML, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(dialog.innerHTML, /&lt;\/code&gt;&lt;img/);
  assert.match(dialog.innerHTML, /Accept &amp; propose/);
  assert.match(dialog.innerHTML, /disabled/);
});

test('Accept clones the reviewed run, then uses the existing promotion route', async () => {
  const clone = { id: 52, status: 'active' };
  const { AppView, calls, button, sandbox } = harness([
    response(true, 201, { session: clone }),
    response(true, 200, { prNumber: 77, prUrl: '/pr/77', prTitle: 'Easy proposal' }),
  ]);

  await AppView.acceptEasyReview(918, 41, button);

  assert.deepEqual(calls.fetch.map((c) => c[0]), [
    '/api/sessions/41/clone-headless',
    '/api/sessions/52/promote',
  ]);
  assert.equal(calls.fetch[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(calls.fetch[0][1].body), { easyAccept: true });
  assert.equal(calls.fetch[1][1].method, 'POST');
  assert.equal(clone.status, 'promoted');
  assert.equal(clone.pr_number, 77);
  assert.equal(AppView._ghIssues[0].headless.mySessionId, 52);
  assert.equal(sandbox.DevChat.sessions[0].id, 52);
  assert.deepEqual(calls.nav, [['dev', 52, 'sessions']]);
  assert.match(calls.toasts[0], /approval workflow/);
});

test('promotion failure preserves and opens the recoverable clone', async () => {
  const { AppView, calls, button, sandbox } = harness([
    response(true, 201, { session: { id: 53, status: 'active' } }),
    response(false, 409, { error: 'Checks moved back to pending.' }),
  ]);

  await AppView.acceptEasyReview(918, 41, button);

  assert.equal(sandbox.DevChat.sessions[0].id, 53);
  assert.deepEqual(calls.nav, [['dev', 53, 'sessions']]);
  assert.match(calls.toasts[0], /Checks moved back to pending/);
  assert.match(calls.toasts[0], /saved session is open/);
});

test('clone failure stays in Easy review and restores the Accept button', async () => {
  const { AppView, calls, button } = harness([
    response(false, 429, { error: 'Session limit reached.' }),
  ]);

  await AppView.acceptEasyReview(918, 41, button);

  assert.deepEqual(calls.nav, []);
  assert.equal(button.disabled, false);
  assert.equal(button.innerHTML, 'Accept &amp; propose');
  assert.equal(button.attrs['aria-busy'], undefined);
  assert.equal(calls.toasts[0], 'Session limit reached.');
});

test('Easy review route is headless-only, narrow, diff-capped and governance-gated', () => {
  const start = SESSIONS_SRC.indexOf("router.get('/api/sessions/:id/easy-review'");
  const end = SESSIONS_SRC.indexOf('// Get session with message history', start);
  assert.ok(start > 0 && end > start, 'route block found');
  const route = SESSIONS_SRC.slice(start, end);
  assert.match(route, /cs\.is_headless = TRUE/);
  assert.match(route, /appAccess\.checkAppAccess/);
  assert.match(route, /'collab'/);
  assert.match(route, /cs\.headless_status/);
  assert.match(route, /role = 'assistant'/);
  assert.doesNotMatch(route, /SELECT id, role, content, model, token_count, cost_cents/);
  assert.match(route, /github\.getProposalDiff/);
  assert.match(SESSIONS_SRC, /governance\.isApprover/);
  assert.match(SESSIONS_SRC, /async function canEasyAccept/);
  assert.match(SESSIONS_SRC, /appAdmins\.canManageApp/);
  assert.match(route, /\['passing', 'skipped'\]/);
  assert.match(route, /canAccept: eligibleReviewer && reviewComplete/);
  const cloneStart = SESSIONS_SRC.indexOf("router.post('/api/sessions/:id/clone-headless'");
  const reviewStart = SESSIONS_SRC.indexOf("router.get('/api/sessions/:id/easy-review'");
  const cloneRoute = SESSIONS_SRC.slice(cloneStart, reviewStart);
  assert.match(cloneRoute, /req\.body\?\.easyAccept === true/);
  assert.match(cloneRoute, /await canEasyAccept/);
  assert.match(cloneRoute, /\['code', 'spec_code'\]/);
  assert.match(cloneRoute, /\['passing', 'skipped'\]/);
});
