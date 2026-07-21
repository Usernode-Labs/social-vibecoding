// #707: DevChat.promotePR must not surface a spurious "Network error"
// alert when the user leaves the dev chat (or switches sessions) while
// the promote request is still in flight. The request carries no abort
// signal — it runs to completion — but its completion handling is scoped
// to the session it was made for:
//
//   - stale success   → fold into the matching DevChat.sessions row (if
//                       any), never into the now-current session, no alert
//   - stale rejection → no alert (console.warn only)
//   - still-current   → behavior unchanged (fold + render, or alert)
//
// These tests execute the REAL DevChat.promotePR in a vm sandbox with
// fake DOM / fetch / alert, following tests/devchat-composer-restore.test.js.
//
// Run with: node --test tests/promote-stale-session.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'dev-chat.js'),
  'utf8'
);

function makeElement(id) {
  const classes = new Set();
  return {
    id,
    style: {},
    dataset: {},
    disabled: false,
    title: '',
    innerHTML: '',
    textContent: '',
    value: '',
    scrollHeight: 0,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (x) => classes.has(x),
      toggle: () => {},
    },
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { return c; },
    removeChild() {},
    remove() {},
    focus() {},
    blur() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

function makeHarness() {
  const registry = new Map();
  const getEl = (id) => {
    if (!registry.has(id)) registry.set(id, makeElement(id));
    return registry.get(id);
  };

  const document = {
    _title: 'MyApp',
    get title() { return this._title; },
    set title(v) { this._title = v; },
    getElementById: (id) => getEl(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeElement(`__created_${tag}`),
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
  };

  const storage = new Map();
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };

  // Spies the tests assert on: every alert(...) and console.warn(...)
  // the code under test emits is recorded here.
  const alerts = [];
  const warns = [];

  const sandbox = {
    console: { ...console, warn: (...a) => warns.push(a.map(String).join(' ')) },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    document,
    localStorage,
    AbortController,
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    alert: (msg) => alerts.push(String(msg)),
    escapeHtml: (s) => String(s == null ? '' : s),
    App: { currentTab: 'dev', currentSubTab: 'sessions' },
    Notifications: {},
    addEventListener() {},
    removeEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;

  // Neutralize render plumbing; promotePR itself stays real. renderMessages
  // is a counting spy so the still-current success path can assert on it.
  let renders = 0;
  DevChat.renderMessages = () => { renders += 1; };
  DevChat.scrollToBottom = () => {};

  return { DevChat, sandbox, document, alerts, warns, renderCount: () => renders };
}

// A fetch stub whose settlement the test controls, so state can be
// mutated (navigation, session switch) while the request is in flight.
function deferredFetch(sandbox) {
  let resolve;
  let reject;
  const gate = new Promise((res, rej) => { resolve = res; reject = rej; });
  sandbox.fetch = () => gate;
  return {
    resolveOk: (body) => resolve({ ok: true, status: 200, json: async () => body }),
    resolveErr: (status, body) => resolve({
      ok: false,
      status,
      json: async () => {
        if (body === undefined) throw new SyntaxError('Unexpected token < in JSON');
        return body;
      },
    }),
    reject: (err) => reject(err),
  };
}

const SESSION_ID = 42;

function makeBtn() {
  const btn = makeElement('promote-btn');
  btn.innerHTML = 'Propose to group';
  return btn;
}

test('navigate-away success: no alert, nothing throws', async () => {
  const { DevChat, sandbox, alerts } = makeHarness();
  const net = deferredFetch(sandbox);
  DevChat.currentSession = { id: SESSION_ID, status: 'active' };
  DevChat.sessions = [{ id: SESSION_ID, status: 'active' }];

  const done = DevChat.promotePR(makeBtn());
  // Simulate AppView.close() → DevChat.reset() mid-flight.
  DevChat.currentSession = null;
  DevChat.sessions = [];
  net.resolveOk({ prNumber: 12 });
  await done;

  assert.deepEqual(alerts, [], 'no alert after leaving the app');
});

test('stay-on-page success: status + PR fields folded in, rendered, no alert', async () => {
  const { DevChat, sandbox, alerts, renderCount } = makeHarness();
  const net = deferredFetch(sandbox);
  const session = { id: SESSION_ID, status: 'active' };
  DevChat.currentSession = session;
  DevChat.sessions = [session];

  const btn = makeBtn();
  const done = DevChat.promotePR(btn);
  net.resolveOk({ prNumber: 12, prUrl: 'https://github.com/x/y/pull/12', prTitle: 'Add dark mode' });
  await done;

  assert.equal(session.status, 'promoted');
  assert.equal(session.pr_number, 12);
  assert.equal(session.pr_url, 'https://github.com/x/y/pull/12');
  assert.equal(session.pr_title, 'Add dark mode');
  assert.equal(session.session_title, 'Add dark mode', '#249 mirror applied');
  assert.ok(renderCount() >= 1, 'renderMessages invoked');
  assert.deepEqual(alerts, [], 'no alert on success');
});

test('switched-session mid-flight: current session untouched, list row updated', async () => {
  const { DevChat, sandbox, alerts } = makeHarness();
  const net = deferredFetch(sandbox);
  const original = { id: SESSION_ID, status: 'active' };
  const other = { id: 77, status: 'active' };
  DevChat.currentSession = original;
  DevChat.sessions = [original, other];

  const done = DevChat.promotePR(makeBtn());
  // User opens a sibling session of the same app while promote runs.
  DevChat.currentSession = other;
  net.resolveOk({ prNumber: 12, prUrl: 'https://github.com/x/y/pull/12', prTitle: 'Add dark mode' });
  await done;

  assert.equal(other.status, 'active', 'now-current session NOT marked promoted');
  assert.equal(other.pr_number, undefined, 'no stale PR info on the wrong session');
  assert.equal(original.status, 'promoted', 'original list row shows the vote state');
  assert.equal(original.pr_number, 12);
  assert.equal(original.pr_url, 'https://github.com/x/y/pull/12');
  assert.equal(original.pr_title, 'Add dark mode');
  assert.equal(original.session_title, 'Add dark mode');
  assert.deepEqual(alerts, [], 'no alert on a stale success');
});

test('stale failure: no alert after navigation (server rejection AND fetch rejection)', async () => {
  // Server rejection (non-ok) after leaving.
  {
    const { DevChat, sandbox, alerts, warns } = makeHarness();
    const net = deferredFetch(sandbox);
    DevChat.currentSession = { id: SESSION_ID, status: 'active' };
    DevChat.sessions = [];
    const done = DevChat.promotePR(makeBtn());
    DevChat.currentSession = null;
    net.resolveErr(429, { error: 'You already have 3 PRs up for vote.' });
    await done;
    assert.deepEqual(alerts, [], 'no alert for a stale server rejection');
    assert.ok(warns.length >= 1, 'stale rejection logged to console.warn');
  }
  // Fetch rejection after leaving.
  {
    const { DevChat, sandbox, alerts } = makeHarness();
    const net = deferredFetch(sandbox);
    DevChat.currentSession = { id: SESSION_ID, status: 'active' };
    DevChat.sessions = [];
    const done = DevChat.promotePR(makeBtn());
    DevChat.currentSession = null;
    net.reject(new TypeError('Failed to fetch'));
    await done;
    assert.deepEqual(alerts, [], 'no alert for a stale network failure');
  }
});

test('genuine network failure while current: alert fires and the button is restored', async () => {
  const { DevChat, sandbox, alerts } = makeHarness();
  const net = deferredFetch(sandbox);
  DevChat.currentSession = { id: SESSION_ID, status: 'active' };
  DevChat.sessions = [];

  const btn = makeBtn();
  const done = DevChat.promotePR(btn);
  assert.equal(btn.disabled, true, 'button disabled while in flight');
  net.reject(new TypeError('Failed to fetch'));
  await done;

  assert.deepEqual(alerts, ['Network error'], 'real failure still alerts');
  assert.equal(btn.disabled, false, 'button restored');
  assert.equal(btn.innerHTML, 'Propose to group', 'label restored');
});

test('non-JSON error body while current shows the generic message, not "Network error"', async () => {
  const { DevChat, sandbox, alerts } = makeHarness();
  const net = deferredFetch(sandbox);
  DevChat.currentSession = { id: SESSION_ID, status: 'active' };
  DevChat.sessions = [];

  const btn = makeBtn();
  const done = DevChat.promotePR(btn);
  net.resolveErr(502 /* HTML body → res.json() throws */);
  await done;

  assert.deepEqual(alerts, ['Failed to promote'], 'proxy HTML body no longer masquerades as a network error');
  assert.equal(btn.disabled, false, 'button restored');
});
