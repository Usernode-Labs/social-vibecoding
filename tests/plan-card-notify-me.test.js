// "Notify me when it's ready" under Homeroom bot's plan (5 October; #4046).
//
// After Build it is pressed in the bot's chat, the bot's line under the plan
// offers to notify its maker when the first version is ready. This file pins:
//
//   1. NativeChrome.decideReadyPing, the pure rule, and notifyWhenReady, the
//      tap's door to the permission: the iOS prompt only while undetermined,
//      Android's own notification permission (never the alarm one), nothing
//      to ask in a browser, a confirmation when it is allowed already, and
//      the OS settings page as the way back from a denial.
//   2. The button: offered while the first version is being built, asks
//      nothing until it is tapped, says what will happen once it is, and is
//      not offered again to an account that chose on this device.
//
// Run with: node --test tests/plan-card-notify-me.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const nativeChromeSource = read('public', 'js', 'native-chrome.js');

/**
 * public/js/native-chrome.js in a sandbox, with a Homeroom app behind it.
 *
 * opts: { native (default true), platform ('ios' | 'android'), permissions
 *   (the settings snapshot's), capabilities, pushState, iosAnswer,
 *   androidAnswer, socialPush ({ enabled }) }
 */
function boot(opts = {}) {
  const calls = { requestPermissions: 0, requestNotificationPermission: 0, settingsReads: 0, setEnabled: [], pushReads: 0 };
  const storage = new Map();
  const platform = opts.platform || 'ios';
  const permissions = opts.permissions === undefined
    ? { platform, notificationPermission: 'notDetermined' }
    : opts.permissions;
  const capabilities = opts.capabilities || [
    'getSettingsState', 'getSocialPushState', 'requestPermissions',
    'requestNotificationPermission', 'openNotificationSettings',
  ];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    App: { user: { id: 7 } },
    unNative: { platform, toast() {} },
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); },
    },
    document: {
      visibilityState: 'visible',
      getElementById() { return null; },
      createElement() { return {}; },
      addEventListener() {},
      removeEventListener() {},
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    // Real, ref'd timers: the iOS grant settle polls on one.
    setTimeout,
    clearTimeout,
    setInterval() { return 0; },
    SocialPush: opts.socialPush === null ? undefined : {
      async getState() { calls.pushReads += 1; return { enabled: true, ...(opts.socialPush || {}) }; },
      async setEnabled(on) { calls.setEnabled.push(on); return { enabled: on }; },
    },
  };
  sandbox.usernode = opts.native === false ? { isNative: false } : {
    isNative: true,
    async getBridgeInfo() { return { version: 5, capabilities }; },
    async getSettingsState() {
      calls.settingsReads += 1;
      return permissions ? { permissions } : null;
    },
    async getSocialPushState() { return opts.pushState === undefined ? null : opts.pushState; },
    async requestPermissions() {
      calls.requestPermissions += 1;
      const answer = opts.iosAnswer || 'authorized';
      permissions.notificationPermission = answer;
      return { granted: answer === 'authorized', permissions: { ...permissions } };
    },
    async requestNotificationPermission() {
      calls.requestNotificationPermission += 1;
      const granted = opts.androidAnswer !== 'denied';
      return { granted, permissions: { ...permissions, notificationsGranted: granted } };
    },
    async openNotificationSettings() { return true; },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(nativeChromeSource, sandbox);
  sandbox.NativeChrome._FIRST_RUN_RECHECK_MS = 1;
  return { sandbox, calls, storage, NativeChrome: sandbox.NativeChrome };
}

// ── 1. The rule, and the door ──────────────────────────────────────────

test('decideReadyPing: confirm when allowed, ask only what can be asked, never in a browser', () => {
  const { NativeChrome } = boot();
  const decide = (over) => NativeChrome.decideReadyPing({
    isNative: true, platform: 'ios', permission: 'undetermined', canRequest: true, ...over,
  }).verdict;
  assert.equal(decide({}), 'ask');
  assert.equal(decide({ permission: null }), 'ask', 'unreadable: the tap may try, and the settle reads the answer');
  assert.equal(decide({ permission: 'granted' }), 'granted', 'already allowed: confirm, ask nothing');
  assert.equal(decide({ permission: 'denied' }), 'denied', 'iOS shows no prompt once it is denied');
  assert.equal(decide({ canRequest: false }), 'unknown');
  assert.equal(decide({ canRequest: false, permission: 'denied' }), 'denied');
  assert.equal(decide({ platform: 'android', permission: 'denied' }), 'ask', 'Android asks again');
  assert.equal(decide({ platform: 'android', permission: 'granted' }), 'granted');
  assert.equal(decide({ isNative: false }), 'no-app', 'no web push: nothing to ask in a browser');
  assert.equal(NativeChrome.decideReadyPing().verdict, 'no-app', 'nothing known is a browser, never a throw');
});

test('notifyWhenReady on iOS: undetermined presents the OS prompt once, and a grant registers', async () => {
  const h = boot({ socialPush: { enabled: false } });
  const answer = await h.NativeChrome.notifyWhenReady();
  assert.deepEqual({ ...answer }, { outcome: 'granted', settings: false });
  assert.equal(h.calls.requestPermissions, 1);
  assert.equal(h.calls.requestNotificationPermission, 0);
  assert.equal(h.storage.get('sv:ping_ask_prompted'), '1', 'the same record askForPing keeps');
  assert.deepEqual(h.calls.setEnabled, [true], 'this phone\'s Activity notifications back on: that is what was asked for');
});

test('notifyWhenReady on iOS: already allowed confirms without a prompt; denied offers the settings page', async () => {
  const allowed = boot({ permissions: { platform: 'ios', notificationPermission: 'authorized' } });
  assert.deepEqual({ ...(await allowed.NativeChrome.notifyWhenReady()) }, { outcome: 'granted', settings: false });
  assert.equal(allowed.calls.requestPermissions, 0, 'nothing to ask');
  assert.deepEqual(allowed.calls.setEnabled, [], 'a switch that is on is left alone');

  const denied = boot({ permissions: { platform: 'ios', notificationPermission: 'denied' } });
  assert.deepEqual({ ...(await denied.NativeChrome.notifyWhenReady()) }, { outcome: 'denied', settings: true });
  assert.equal(denied.calls.requestPermissions, 0, 'a prompt iOS would not show is not asked for');

  const noSettings = boot({
    permissions: { platform: 'ios', notificationPermission: 'denied' },
    capabilities: ['getSettingsState', 'requestPermissions'],
  });
  assert.deepEqual({ ...(await noSettings.NativeChrome.notifyWhenReady()) }, { outcome: 'denied', settings: false },
    'no way to the settings page on this build: no button that does nothing');

  const said = boot({ iosAnswer: 'denied' });
  assert.deepEqual({ ...(await said.NativeChrome.notifyWhenReady()) }, { outcome: 'denied', settings: true },
    '"Don\'t Allow" on the prompt itself');
  assert.equal(said.calls.requestPermissions, 1);
});

test('notifyWhenReady on Android asks for notifications, never the alarm permission', async () => {
  const h = boot({ platform: 'android', permissions: { platform: 'android', notificationsGranted: false } });
  assert.deepEqual({ ...(await h.NativeChrome.notifyWhenReady()) }, { outcome: 'granted', settings: false });
  assert.equal(h.calls.requestNotificationPermission, 1);
  assert.equal(h.calls.requestPermissions, 0, 'requestPermissions() is the exact-alarm permission on Android');

  const allowed = boot({ platform: 'android', permissions: { platform: 'android', notificationsGranted: true } });
  assert.deepEqual({ ...(await allowed.NativeChrome.notifyWhenReady()) }, { outcome: 'granted', settings: false });
  assert.equal(allowed.calls.requestNotificationPermission, 0);

  const no = boot({ platform: 'android', androidAnswer: 'denied', permissions: { platform: 'android', notificationsGranted: false } });
  assert.deepEqual({ ...(await no.NativeChrome.notifyWhenReady()) }, { outcome: 'denied', settings: true });
});

test('notifyWhenReady in a browser asks nothing', async () => {
  const h = boot({ native: false });
  assert.deepEqual({ ...(await h.NativeChrome.notifyWhenReady()) }, { outcome: 'no-app', settings: false });
  assert.equal(h.calls.settingsReads, 0);
});

// ── 2. The card ────────────────────────────────────────────────────────

function withStorage(fn) {
  const store = new Map();
  const before = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try { return fn(store); } finally { globalThis.localStorage = before; }
}

test('the card: one button, which asks nothing until it is tapped, then says what happens', async () => {
  const mod = loadTsx('frontend/src/features/messages/notify-me.tsx');
  let asked = 0;
  const before = globalThis.window;
  globalThis.window = { NativeChrome: { async notifyWhenReady() { asked += 1; return { outcome: 'granted' }; } } };
  try {
    const html = renderToHtml(createElement(mod.NotifyMe, { userId: 7 }));
    assert.match(html, /<button type="button" class="messages-bot-tint" data-bot-notify-me="">/, '#4046: an action in the accent\'s tint');
    assert.match(html, /<span>Notify me when it’s ready<\/span>/);
    assert.equal(asked, 0, 'drawing it asks nothing');
  } finally {
    globalThis.window = before;
  }

  // What each answer says, in the bot's voice.
  assert.equal(mod.notifyMeOutcome({ outcome: 'granted' }), 'granted');
  assert.equal(mod.notifyMeOutcome({ outcome: 'denied' }), 'denied');
  assert.equal(mod.notifyMeOutcome({ outcome: 'no-app' }), 'here');
  assert.equal(mod.notifyMeOutcome({ outcome: 'unknown' }), 'here', 'never a promise it cannot keep');
  assert.equal(mod.notifyMeOutcome(null), 'here');
  // #4046 (owner, 6 October): tapped, the same button turns grey and says
  // so, with a check; no line is added under it. In the bot's voice, and
  // never a promise when the app's notifications are off.
  assert.equal(mod.NOTIFY_ME_OFFER, 'Notify me when it’s ready');
  assert.equal(mod.NOTIFY_ME_DONE, 'I’ll notify you');
  assert.equal(mod.NOTIFY_ME_OFF, 'Notifications are off');
  const draw = (props) => renderToHtml(createElement(mod.NotifyMeView, props));
  assert.match(draw({ state: 'asking' }), /<button type="button" class="messages-bot-tint" data-bot-notify-me="" disabled="">/, 'asking: pressed once, waiting for the answer');
  for (const state of ['granted', 'here']) {
    const done = draw({ state });
    assert.match(done, new RegExp(`^<div class="messages-bot-answers" role="group" aria-label="Notifications" aria-live="polite"><button type="button" class="messages-bot-done" data-bot-notify-me="${state}" disabled=""><svg[^>]*>.*?</svg><span>I’ll notify you</span></button></div>$`), state);
    assert.doesNotMatch(done, /<p[ >]|Notify me when/, 'no new line, and the offer is gone');
  }
  assert.equal(draw({ state: 'denied' }),
    '<div class="messages-bot-answers" role="group" aria-label="Notifications" aria-live="polite"><button type="button" class="messages-bot-done" data-bot-notify-me="denied" disabled=""><span>Notifications are off</span></button></div>',
    'refused: says so, with no check');
  assert.match(draw({ state: 'denied', settings: true }), /<span>Notifications are off<\/span><\/button><button type="button" class="messages-bot-secondary">Turn on notifications<\/button>/,
    'notifications off in the app: the way to turn them on, beside it');
  assert.match(read('public/css/app.css'), /\.messages-bot-answers \.messages-bot-done \{ color: var\(--text-muted\); background: var\(--dc-raised\); cursor: default; filter: none; \}/,
    'grey: the muted ink on the raised fill');
  for (const line of [mod.NOTIFY_ME_OFFER, mod.NOTIFY_ME_DONE, mod.NOTIFY_ME_OFF]) assert.ok(!/—|!/.test(line));
});

test('the tap: the app\'s answer, a browser\'s, and "Your builds" switched back on when it was off', async () => {
  const mod = loadTsx('frontend/src/features/messages/notify-me.tsx');
  const requests = [];
  const beforeFetch = globalThis.fetch;
  let buildsOn = false;
  globalThis.fetch = async (url, init = {}) => {
    requests.push([init.method || 'GET', url, init.body || null]);
    return { ok: true, async json() { return { preferences: [{ key: 'messages', enabled: true }, { key: 'builds', enabled: buildsOn }] }; } };
  };
  const settle = () => new Promise((r) => setImmediate(r));
  try {
    const app = (answer) => ({ NativeChrome: { async notifyWhenReady() { return answer; } } });
    assert.deepEqual(await mod.askToNotify(app({ outcome: 'granted', settings: false })), { state: 'granted', settings: false });
    await settle(); await settle();
    assert.deepEqual(requests, [
      ['GET', '/api/me/mobile-push-preferences', null],
      ['PATCH', '/api/me/mobile-push-preferences', JSON.stringify({ preferences: { builds: true } })],
    ], 'the account had switched its build pushes off: Notify me asks for them');

    requests.length = 0;
    buildsOn = true;
    assert.deepEqual(await mod.askToNotify(app({ outcome: 'denied', settings: true })), { state: 'denied', settings: true });
    await settle(); await settle();
    assert.deepEqual(requests.map((r) => r[0]), ['GET'], 'already on: nothing written');

    assert.deepEqual(await mod.askToNotify({}), { state: 'here', settings: false }, 'a browser: the bot messages them here');
    assert.deepEqual(await mod.askToNotify(app({ outcome: 'unknown', settings: true })), { state: 'here', settings: false });
    const throws = { NativeChrome: { async notifyWhenReady() { throw new Error('bridge gone'); } } };
    assert.deepEqual(await mod.askToNotify(throws), { state: 'here', settings: false }, 'never throws');
  } finally {
    globalThis.fetch = beforeFetch;
  }
});

test('offered inside the built plan while it is being built, and not again once this account chose here', () => {
  const mod = loadTsx('frontend/src/features/messages/notify-me.tsx');
  withStorage(() => {
    assert.equal(mod.notifyMeChosen(7), false);
    globalThis.localStorage.setItem('usernode:notify-me-chosen:7', '1');
    assert.equal(mod.notifyMeChosen(7), true);
    assert.equal(mod.notifyMeChosen(8), false, 'another account on this device is still offered it');
  });
  assert.equal(mod.notifyMeChosen(7), false, 'no storage: offered, never a throw');

  const { PlanCardView } = loadTsx('frontend/src/features/messages/bot-plan-view.tsx');
  const plan = { bullets: ['A list of chores'], questions: [] };
  const html = renderToHtml(createElement(PlanCardView, {
    appName: 'Flat 4B', plan, state: 'built', footer: createElement('span', { 'data-footer': '' }, 'after'),
  }));
  assert.match(html, /You chose Build it<\/p><span data-footer="">after<\/span><\/div>$/, 'a footer is drawn last, inside the card');

  // #4046 (7 October): inside the built plan, its footer, with no line from
  // the bot above it (the hello already said it will message here).
  const card = read('frontend/src/features/messages/bot-plan.tsx');
  assert.match(card, /const \[offer\] = useState\(\(\) => !notifyMeChosen\(userId\)\);/,
    'decided when the card is drawn: an account that chose here is not asked again');
  assert.match(card, /footer=\{offer && state === 'built' && card && card\.state !== 'done' \? <div className="mt-3"><NotifyMe userId=\{userId\} \/><\/div> : null\}/,
    'only once built, and only while it is being built');
  const notify = read('frontend/src/features/messages/notify-me.tsx');
  assert.match(notify, /setState\('asking'\);\s*markNotifyMeChosen\(userId\);\s*const answered = await askToNotify\(\);/,
    'chosen on the tap, whatever the answer');
});
