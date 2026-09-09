'use strict';

// #1445: the homescreen icon badge.
//
// The bell, the tab title, and now the OS app icon all report the same
// account-wide unread total, and `_renderBadge` is the one place they all
// render from. `_publishAppBadge` fans that total out to the two icon
// surfaces the OS owns: `navigator.setAppBadge`/`clearAppBadge` for
// installed PWAs, and `window.SocialPush.publishBadgeCount` for the native
// Flutter shell (which forwards it over the bridge's setSocialBadgeCount
// capability — covered in tests/social-push-web.test.js).
//
// Frontend logic is extracted from the shipped source (so these can't
// drift from what runs) and exercised against stubs, in the style of
// tests/message-notifications-in-the-bell.test.js.
//
// Run with: node --test tests/homescreen-badge.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const FE_SRC = read('frontend/src/features/notifications/notifications.js');

// Pull a 2-space-indented object method's body out of the source so we can
// rebuild it as a standalone callable closing over injected stubs. Same
// helper, same reason, as tests/message-notifications-in-the-bell.test.js.
function methodBody(name) {
  const re = new RegExp(name + '\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n  \\},');
  const m = FE_SRC.match(re);
  assert.ok(m, name + '() definition found in notifications.js');
  return m[1];
}

const publishAppBadge = new Function(
  'Notifications', 'window', 'navigator', 'App',
  methodBody('_publishAppBadge')
);

function harness({ unread = 0, signedIn = true, withBadgeApi = true } = {}) {
  const calls = { set: [], clear: 0, social: [] };
  const win = {
    App: signedIn ? { user: { id: 7 } } : {},
    SocialPush: {
      publishBadgeCount(count) {
        calls.social.push(count);
        return Promise.resolve(true);
      },
    },
  };
  const navigatorStub = withBadgeApi ? {
    setAppBadge(count) { calls.set.push(count); return Promise.resolve(); },
    clearAppBadge() { calls.clear += 1; return Promise.resolve(); },
  } : {};
  return {
    calls,
    run() {
      publishAppBadge({ unread }, win, navigatorStub, win.App);
    },
  };
}

test('the unread total lands on both icon surfaces', () => {
  const h = harness({ unread: 5 });
  h.run();
  assert.deepEqual(h.calls.set, [5], 'installed PWAs get setAppBadge(unread)');
  assert.equal(h.calls.clear, 0);
  assert.deepEqual(h.calls.social, [5], 'the native seam gets the same total');
});

test('zero unread clears the badge instead of setting it', () => {
  const h = harness({ unread: 0 });
  h.run();
  assert.deepEqual(h.calls.set, []);
  assert.equal(h.calls.clear, 1);
  assert.deepEqual(h.calls.social, [0],
    'the native shell is told 0 so it can clear the OS badge');
});

test('signed out publishes 0 regardless of a stale unread total', () => {
  // A device must not stay badged for a session that ended in-app.
  const h = harness({ unread: 9, signedIn: false });
  h.run();
  assert.deepEqual(h.calls.set, []);
  assert.equal(h.calls.clear, 1);
  assert.deepEqual(h.calls.social, [0]);
});

test('a malformed unread total degrades to clearing, never to NaN', () => {
  const h = harness({ unread: undefined });
  h.run();
  assert.deepEqual(h.calls.set, []);
  assert.equal(h.calls.clear, 1);
  assert.deepEqual(h.calls.social, [0]);
});

test('missing badge APIs and a missing SocialPush seam are quiet no-ops', () => {
  // Browsers without the Badging API, and a mixed cache generation whose
  // classic scripts predate publishBadgeCount, must not throw into the
  // bell render this rides on.
  const win = { App: { user: { id: 7 } } };
  assert.doesNotThrow(() => {
    publishAppBadge({ unread: 3 }, win, {}, win.App);
  });
});

test('a rejected Badging API promise is swallowed', async () => {
  // iOS installed web apps gate setAppBadge behind notification
  // permission; the rejection must be handled, not unhandled.
  const win = {
    App: { user: { id: 7 } },
  };
  const navigatorStub = {
    setAppBadge() { return Promise.reject(new Error('permission')); },
  };
  publishAppBadge({ unread: 2 }, win, navigatorStub, win.App);
  await new Promise((resolve) => setImmediate(resolve));
});

test('_renderBadge publishes the icon badge on every repaint', () => {
  const body = methodBody('_renderBadge');
  assert.match(body, /Notifications\._publishAppBadge\(\)/,
    'the fan-out rides the one render path all badge surfaces share');
});
