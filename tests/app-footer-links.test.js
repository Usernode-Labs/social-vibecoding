// "Built on Homeroom · Privacy · Report" on every app (#5116).
//
// Outside the platform (an app at its own address, or on a custom domain)
// the bridge's Homeroom button carries the footer line; that block's own
// behaviour is tests/bridge-platform-mark.test.js. Its Report link is
// <platform>/?report=app#app/<slug>, and this file holds the platform's half
// of that: the shell opens its report dialog for that app, once, and only for
// a viewer the server lets report it. Inside the platform the app menu's foot
// carries Privacy beside Report app.
//
// Run with: node --test tests/app-footer-links.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const APP_VIEW = read('public/js/app-view.js');

function reportFromLink() {
  const start = APP_VIEW.indexOf('  _openReportFromLink(slug, appData) {');
  const end = APP_VIEW.indexOf('\n  // #816: paint one staging-preview loader state');
  assert.ok(start > 0 && end > start, 'the helper is in app-view.js');
  return APP_VIEW.slice(start, end);
}

// Runs the helper against a fake address bar and a fake report dialog.
function run({ search, hash = '#app/bread-bot', slug = 'bread-bot', appData, current } = {}) {
  const opened = [];
  const replaced = [];
  const timers = [];
  const location = { pathname: '/', search, hash };
  const history = {
    state: { s: 1 },
    replaceState(state, _title, url) { replaced.push({ state, url }); },
  };
  const window = { UsernodeReact: { dialogs: { report: { open: (t) => opened.push(t) } } } };
  const sandbox = {
    URLSearchParams, location, history, window,
    setTimeout: (fn) => { timers.push(fn); },
  };
  vm.createContext(sandbox);
  vm.runInContext(`var AppView = {\n${reportFromLink()}\n};`, sandbox);
  sandbox.AppView.appData = current === undefined ? appData : current;
  const scheduled = sandbox.AppView._openReportFromLink(slug, appData);
  for (const fn of timers) fn();
  // Plain objects from this realm, for deepEqual.
  return JSON.parse(JSON.stringify({ scheduled, opened, replaced }));
}

const APP = { slug: 'bread-bot', name: 'Bread Bot', can_report: true };

test('?report=app opens the report dialog for this app and leaves the address', () => {
  const r = run({ search: '?report=app', appData: APP });
  assert.equal(r.scheduled, true);
  assert.deepEqual(r.opened, [{ targetType: 'app', target: 'bread-bot', label: 'Bread Bot' }],
    'the same dialog and target the app menu’s Report app opens');
  assert.deepEqual(r.replaced, [{ state: { s: 1 }, url: '/#app/bread-bot' }],
    'the parameter is taken off, so a reload does not ask again');
});

test('other query parameters are kept', () => {
  const r = run({ search: '?shot=x&report=app&lang=fr', appData: APP });
  assert.equal(r.replaced[0].url, '/?shot=x&lang=fr#app/bread-bot');
});

test('a viewer who may not report it gets the app and no dialog', () => {
  for (const can of [false, undefined]) {
    const r = run({ search: '?report=app', appData: { ...APP, can_report: can } });
    assert.equal(r.scheduled, false);
    assert.deepEqual(r.opened, []);
    assert.equal(r.replaced.length, 1, 'the parameter is still taken off');
  }
});

test('nothing happens without the parameter, for another app, or after navigating away', () => {
  assert.equal(run({ search: '', appData: APP }).scheduled, false);
  assert.deepEqual(run({ search: '?report=user', appData: APP }).replaced, []);
  assert.deepEqual(run({ search: '?report=app', appData: { ...APP, slug: 'other' } }).opened, []);
  const away = run({ search: '?report=app', appData: APP, current: { slug: 'elsewhere' } });
  assert.equal(away.scheduled, true);
  assert.deepEqual(away.opened, [], 'a fast navigate-away must not pop the dialog onto another app');
});

test('the link is read once the app’s own record is in hand', () => {
  const open = APP_VIEW.slice(APP_VIEW.indexOf('    AppView.appData = appData;'));
  const call = open.indexOf('AppView._openReportFromLink(slug, appData);');
  assert.ok(call > 0, 'open() reads the link');
  assert.ok(call < open.indexOf("const shot = new URLSearchParams(location.search).get('shot');"),
    'beside the other deep links, after the frame’s token wait');
});

test('the bridge’s Report link is the address the shell reads', () => {
  const bridge = read('public/usernode-bridge/v1/bridge.js');
  assert.match(bridge, /reportHref: origin \+ "\/\?report=app#app\/" \+ slug,/);
});

test('inside the platform the app menu carries Privacy beside Report app', () => {
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  assert.match(sheet, /import \{ waitlistOptions \} from '\.\.\/auth\/waitlist-shared';/);
  const foot = sheet.slice(sheet.indexOf('id="app-menu-legal"'), sheet.indexOf('id="improve-row-report"'));
  assert.ok(foot.length > 0, 'Privacy comes first in the foot, then Report app');
  assert.match(foot, /id="app-menu-privacy"\s+href=\{privacyHref\}\s+target="_blank"\s+rel="noopener noreferrer"/);
  assert.match(foot, /\{t\('agent:appContext\.privacy'\)\}/);
  assert.match(sheet, /id="app-menu-legal" className="[^"]*\bjustify-center\b/,
    'the foot is centred under the rows above it (#5788)');
  assert.match(sheet, /if \(!open \|\| privacyHref\) return undefined;/,
    'the notice’s address is asked for when the sheet opens, not at boot');
  assert.equal(message('agent:appContext.privacy'), 'Privacy');
});

test('the app menu’s foot, close and rows are readable and reachable (#5927)', () => {
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  const legal = sheet.slice(sheet.indexOf('id="app-menu-legal"'), sheet.indexOf("{t('agent:appContext.reportApp')}"));
  assert.match(legal, /className="[^"]*\btext-\[13px\] text-zinc-600 dark:text-zinc-300\b/,
    'the foot is 13px in a lighter ink on dark, not 12px zinc-500');
  assert.equal((legal.match(/min-h-\[44px\] px-3/g) || []).length, 2, 'each link is a 44px target');
  assert.doesNotMatch(legal, /·/, 'no dot between the links: their padding is the gap');

  const ring = sheet.match(/const FOCUS_RING = ([^;]+);/);
  assert.ok(ring, 'one focus ring for the menu');
  assert.match(ring[1], /focus-visible:ring-2/);
  assert.match(ring[1], /dark:focus-visible:ring-violet-400/, 'a lighter ring on the dark theme');
  assert.match(sheet, /\+ 'transition-colors ' \+ FOCUS_RING;/, 'every ROW carries it');

  const close = sheet.slice(sheet.indexOf('id="apps-switcher-close"'), sheet.indexOf('</button>', sheet.indexOf('id="apps-switcher-close"')));
  assert.match(close, /w-9 h-9[^']*un-touch-target ' \+ FOCUS_RING/, 'a 36px close with a 44px hit box');
  assert.match(close, /<XIcon className="w-6 h-6" \/>/, 'a 24px ✕');
});

test('platform.json names Homeroom’s privacy notice', () => {
  const { appHostConfig } = require('../src/services/app-host-config');
  const { privacyNoticeUrl } = require('../src/services/marketing-links');
  const doc = appHostConfig({ platformDomain: 'app.onhomeroom.com', appsDomain: 'onhomeroom.com' });
  assert.equal(doc.privacy_url, privacyNoticeUrl({}));
  assert.equal(doc.privacy_url, 'https://onhomeroom.com/legal/privacy-notice');
});
