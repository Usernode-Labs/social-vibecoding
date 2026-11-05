'use strict';

// #6314: Homeroom's Google Analytics tag runs on the live shell, in a frame of
// its own, and hears only cleaned paths. gtag.js reports the address of the
// page it runs in on every history change, whatever page_location it is told,
// and the shell's address can hold a sign-in link's key.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const { analyticsPath, installGoogleAnalytics } = loadTsx('frontend/src/lib/google-analytics.ts');

test('only a screen or an app slug ever leaves the page', () => {
  assert.equal(analyticsPath('/', ''), '/');
  assert.equal(analyticsPath('/', '#messages/48213'), '/messages');
  assert.equal(analyticsPath('/', '#app/my-app-1/dev/issues/9'), '/app/my-app-1');
  assert.equal(analyticsPath('/app/my-app-1/workshop', ''), '/app/my-app-1');
  assert.equal(analyticsPath('/?t=SECRET', '#signup'), '/signup');
  assert.equal(analyticsPath('/', '#waitlist?confirm=1&step=code'), '/waitlist');
  assert.equal(analyticsPath('/invite/SECRET', ''), '/other');
  assert.equal(analyticsPath('/', '#reset/SECRET'), '/other');
  assert.equal(analyticsPath('/', '#app/SECRET!token'), '/other');
});

function fakeHost(hostname, { top = true } = {}) {
  const listeners = {};
  const posted = [];
  const frame = {
    setAttribute() {},
    contentWindow: { postMessage: (m) => posted.push(m) },
  };
  const appended = [];
  const store = new Map();
  const host = {
    location: { hostname, origin: `https://${hostname}`, pathname: '/', hash: '#home' },
    document: {
      createElement: () => frame,
      body: { appendChild: (el) => appended.push(el) },
    },
    localStorage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, v),
    },
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  host.top = top ? host : {};
  const ready = () => listeners.message({
    origin: host.location.origin,
    source: frame.contentWindow,
    data: { type: 'homeroom-analytics-ready' },
  });
  return { host, posted, appended, listeners, frame, ready };
}

test('previews, local builds and the side panel load nothing', () => {
  for (const name of ['usernode-2d5619--s12672.onhomeroom.com', 'localhost', 'my-app.onhomeroom.com']) {
    const { host, appended } = fakeHost(name);
    installGoogleAnalytics(host).setSession(null);
    assert.equal(appended.length, 0, name);
  }
  const panel = fakeHost('app.onhomeroom.com', { top: false });
  installGoogleAnalytics(panel.host).setSession(null);
  assert.equal(panel.appended.length, 0);
});

test('a signed-out visitor is counted, by cleaned path, once per screen', () => {
  const { host, posted, appended, listeners, ready, frame } = fakeHost('app.onhomeroom.com');
  installGoogleAnalytics(host).setSession(null);
  assert.equal(appended.length, 1);
  assert.equal(frame.src, '/analytics-frame.html');
  assert.equal(frame.referrerPolicy, 'no-referrer');
  assert.equal(posted.length, 0, 'nothing before the frame says it listens');
  ready();
  assert.deepEqual(posted, [{ type: 'on' }, { type: 'page', path: '/home' }]);
  host.location.hash = '#messages/99';
  listeners.hashchange();
  listeners.hashchange();
  assert.deepEqual(posted.at(-1), { type: 'page', path: '/messages' });
  assert.equal(posted.filter((m) => m.type === 'page').length, 2);
});

test('Share usage analytics off: nothing is loaded for somebody signed in', () => {
  const { host, appended } = fakeHost('app.onhomeroom.com');
  installGoogleAnalytics(host).setSession({ id: 7, uiTelemetryEligible: false }, true);
  assert.equal(appended.length, 0);
});

test('signing in with the switch off stops what was being reported', () => {
  const { host, posted, listeners, ready } = fakeHost('app.onhomeroom.com');
  const api = installGoogleAnalytics(host);
  api.setSession(null);
  ready();
  api.setSession({ id: 7, uiTelemetryEligible: false }, true);
  assert.deepEqual(posted.at(-1), { type: 'off' });
  const before = posted.length;
  host.location.hash = '#settings';
  listeners.hashchange();
  assert.equal(posted.length, before, 'no page view after it');
});

test('Share usage analytics on: page views carry the account id, and signing out drops it', () => {
  const { host, posted, ready } = fakeHost('app.onhomeroom.com');
  const api = installGoogleAnalytics(host);
  api.setSession({ id: 7, uiTelemetryEligible: true }, true);
  ready();
  assert.deepEqual(posted, [
    { type: 'on' }, { type: 'user', id: 7 }, { type: 'on' }, { type: 'page', path: '/home' },
  ]);
  api.setSession(null);
  assert.deepEqual(posted.at(-2), { type: 'user', id: null });
});

test('a remembered session waits for the server, which decides', () => {
  const { host, appended } = fakeHost('app.onhomeroom.com');
  installGoogleAnalytics(host).setSession({ id: 7, uiTelemetryEligible: true, justSignedUp: true }, false);
  assert.equal(appended.length, 0);
});

test('sign_up goes once per account, even with the switch off, and carries no id', () => {
  const { host, posted, ready } = fakeHost('app.onhomeroom.com');
  const api = installGoogleAnalytics(host);
  const user = { id: 7, uiTelemetryEligible: false, justSignedUp: true };
  api.setSession(user, true);
  api.setSession(user, true);
  ready();
  assert.equal(posted.filter((m) => m.type === 'sign_up').length, 1);
  assert.deepEqual(posted.at(-1), { type: 'off' }, 'and nothing is reported after it');
  assert.equal(posted.some((m) => m.type === 'user' && m.id != null), false);
  assert.equal(posted.some((m) => m.type === 'page'), false);
});

test('the frame runs the tag only framed on the live host, and refuses another sender', () => {
  const frame = read('public/analytics-frame.html');
  assert.match(frame, /window\.parent === window\) return/);
  assert.match(frame, /location\.hostname !== 'app\.onhomeroom\.com'\) return/);
  assert.match(frame, /event\.origin !== location\.origin \|\| event\.source !== window\.parent/);
  assert.match(frame, /send_page_view: false/);
  assert.match(frame, /allow_ad_personalization_signals: false/);
});

test('the tag is in the frame alone: not in the shell, the bridge or any app template', () => {
  for (const file of [
    'frontend/src/head.html', 'frontend/src/Shell.tsx', 'public/usernode-bridge/v1/bridge.js',
    'public/usernode-bridge.js', 'src/services/template.js', 'public/js/app.js',
  ]) {
    assert.doesNotMatch(read(file), /googletagmanager|google-analytics\.com|G-TMWBDGGDCZ/, file);
  }
});

test('the data rule names the exception and keeps apps out of it', () => {
  const rules = read('src/prompts/app-conventions.md');
  assert.match(rules, /Third-party trackers or external scripts/);
  assert.match(rules, /public\/analytics-frame\.html/);
  assert.match(rules, /no precedent for an app/);
});
