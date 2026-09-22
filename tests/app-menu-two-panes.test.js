'use strict';

// The app chip's sheet is the APP's menu, and About is its second pane
// (#2718).
//
// What this file exists to pin is the seam rather than the rows: a pane that
// can open empty, a pane that does not reset when the sheet closes, and a
// "back" that is really a second sheet are each the kind of defect that looks
// right in a diff and is obvious the first time somebody uses it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SHEET = read('frontend/src/features/app-context/app-context-sheet.tsx');
const CONTROLLER = read('frontend/src/features/app-context/app-context-controller.js');

// ONE bundle for the component and the store it reads: render-tsx bundles
// each entry separately, so a store imported on its own is a second copy and
// setting it changes nothing the component can see.
const ui = loadTsx('tests/fixtures/about-pane-api.ts');

const render = (patch) => {
  const before = { ...ui.improveStore.get() };
  ui.improveStore.set({ ...before, ...patch });
  try {
    return renderToHtml(createElement(ui.AboutPane, { label: patch.name || 'Notes' }));
  } finally {
    ui.improveStore.set(before);
  }
};

test('About never opens empty', () => {
  // Every other line in it is conditional — a repository the app may not
  // have, a share the platform may not allow yet, a version it may never have
  // deployed, a home screen the device may not have — and all four are absent
  // at once often enough that a pane without an unconditional line would
  // regularly open blank. A row that sometimes leads nowhere is the one thing
  // a menu row must not be.
  const bare = render({ name: 'Notes', slug: 'notes-ab12', repoUrl: null, canShare: false, version: null });
  assert.match(bare, /id="app-about-identity"/);
  assert.match(bare, />Notes</, 'the app is named');
  assert.match(bare, /\/app\/notes-ab12/, 'and addressed');
});

test('each fact appears only when there is one', () => {
  const bare = render({ name: 'Notes', slug: 'notes-ab12', repoUrl: null, canShare: false, version: null });
  assert.doesNotMatch(bare, /improve-row-github/, 'no repository, no row');
  assert.doesNotMatch(bare, /improve-row-share/, 'no share, no row');
  assert.doesNotMatch(bare, /app-about-version/, 'no version, no line');

  const full = render({
    name: 'Notes', slug: 'notes-ab12',
    repoUrl: 'https://github.com/example/notes', canShare: true, version: '14',
  });
  assert.match(full, /id="improve-row-github"[\s\S]{0,200}href="https:\/\/github\.com\/example\/notes"/);
  assert.match(full, /target="_blank"/, 'the repository opens away from the shell');
  assert.match(full, /id="improve-row-share"/);
  assert.match(full, /id="app-about-version"[\s\S]*?version 14\./,
    'the version is a LINE, not a row: there is nowhere for it to go');
  assert.ok(full.indexOf('improve-row-github') < full.indexOf('improve-row-share'),
    'the repository leads, sharing follows — the order the Improve footer had');
});

test('two panes of ONE sheet, not two sheets', () => {
  // The kit cannot present a sheet while it is still dismissing another —
  // the ordering the wallet row already worked around — and About is where
  // the menu GOES rather than something that opens over it.
  assert.match(SHEET, /view === 'about' \? <AboutPane label=\{appLabel\} \/> : \(/,
    'the pane replaces the rows inside the same scroller');
  assert.match(SHEET, /id="app-about-back"/, 'and the label row becomes the way back');
  assert.match(SHEET, /view === 'about' \? null : \(\s*<button\s+id="apps-switcher-create"/,
    'Create New is the menu pane\'s');
  assert.match(SHEET, /id="apps-switcher-list"[\s\S]{0,400}view === 'about' \? ' hidden' : ''/,
    'and so is the app strip: About is about ONE app');
});

test('closing resets the pane, by any route', () => {
  // A SUBSCRIPTION rather than a wrapper around close(): the kit's own
  // dismissal — a swipe, a tap on its backdrop — publishes `open: false`
  // without passing through the controller at all, and a sheet that reopens
  // on the pane you left is a sheet that ignores what you asked for.
  assert.match(CONTROLLER, /appContextStore\.subscribe\(\(\) => \{/);
  assert.match(CONTROLLER, /if \(wasOpen && !open\) appContextStore\.set\(\{ view: 'menu' \}\);/);
  assert.doesNotMatch(CONTROLLER, /AppContext\.close = /,
    'close() is not wrapped — that would miss the kit\'s own dismissal');
});

test('the menu row that opens it is a button, and says so', () => {
  // There is no address to open in a new tab, because the pane is this sheet
  // in another state — which is exactly why every OTHER row here is an
  // anchor and this one is not.
  const at = SHEET.indexOf('id="app-menu-row-about"');
  assert.ok(at > 0);
  const row = SHEET.slice(SHEET.lastIndexOf('<', at), SHEET.indexOf('</button>', at));
  assert.match(row, /type="button"/);
  assert.match(row, /AppContext\.showAbout\(\)/);
  assert.match(row, /w-full/, 'and fills the sheet, so its chevron sits at the edge');
});
