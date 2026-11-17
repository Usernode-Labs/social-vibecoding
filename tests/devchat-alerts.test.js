// Settings › Alerts' "Send a test alert", and the one bell a finished
// change lands on.
//
// The pane's ids still say `devchat-alerts`, after the dev chat whose
// completion alerts (#138: a chime, or an OS notification) the pane first
// held. That chime, its switch and public/js/dev-alerts.js are retired with
// the dev chat. What stays is pinned here:
//
//   1. The bell (#1610): every unread kind, a finished change's included,
//      is one count on #notifications-badge, which carries the finished
//      subset as `data-session-done` for a declared check.
//   2. "Send a test alert": the server queues a test push for the phone and
//      delays it (POST /api/me/test-alert, services/test-alert.js; the route
//      is tests/mobile-push-preferences-route.test.js's), and settings.js
//      counts down to it, says why when nothing was queued, and never claims
//      a delivery it cannot see.
//
// Run with: node --test tests/devchat-alerts.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { shellMarkup } = require('./lib/shell-markup');

// #1808: notifications.js has one bundle import (`agoStamp` from
// lib/timestamp.ts, which gave the rows a stamp with a floor). This harness
// evaluates the shipped source raw in a vm, so it stands in for the bundler:
// the import statement is dropped and the REAL helper is put in the sandbox
// under the same name, so a row's stamp is the one that ships.
const { agoStamp } = require('./lib/render-tsx').loadTsx('frontend/src/lib/timestamp.ts');
const NOTIF_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'notifications', 'notifications.js'), 'utf8')
  .replace(/^import \{ agoStamp \}.*$/m, '');
const SETTINGS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'settings', 'settings.js'), 'utf8');

// Minimal fake DOM element tracking class list, text and attributes for the
// badge tests.
class FakeEl {
  constructor() {
    this.textContent = '';
    this.disabled = false;
    this.dataset = {};
    this.attributes = {};
    this._cls = new Set(['hidden']);
    const self = this;
    this.classList = {
      add: (c) => self._cls.add(c),
      remove: (c) => self._cls.delete(c),
      contains: (c) => self._cls.has(c),
      toggle: () => {},
    };
  }
  get hidden() { return this._cls.has('hidden'); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name] : null;
  }
}

// Load notifications.js in a sandbox and return its Notifications object plus
// the fake bell elements, so _renderBadge's single count can be asserted.
function makeNotifEnv() {
  const elements = {};
  const getEl = (id) => (elements[id] || (elements[id] = new FakeEl()));
  const sandbox = { console, Date, JSON, Math, Set, Map };
  sandbox.window = sandbox;
  // #1610 retired Improve.setSessionBadge along with the split it fed. The
  // controller is still exposed so a stray call would be visible rather than
  // throwing silently past this env; nothing should reach for it.
  sandbox.Improve = {};
  sandbox.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  sandbox.document = {
    title: 'My App',
    getElementById: getEl,
    addEventListener: () => {},
    createElement: () => ({ set textContent(v) { this._t = v; }, get innerHTML() { return this._t || ''; } }),
  };
  sandbox.agoStamp = agoStamp;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.runInNewContext(NOTIF_SRC, sandbox);
  return { Notifications: sandbox.window.Notifications, elements, sandbox };
}

// ── one bell, one count (#1610) ──────────────────────────────────────────

test('every unread kind lands on the bell, sessions included', () => {
  const { Notifications, elements } = makeNotifEnv();
  Notifications.items = [
    { id: 1, kind: 'session_done', readAt: null },
    { id: 2, kind: 'auto_solve_done', readAt: null },
    { id: 3, kind: 'mention', readAt: null },
    { id: 4, kind: 'kudos', readAt: '2020-01-01T00:00:00Z' }, // read → ignored
  ];
  Notifications.unread = 3; // the three unread above
  Notifications.invites = [{ appId: 9 }];
  Notifications._renderBadge();

  const bell = elements['notifications-badge'];
  // 3 unread + 1 pending invite. Nothing is subtracted: the split that used
  // to take the session kinds out of this number put them on a control that
  // could not clear them, which is the bug #1610 fixed.
  assert.equal(bell.textContent, '4', 'bell = every unread + invites');
  assert.equal(bell.hidden, false);
  assert.equal(Number(bell.textContent), Notifications.unread + Notifications.invites.length);
  // The session_done subset rides along as an attribute so a declared check
  // can prove the badge is up BECAUSE work finished.
  assert.equal(bell.attributes['data-session-done'], '1');
});

test('nothing is published to the Improve button any more', () => {
  const { Notifications, elements } = makeNotifEnv();
  Notifications.items = [{ id: 1, kind: 'session_done', readAt: null }];
  Notifications.unread = 1;
  Notifications.invites = [];
  Notifications._renderBadge();
  // A finished session raises the BELL, alone.
  assert.equal(elements['notifications-badge'].textContent, '1');
  assert.equal(elements['notifications-badge'].hidden, false);
  assert.ok(!('notifications-badge-ai' in elements),
    'the retired green badge must not be resolved by id');
  assert.ok(!/window\.Improve\.setSessionBadge/.test(NOTIF_SRC),
    'the publish onto #improve-btn is gone from the module');
});

test('the bell count falls to zero and hides', () => {
  const { Notifications, elements } = makeNotifEnv();
  Notifications.items = [{ id: 1, kind: 'session_done', readAt: '2020-01-01T00:00:00Z' }];
  Notifications.unread = 0;
  Notifications.invites = [];
  Notifications._renderBadge();
  assert.equal(elements['notifications-badge'].hidden, true);
  assert.equal(elements['notifications-badge'].attributes['data-session-done'], '0');
});

test('the shell ships the test-alert button and the bell, and no dev-chat alert', () => {
  const html = shellMarkup();
  assert.match(html, /id="devchat-alerts-test"/);
  assert.match(html, /id="devchat-alerts-test-status"/);
  // The chime's switch and its classic script went with the dev chat.
  assert.ok(!html.includes('id="devchat-alerts-toggle"'), 'no completion-chime switch');
  assert.ok(!html.includes('src="/js/dev-alerts.js"'), 'no dev-alerts.js tag');
  // #1610: the completed-task count is the bell's, and the Improve button
  // keeps only a live working pulse.
  assert.match(html, /id="notifications-badge"[^>]*data-session-done="0"/);
  assert.ok(!html.includes('id="notifications-badge-ai"'),
    'the green count on #improve-btn is retired');
});

// ── Send a test alert ───────────────────────────────────────────────────

const TEST_ALERT = SETTINGS_SRC.slice(
  SETTINGS_SRC.indexOf("      const alertsTest = document.getElementById('devchat-alerts-test');"),
  SETTINGS_SRC.indexOf('// Account-level remote-push categories'),
);

test('the button asks the server to queue the push, and counts down each second', () => {
  assert.ok(TEST_ALERT.length > 200, 'located the test-alert wiring');
  assert.match(TEST_ALERT, /fetch\('\/api\/me\/test-alert', \{\s*method: 'POST',\s*credentials: 'same-origin',/);
  // A real interval that rewrites the status text each second, counted by
  // `remaining` through one whole catalog sentence.
  assert.match(TEST_ALERT, /this\._alertsTestTimer = setInterval\(/);
  assert.match(TEST_ALERT, /status\.textContent = tr\('settings:alerts\.test\.countdown\.queued', \{ count: remaining \}\);/);
  for (const remaining of [10, 1]) {
    assert.match(message('settings:alerts.test.countdown.queued', { count: remaining }),
      new RegExp(`^Alert in ${remaining}s\\. `), `counts down from ${remaining}`);
  }
  // Cleared on modal close so a countdown can't outlive the panel.
  const close = SETTINGS_SRC.slice(SETTINGS_SRC.indexOf('close() {'), SETTINGS_SRC.indexOf('close() {') + 400);
  assert.match(close, /_clearAlertsTestCountdown\(\)/);
});

test('settings reports queue outcomes and never turns a countdown into a delivery claim', async () => {
  for (const [response, expected] of [
    [{ ok: true, body: { queued: true, delayMs: 10000 } }, /queued for delivery/],
    [{ ok: true, body: { queued: false, reason: 'preference_disabled', delayMs: 10000 } }, /Turn on Your coding agent/],
    [{ ok: true, body: { queued: false, reason: 'no_eligible_device', delayMs: 10000 } }, /Sign in on your phone/],
    [{ ok: false, body: { error: 'Please wait a minute' } }, /Please wait a minute/],
  ]) {
    const button = new FakeEl();
    const status = new FakeEl();
    let handler;
    let tick;
    const requests = [];
    button.addEventListener = (_event, fn) => { handler = fn; };
    const sandbox = {
      document: { getElementById: (id) => id === 'devchat-alerts-test' ? button : status },
      fetch: async (url, options) => {
        requests.push({ url, options });
        return { ok: response.ok, json: async () => response.body };
      },
      setInterval: (fn) => { tick = fn; return 1; },
      clearInterval() {},
      _clearAlertsTestCountdown() {},
      // The slice reads its text through settings.js's `tr`.
      tr: englishPlatformI18n().t,
    };
    sandbox.window = sandbox;
    vm.runInNewContext(TEST_ALERT, sandbox);
    await handler();
    if (tick) for (let i = 0; i < 10; i += 1) tick();
    assert.equal(requests.length, 1, 'one request per press');
    assert.equal(requests[0].url, '/api/me/test-alert');
    assert.match(status.textContent, expected);
    assert.doesNotMatch(status.textContent, /Sent\.|successfully delivered/i);
    assert.equal(button.disabled, false);
  }
});
