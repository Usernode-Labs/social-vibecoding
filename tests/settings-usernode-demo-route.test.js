'use strict';

// Settings' Homeroom-app page takes its demo links in the hash
// (`#settings/usernode?bridgediag=demo`, `?bridgediag=wallet`,
// `?usernodedemo=ios`, `?widgeticons=demo`). The page is drawn when the
// screen opens, so an address that changed only those (from another
// Settings page, or from another demo) found the page drawn for the address
// before: with no app, the page was not in the menu at all and the link fell
// back to the default page. A fresh load of the same address showed the
// demo. Three declared checks met this on every run, after a hash switch in
// the checks runner, and each paid a cold reload to pass.
//
// Runs settings.js as the script it is in a vm (as the other Settings
// suites do), with the screen's drawing stubbed, and drives route() the way
// app.js does after the address changes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'frontend/src/features/settings/settings.js'), 'utf8');

function harness(hash) {
  const location = { hash, search: '', pathname: '/' };
  const context = vm.createContext({
    PlatformI18n: englishPlatformI18n(),
    window: { location, addEventListener() {}, removeEventListener() {} },
    document: { addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, getElementById: () => null },
    URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, console,
  });
  context.window.window = context.window;
  context.window.document = context.document;
  vm.runInContext(SOURCE, context);
  const Settings = context.window.Settings;
  const shown = [];
  let drawings = 0;
  // The screen's drawing, which needs the shell, is not what is under test.
  Object.assign(Settings, {
    _ensureMounted() {},
    _publishUsernode() { drawings += 1; },
    _renderNavIfOpen() {},
    _syncChrome() {},
    _markRoute() {},
    _isMobile: () => false,
    setSection(page, opts) { shown.push([page, opts && opts.anchor]); Settings._section = page; },
  });
  // What open() leaves behind for the address the screen opened at.
  Settings._renderUsernodeSection();
  Settings._level = 2;
  const opened = Settings._resolve(hash.replace(/^#settings\/?/, '').replace(/\?.*$/, ''));
  Settings._section = opened.page;
  Settings._anchor = opened.anchor;
  const go = (next) => {
    location.hash = next;
    Settings.route(next.replace(/^#settings\/?/, '').replace(/\?.*$/, ''));
  };
  return { Settings, shown, go, drawings: () => drawings };
}

test('a demo link reached by changing the address shows its page, as a fresh load of it does', () => {
  const { Settings, shown, go } = harness('#settings/username');
  assert.equal(Settings._usernodeGated, false, 'no app, no demo: the page is not offered');
  go('#settings/usernode?bridgediag=demo');
  assert.equal(Settings._usernodeGated, true);
  assert.deepEqual(shown.at(-1), ['usernode', null],
    'the Homeroom-app page, not the default page the menu fell back to');
  assert.equal(Settings._bridgeDiagnostics(), Settings.DEMO_BRIDGE_DIAGNOSTICS, 'drawn from the demo');
});

test('a change to another demo on the same page draws that demo', () => {
  const { Settings, go, drawings } = harness('#settings/usernode?bridgediag=demo');
  assert.equal(Settings._bridgeDiagnostics(), Settings.DEMO_BRIDGE_DIAGNOSTICS);
  const before = drawings();
  go('#settings/usernode?bridgediag=wallet');
  assert.ok(drawings() > before, 'the page is drawn again');
  assert.equal(Settings._bridgeDiagnostics(), Settings.DEMO_BRIDGE_DIAGNOSTICS_WALLET);

  go('#settings/usernode?usernodedemo=ios-denied');
  assert.equal(Settings._usernodeState, Settings.DEMO_USERNODE_STATE);
  assert.equal(Settings._unPushStatus, 'denied');

  go('#settings/usernode?widgeticons=demo');
  assert.notEqual(Settings._usernodeState, Settings.DEMO_USERNODE_STATE,
    'the previous demo\'s snapshot does not stay behind');
  assert.equal(Settings._widgetIconsDemo(), true);
  assert.equal(Settings._usernodeGated, true);
});

test('a route that leaves the demo links as they are draws nothing again', () => {
  const { go, drawings } = harness('#settings/usernode?bridgediag=demo');
  const before = drawings();
  // The second dispatch of one traversal (popstate and hashchange, #1102),
  // and a move to another page with no demo links either side.
  go('#settings/usernode?bridgediag=demo');
  assert.equal(drawings(), before);
  const { go: go2, drawings: drawings2 } = harness('#settings/username');
  const at = drawings2();
  go2('#settings/alerts');
  assert.equal(drawings2(), at);
});
