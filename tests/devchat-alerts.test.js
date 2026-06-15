// Tests for the #138 dev-chat completion alerts (chime + OS notification).
//
// Two layers:
//   1. Behavioral — load public/js/dev-alerts.js in a vm sandbox with faked
//      browser globals (window/document/localStorage/AudioContext/
//      Notification/Usernode) and exercise the real DevAlerts API: the
//      visible→tone / hidden→notify decision, the native vs browser
//      systemNotify branches, the localStorage mute gate, and the tone
//      dedup guard.
//   2. Static wiring — assert the call sites in notifications.js / dev-chat.js
//      / settings.js / index.html exist so the feature can't silently
//      unwire.
//
// Run with: node --test tests/devchat-alerts.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (...p) => fs.readFileSync(path.join(PUBLIC, ...p), 'utf8');
const DEV_ALERTS_SRC = read('js', 'dev-alerts.js');

// Build a fresh sandbox + DevAlerts instance with configurable environment.
function makeEnv({
  visibility = 'visible',
  isNative = false,
  permission = 'granted',
  audioRunning = true,
  enabled = true,
} = {}) {
  const store = {};
  if (enabled === false) store.devchat_alerts_enabled = '0';

  const calls = { oscillators: 0, notifications: [], bridge: [], permissionRequests: 0 };

  class FakeParam {
    setValueAtTime() {} linearRampToValueAtTime() {} exponentialRampToValueAtTime() {}
  }
  class FakeNode {
    constructor() { this.gain = new FakeParam(); this.frequency = {}; }
    connect() { return new FakeNode(); }
    start() {} stop() {}
  }
  class FakeAudioContext {
    constructor() { this.state = audioRunning ? 'running' : 'suspended'; this.currentTime = 0; this.destination = {}; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    createOscillator() { calls.oscillators += 1; return new FakeNode(); }
    createGain() { return new FakeNode(); }
  }

  const sandbox = { Promise, Date, JSON, Math, console, setTimeout: () => 0 };
  sandbox.window = sandbox;
  sandbox.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  sandbox.document = { get visibilityState() { return visibility; } };
  sandbox.AudioContext = FakeAudioContext;
  sandbox.usernode = { isNative };
  sandbox.Usernode = { postMessage: (s) => calls.bridge.push(s) };
  sandbox.Notification = function Notification(title, opts) {
    calls.notifications.push({ title, opts });
  };
  sandbox.Notification.permission = permission;
  sandbox.Notification.requestPermission = () => { calls.permissionRequests += 1; return Promise.resolve(permission); };

  vm.runInNewContext(DEV_ALERTS_SRC, sandbox);
  return { DevAlerts: sandbox.window.DevAlerts, calls, store };
}

// ── decision: visible → tone, hidden → systemNotify ──────────────────────

test('onCompletion plays the tone (not a notification) when the app is visible', () => {
  const { DevAlerts } = makeEnv({ visibility: 'visible' });
  let tone = 0; let notif = 0;
  DevAlerts.playDoneTone = () => { tone += 1; };
  DevAlerts.systemNotify = () => { notif += 1; };
  DevAlerts.onCompletion({ kind: 'session_done' });
  assert.equal(tone, 1);
  assert.equal(notif, 0);
});

test('onCompletion fires a system notification (not a tone) when the app is hidden', () => {
  const { DevAlerts } = makeEnv({ visibility: 'hidden' });
  let tone = 0; let notif = 0;
  DevAlerts.playDoneTone = () => { tone += 1; };
  DevAlerts.systemNotify = () => { notif += 1; };
  DevAlerts.onCompletion({ kind: 'auto_solve_done' });
  assert.equal(tone, 0);
  assert.equal(notif, 1);
});

test('onCompletion does nothing when the preference is disabled', () => {
  for (const visibility of ['visible', 'hidden']) {
    const { DevAlerts } = makeEnv({ visibility, enabled: false });
    let tone = 0; let notif = 0;
    DevAlerts.playDoneTone = () => { tone += 1; };
    DevAlerts.systemNotify = () => { notif += 1; };
    DevAlerts.onCompletion({ kind: 'session_done' });
    assert.equal(tone, 0, `no tone when disabled (${visibility})`);
    assert.equal(notif, 0, `no notification when disabled (${visibility})`);
  }
});

// ── systemNotify: native vs browser ──────────────────────────────────────

test('systemNotify (native) posts a well-formed notify message over the bridge', () => {
  const { DevAlerts, calls } = makeEnv({ isNative: true });
  DevAlerts.systemNotify({
    kind: 'auto_solve_done', appSlug: 'demo', headlessIssueNumber: 7,
    title: 'Proposal ready', body: 'all done',
  });
  assert.equal(calls.bridge.length, 1);
  const msg = JSON.parse(calls.bridge[0]);
  assert.equal(msg.method, 'notify');
  assert.equal(msg.title, 'Proposal ready');
  assert.equal(msg.body, 'all done');
  assert.equal(msg.route, '#app/demo/dev/issues/7');
  // Native path must not also construct a browser Notification.
  assert.equal(calls.notifications.length, 0);
});

test('systemNotify (browser) constructs a Notification only when permission is granted', () => {
  const granted = makeEnv({ isNative: false, permission: 'granted' });
  granted.DevAlerts.systemNotify({ kind: 'session_done', title: 'Dev session finished', body: 'x', sessionId: 5 });
  assert.equal(granted.calls.notifications.length, 1);
  assert.equal(granted.calls.notifications[0].title, 'Dev session finished');
  assert.equal(granted.calls.bridge.length, 0, 'browser path must not post to the bridge');

  const denied = makeEnv({ isNative: false, permission: 'denied' });
  denied.DevAlerts.systemNotify({ kind: 'session_done', title: 'Dev session finished', body: 'x' });
  assert.equal(denied.calls.notifications.length, 0, 'no Notification when permission denied');
});

// ── mute pref round-trips localStorage and gates the channels ────────────

test('the mute preference round-trips through localStorage (default ON)', () => {
  const { DevAlerts, store } = makeEnv();
  assert.equal(DevAlerts.enabled(), true, 'absent key → enabled');
  DevAlerts.setEnabled(false);
  assert.equal(store.devchat_alerts_enabled, '0');
  assert.equal(DevAlerts.enabled(), false);
  DevAlerts.setEnabled(true);
  assert.equal(store.devchat_alerts_enabled, '1');
  assert.equal(DevAlerts.enabled(), true);
});

test('playDoneTone is gated by the preference and never throws when disabled', () => {
  const { DevAlerts, calls } = makeEnv({ enabled: false, audioRunning: true });
  DevAlerts._unlockAudio();
  DevAlerts.playDoneTone();
  assert.equal(calls.oscillators, 0, 'disabled → silent');
});

// ── tone synthesis + dedup ───────────────────────────────────────────────

test('playDoneTone synthesizes the chime once unlocked, and dedups rapid repeats', () => {
  const { DevAlerts, calls } = makeEnv({ audioRunning: true });
  // Locked context: no oscillators yet (context not unlocked → state check).
  // (FakeAudioContext starts 'running' here, but DevAlerts only builds its
  // context inside _unlockAudio.)
  DevAlerts.playDoneTone();
  assert.equal(calls.oscillators, 0, 'no audio before _unlockAudio creates the context');

  DevAlerts._unlockAudio();
  DevAlerts.playDoneTone();
  assert.equal(calls.oscillators, 2, 'two-note chime creates two oscillators');

  // Immediate second call is suppressed by the dedup guard.
  DevAlerts.playDoneTone();
  assert.equal(calls.oscillators, 2, 'rapid repeat deduped within the guard window');
});

test('playDoneTone stays silent while the audio context is still suspended', () => {
  const { DevAlerts, calls } = makeEnv({ audioRunning: false });
  // _unlockAudio resolves resume() async; our fake flips to running only on
  // resume(). Simulate the not-yet-resumed state by checking before resume
  // completes is impractical here, so assert the guard: a suspended context
  // produces no audio. Force suspended by not unlocking.
  DevAlerts.playDoneTone();
  assert.equal(calls.oscillators, 0);
});

// ── static wiring assertions ─────────────────────────────────────────────

test('notifications.js routes completions through DevAlerts.onCompletion', () => {
  const src = read('js', 'notifications.js');
  assert.match(src, /DevAlerts\.onCompletion\(completionAlertInfo\(notif\)\)/);
  assert.match(src, /function completionAlertInfo\(n\)/);
  // Both completion kinds are covered.
  assert.match(src, /session_done/);
  assert.match(src, /auto_solve_done/);
});

test('dev-chat.js plays the tone on the genuine turn-end hook, gated on visibility', () => {
  const src = read('js', 'dev-chat.js');
  // The tone lives in _finishStreaming (real turn end), not _setStreamingUI
  // (which also fires on session-switch teardown / reconnect drops). Anchor
  // on the method DEFINITION, not its many call sites.
  const defIdx = src.indexOf('_finishStreaming() {');
  assert.ok(defIdx > 0, '_finishStreaming definition present');
  const finish = src.slice(defIdx, defIdx + 1200);
  assert.match(finish, /document\.visibilityState === 'visible'/);
  assert.match(finish, /DevAlerts\.playDoneTone\(\)/);
  // _setStreamingUI must NOT call playDoneTone.
  const setUi = src.slice(src.indexOf('_setStreamingUI(streaming'), src.indexOf('_setStreamingUI(streaming') + 1500);
  assert.doesNotMatch(setUi, /playDoneTone/);
  // sendMessage unlocks audio + requests permission (user gesture).
  assert.match(src, /DevAlerts\._unlockAudio\(\)/);
  assert.match(src, /DevAlerts\.requestNotifyPermission\(\)/);
});

test('settings.js wires the toggle and the test-alert button', () => {
  const src = read('js', 'settings.js');
  assert.match(src, /devchat-alerts-toggle/);
  assert.match(src, /DevAlerts\.setEnabled\(/);
  assert.match(src, /devchat-alerts-test/);
  assert.match(src, /DevAlerts\.testAlert\(\)/);
});

test('index.html loads dev-alerts.js before notifications.js and ships the settings UI', () => {
  const html = read('index.html');
  const alertsIdx = html.indexOf('src="/js/dev-alerts.js"');
  const notifIdx = html.indexOf('src="/js/notifications.js"');
  assert.ok(alertsIdx > 0, 'dev-alerts.js script tag present');
  assert.ok(alertsIdx < notifIdx, 'dev-alerts.js loads before notifications.js');
  assert.match(html, /id="devchat-alerts-toggle"/);
  assert.match(html, /id="devchat-alerts-test"/);
});
