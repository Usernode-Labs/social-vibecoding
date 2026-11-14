'use strict';

// public/js/app-view.js loaded into a vm context, for a suite that calls its
// pure members (the board's buckets, a card's predicate, the Workshop's view
// model) with rows of its own. The sandbox is the one tests/dev-workshop.test.js
// builds: no DOM to speak of, English catalogs, a signed-in viewer on the
// project's board.
//
// Values built inside the context carry that realm's prototypes, which trips
// deepStrictEqual: `plain` round-trips them through JSON first.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_VIEW_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'app-view.js'), 'utf8');

function loadAppView() {
  const sandbox = {
    console,
    Date,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1, username: 'me' }, currentApp: 'demo-app', currentSubTab: 'forum' },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { search: '', hash: '', href: 'http://localhost/' },
    URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./platform-i18n').englishPlatformI18n();
  require('./repo-link').installRepoLink(sandbox);
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'demo-app', can_collaborate: true };
  return AppView;
}

const plain = (value) => JSON.parse(JSON.stringify(value));

module.exports = { APP_VIEW_SRC, loadAppView, plain };
