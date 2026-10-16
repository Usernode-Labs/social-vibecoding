'use strict';

// #3702: the RUNNING APP's header carries "N to vote" and Suggest.
//
// Both were reachable only through the Homeroom mark's menu — the vote count
// as a trailing figure on the "Go to community hub" row, Suggest as its blue
// button. Now the header itself shows them, and the menu is unchanged. What
// this file pins: the gates (nothing on other screens, nothing at zero,
// nothing the menu row would hide either), the count's source and its shape,
// the two click paths, the hydration contract of a component that ships
// nothing in the prerendered document, and the words it draws.
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
const render = (improve, scope = {}, nav = {}) => withState(
  [
    [ui.improveStore, { ...SHOWN, ...improve }],
    [ui.communityScopeStore, { info: { 'recipe-box': { ...APP_INFO, ...scope } } }],
    [ui.navStore, nav],
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

test('inside a running app both controls show, in this order', () => {
  const html = render({});
  // Suggest first: the two doors that are ABOUT this app lead the group.
  assert.ok(
    html.indexOf('id="header-in-app-suggest"') < html.indexOf('id="header-in-app-to-vote"'),
    'Suggest, then the vote count, then the bell and the mark the header adds',
  );
  assert.match(html, /id="header-in-app-suggest"/);
  assert.match(html, /id="header-in-app-to-vote"/);
});

test('the pill says "N to vote" — the menu row\'s words, at zero nothing', () => {
  const two = render();
  assert.match(two, />2 to vote</);
  assert.match(two, /title="2 to vote"/);
  assert.match(two, /aria-label="2 to vote"/);
  // Zero owed, or every owed vote already swiped past (#3526): no pill and
  // no "0" — and Suggest stays.
  const none = render({}, { needs: 0, owedCount: 0 });
  assert.doesNotMatch(none, /header-in-app-to-vote/);
  assert.doesNotMatch(none, /to vote/);
  assert.match(none, /header-in-app-suggest/);
});

test('the pill\'s count is the Communities tab\'s: unseen owed votes', () => {
  // The store's `needs` is the number the tab's badge draws, and it is
  // already the passed-over ones less (needs-seen.ts). The controls re-read
  // it, they do not count anything of their own.
  assert.match(COMPONENT, /communityScopeStore/);
  assert.match(COMPONENT, /Number\(info\.needs\) \|\| 0/,
    'the same read `tabVotes` makes');
  // An UNCHOSEN community's votes summon nobody (5 Oct 2026) — the
  // platform's own community, which every account is in and may not have
  // taken part in yet.
  assert.doesNotMatch(render({}, { unchosen: true }), /header-in-app-to-vote/);
  // A community the store has no entry for (the viewer is not a member, or
  // the load has not landed): no pill, not NaN.
  withState([[ui.improveStore, SHOWN], [ui.communityScopeStore, { info: {} }]], () => {
    const html = renderToHtml(createElement(ui.InAppControls));
    assert.doesNotMatch(html, /header-in-app-to-vote/);
    assert.match(html, /header-in-app-suggest/, 'Suggest needs no membership');
  });
});

test('the pill is hidden wherever the menu\'s community hub row is', () => {
  // A viewer the platform hides the workshop from.
  assert.doesNotMatch(render({ restricted: true }), /header-in-app-to-vote/);
  assert.match(render({ restricted: true }), /header-in-app-suggest/,
    'Suggest is the viewer\'s on every app the pill is not');
  // A newcomer still being offered "Go to Homeroom": one way onward
  // (#4216). In this sandbox App is absent, so the offer reads as standing.
  assert.doesNotMatch(render({}, {}, { privateMember: true }), /header-in-app-to-vote/);
});

test('the pill\'s address is the Needs you feed\'s, and a plain click moves the page', () => {
  const html = render();
  assert.match(html, /href="\/app\/recipe-box\/workshop\?ws=needs"/,
    'a modified click and a new tab open the feed at its own address');
  // The click path, as the source spells it: the new-tab guard first, then
  // the nudge mark, then the move.
  assert.match(COMPONENT, /isNativeClick\?\.\(event\)/,
    'a modified click is left alone to open the tab (tests/nav-new-tab.test.js)');
  assert.match(COMPONENT, /preventDefault\(\);\s*\n\s*try \{ \(window as unknown as \{ UITelemetry[\s\S]{0,120}markNextVia\?\.\('nudged'\)/,
    'the tap is recorded as reaching the project page by a nudge, as a notification tap is');
  assert.match(COMPONENT, /openPlace\(slug, 'needs'\)/,
    'openPlace moves the page in place where it is mounted, else opens the address');
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
  assert.equal(message('core:header.inApp.toVote', { count: 1 }), '1 to vote');
  assert.equal(message('core:header.inApp.toVote', { count: 2 }), '2 to vote');
  assert.equal(message('core:header.inApp.suggest'), 'Suggest');
  assert.equal(message('core:header.inApp.suggestLabel'), 'Suggest an improvement');
});

test('no English is written into the component; the words come from the catalog', () => {
  assert.match(COMPONENT, /t\('core:header\.inApp\.toVote'/);
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
    'Suggest and the pill, then the bell, then the mark',
  );
});

test('loading happens on screen, never during render', () => {
  // The count comes from a load keyed to the app coming on screen, not from
  // a fetch in a render path — the hydration rule every island follows.
  assert.match(COMPONENT, /useEffect\(\(\) => \{\s*if \(!shown\) return;\s*hydrateNeedsSeen\(\);\s*void loadCommunities\(true\);/);
  assert.doesNotMatch(COMPONENT, /fetch\(/);
});
