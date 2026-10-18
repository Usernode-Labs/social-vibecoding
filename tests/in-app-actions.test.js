'use strict';

// #3702 gave the RUNNING APP's header Suggest; #5419 removed the "N to vote"
// pill that stood beside it — the bar mostly belongs to the app, and the
// vote count stays on the mark's menu row and the Communities tab's Needs
// you feed, which load their own counts.
//
// What this file pins: the gates (nothing on other screens, nothing the
// menu would hide either), Suggest's click path, the hydration contract of a
// component that ships nothing in the prerendered document, the pill's
// absence even with owed votes, and the words Suggest draws.
//
// Run with: node --test tests/in-app-actions.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message, englishPlatformI18n } = require('./lib/platform-i18n');
const { runModules, makeStoreStub } = require('./helpers/bundle-module');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const COMPONENT = read('frontend/src/features/header/in-app-actions.tsx');
const HEADER = read('frontend/src/features/header/platform-header.tsx');
const CONTROLLER = read('frontend/src/features/improve/improve-controller.js');

// ONE bundle for the controls and the stores they read, so a test publishing
// state reaches the same instances the component subscribes to.
const ui = loadTsx('tests/fixtures/in-app-actions-api.ts');

/** The state in which the controls have somewhere to stand: a running app. */
const SHOWN = { target: 'app', slug: 'recipe-box', tab: 'app', selfHosted: false, restricted: false };

const withState = (patches, fn) => {
  const saved = new Map();
  for (const [store, patch] of patches) {
    if (!saved.has(store)) saved.set(store, store.get());
    store.set(patch);
  }
  try {
    return fn();
  } finally {
    for (const [store, state] of saved) store.set(state);
  }
};

const APP_INFO = {
  slug: 'recipe-box', name: 'Recipe Box', iconUrl: null, iconEmoji: null, iconColor: null,
  needs: 2, owedCount: 2,
};

/** Render the controls after the stores say what the state is. */
const render = (improve, scope = {}) => withState(
  [
    [ui.improveStore, { ...SHOWN, ...improve }],
    [ui.communityScopeStore, { info: { 'recipe-box': { ...APP_INFO, ...scope } } }],
  ],
  () => renderToHtml(createElement(ui.InAppControls)),
);

test('the controls ship nothing before mount, whatever the stores say', () => {
  // The prerendered document has no such element, so the hydrating render
  // must agree (a deep link into an app has app.js publish the target before
  // this bundle hydrates). A first render that drew the controls would be
  // React #418/#419 on every app route — a console error, which fails every
  // declared check.
  withState([[ui.improveStore, SHOWN]], () => {
    assert.equal(renderToHtml(createElement(ui.InAppActions)), '');
  });
});

test('outside a running app the controls are nowhere', () => {
  for (const improve of [
    { target: 'platform' }, // Home and the other platform screens
    { target: null },
    { tab: 'dev' },         // the app's own Workshop, board, a topic
    { slug: null },
    { selfHosted: true },   // the platform's own row has no app on screen
  ]) {
    assert.equal(render(improve), '', JSON.stringify(improve));
  }
});

test('Suggest shows on its own, and the vote pill is gone (#5419)', () => {
  // Even with owed votes in the store, the header carries no pill: the count
  // lives on the mark's menu row and the Communities tab's Needs you feed.
  const html = render({});
  assert.match(html, /id="header-in-app-suggest"/);
  assert.doesNotMatch(html, /header-in-app-to-vote/);
  assert.doesNotMatch(html, /to vote/);
});

test('Suggest is hidden on a phone and returns below sm (#5367)', () => {
  // The bar was too crowded on mobile, so the control does not display at a
  // phone width; it keeps its place in the header on wider windows and
  // stays in the mark's menu on every size. The element remains in the DOM
  // (display only), so the id and the gates above are unaffected.
  const html = render({});
  // React renders the element's id before its class, so the first class
  // attribute after the id belongs to that element.
  const classes = html.slice(html.indexOf('id="header-in-app-suggest"'))
    .match(/class="([^"]+)"/)?.[1] ?? '';
  assert.match(classes, /(^| )hidden( |$)/, 'Suggest is not displayed on a phone');
  assert.match(classes, /(^| )sm:inline-flex( |$)/, 'Suggest comes back on wider windows');
  assert.doesNotMatch(classes, /(?<!sm:)inline-flex/,
    'Suggest has no bare inline-flex outside the sm: prefix');
});

test('Suggest opens the existing dialog with "This app" already chosen', () => {
  assert.match(COMPONENT, /Improve\.giveFeedback\(\{ target: 'app' \}\)/);
  // And it is announced as its full name, not the word on the pill-sized
  // control.
  const html = render();
  assert.match(html, /aria-label="Suggest an improvement"/);
  assert.match(html, /<span class="hidden sm:inline">Suggest<\/span>/,
    'on a phone the pencil stands alone; the word comes back on wider windows');
});

test('the controller routes a named target to the dialog\'s own choice', async () => {
  // Executed, not grepped: the same harness
  // tests/improve-action-deduplication.test.js runs the real controller in.
  const calls = [];
  const store = makeStoreStub({ slug: 'demo' });
  const sandbox = {
    console, Promise,
    App: {
      currentApp: 'demo',
      openFeedbackModal: (options) => calls.push(
        JSON.parse(JSON.stringify({ fromDev: options?.fromDev, target: options?.target })),
      ),
    },
  };
  sandbox.window = sandbox;
  require('node:vm').createContext(sandbox);
  runModules(sandbox, [['improve-controller.js', CONTROLLER]], {
    imports: {
      // The module reads its words through the language runtime: the real
      // one, in English (the same stub improve-action-deduplication.test.js
      // hands the same module).
      '../../lib/i18n/runtime': englishPlatformI18n(),
      '../apps/app-card.js': { iconViewFor() {} },
      '../notifications/notifications-sheet-store.js': {
        notificationsSheetStore: { get: () => ({ open: false }), subscribe: () => () => {} },
      },
      './improve-store.js': { improveStore: store },
      '../../lib/shell-snapshot': { saveShellSnapshot() {} },
    },
    tail: 'window.Improve = Improve;',
  });
  sandbox.Improve.close = () => {};
  await sandbox.Improve.giveFeedback({ target: 'app' });
  assert.deepEqual(calls, [{ target: 'app' }],
    'the button sits on the app, so "This app" is already the answer');
  await sandbox.Improve.giveFeedback();
  assert.deepEqual(calls, [{ target: 'app' }, { fromDev: true }],
    'the menu\'s button still asks where the suggestion goes (#2707/#4236)');
});

test('the words resolve in the core catalog', () => {
  assert.equal(message('core:header.inApp.suggest'), 'Suggest');
  assert.equal(message('core:header.inApp.suggestLabel'), 'Suggest an improvement');
});

test('no English is written into the component; the words come from the catalog', () => {
  assert.match(COMPONENT, /t\('core:header\.inApp\.suggest'\)/);
  assert.match(COMPONENT, /t\('core:header\.inApp\.suggestLabel'\)/);
  assert.doesNotMatch(COMPONENT, /\{\s*'[^']*(?:to vote|Suggest)[^']*'\s*\}/,
    'the visible words are never literals');
});

test('the header renders the controls as the right group\'s first children', () => {
  const group = HEADER.slice(
    HEADER.indexOf('ref={rightGroupRef}'),
    HEADER.indexOf('<PlatformMark />'),
  );
  assert.match(group, /<InAppActions \/>/,
    'inside the measured group, so the title\'s clearance still counts them');
  assert.ok(
    group.indexOf('<InAppActions />') < group.indexOf('id="notifications-btn"'),
    'Suggest, then the bell, then the mark',
  );
});