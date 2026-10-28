'use strict';
// #5995: "Agent instructions & skills", "Connectors & CLI", "Linked accounts"
// and "Linked phones" did not say what was behind them, so a viewer opened
// each to find out. The phone's Settings menu gives those few rows one muted
// line (ListRow's 13px subtitle); every other row keeps its single line.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const NAV = 'frontend/src/features/settings/settings-nav.tsx';
const settingsJs = read('frontend/src/features/settings/settings.js');

function block(name, open = '{', close = '}') {
  const at = settingsJs.indexOf(`    ${name}: ${open}`);
  assert.ok(at > 0, `${name} exists`);
  return settingsJs.slice(at, settingsJs.indexOf(`\n    ${close},`, at));
}

test('only the unclear rows have a subtitle, each a page the menu lists', () => {
  const subtitles = Object.fromEntries(
    [...block('SUBTITLES').matchAll(/'?([a-z-]+)'?: '(settings:nav\.subtitle\.[A-Za-z]+)'/g)].map((m) => [m[1], m[2]]),
  );
  assert.deepEqual(Object.keys(subtitles), ['linked-accounts', 'phones', 'connectors', 'agent-files']);
  // A menu row is a PAGE: its `page`, else its own key.
  const pages = new Set([...block('SECTIONS', '[', ']').matchAll(/\{ key: '([a-z-]+)'[^}]*\}/g)]
    .map((m) => (m[0].match(/page: '([a-z-]+)'/) || [])[1] || m[1]));
  assert.ok(pages.has('account') && !pages.has('password'), 'parts fold into their pages');
  assert.ok(!pages.has('cli'), 'CLI is a part of the Connectors & CLI page');
  for (const [key, id] of Object.entries(subtitles)) {
    assert.ok(pages.has(key), `${key} is a page`);
    assert.ok(message(id), `${id} is in the catalog`);
  }
  assert.equal(message('settings:nav.subtitle.agentFiles'), 'Tell your coding agents how to work');
  assert.equal(message('settings:nav.subtitle.connectors'), 'Build from Claude, ChatGPT or a terminal');
  // The phone's menu carries it; the sidebar descriptor does not.
  const menuView = settingsJs.slice(settingsJs.indexOf('    _menuView() {'), settingsJs.indexOf('    _renderNav() {'));
  assert.match(menuView, /subtitle: Settings\.SUBTITLES\[p\.key\] \? tr\(Settings\.SUBTITLES\[p\.key\]\) : ''/);
  const navView = settingsJs.slice(settingsJs.indexOf('    _navView() {'), settingsJs.indexOf('    _menuView() {'));
  assert.doesNotMatch(navView, /SUBTITLES/);
});

test('the phone menu draws the line under its row, and nothing under the rest', () => {
  const real = require(require.resolve('react', { paths: [path.join(ROOT, 'frontend')] }));
  const row = (key, label, subtitle) => ({ key, label, subtitle, terms: label.toLowerCase(), parts: [] });
  const descriptor = {
    desktop: null,
    mobile: [{ name: 'Integrations', items: [
      row('connectors', 'Connectors & CLI', 'Build from Claude, ChatGPT or a terminal'),
      row('theme', 'Appearance', ''),
    ] }],
    visit: 1,
  };
  const React = {
    ...real,
    useState: () => ['', () => {}],
    useEffect() {},
    useSyncExternalStore: (subscribe, get) => get(),
  };
  const nav = loadTsx(NAV, {
    stubs: {
      react: React,
      './settings-nav-store.js': { settingsNavStore: { get: () => descriptor, subscribe: () => () => {} } },
      '../../lib/i18n/react': { useMessages: () => englishPlatformI18n().t },
    },
  });
  const found = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.props && n.props['data-settings-nav'] !== undefined) found.push(n.props);
    if (n.props) walk(n.props.children);
  })(nav.SettingsMobileMenu());
  assert.deepEqual(found.map((p) => [p['data-settings-nav'], p.subtitle]), [
    ['connectors', 'Build from Claude, ChatGPT or a terminal'],
    ['theme', undefined],
  ]);
  // A line of words, not a pill or a dot beside the row.
  for (const p of found) {
    assert.equal(p.trailing, undefined);
    assert.equal(p.dot, undefined);
  }
});
