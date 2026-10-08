// A just-created app appears on My Apps while it is still building (#1547).
//
// `App.handleAppStatusUpdate` updated the home grid only when a card for that
// slug ALREADY existed, and re-pulled the list only on `running` or `error`.
// A brand-new app has neither: the grid was loaded before the app existed, so
// there is no card to update and no reload until the build ends.
//
// So closing the creation dialog mid-build left nothing on screen. The dialog
// says as much about itself — "closing this is dismissing a report, not
// cancelling anything" (create-app.tsx) — and the screen behind it did not
// hold up its end.
//
// The fix is one list pull the first time a status arrives for an unlisted
// slug. The tile already knows how to say "Spinning up..." for a creating app,
// and every later phase takes the existing `if (card)` branch, so the fetching
// does not repeat.
//
// Run with: node --test tests/home-new-app-card.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
const HOME = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/home/home.js'), 'utf8');

/**
 * `App._listNewlyCreatedApp` on a stub, with a Home whose loads are counted.
 * Only that method and its Set are exercised, so the rest of app.js does not
 * need a browser.
 */
function harness() {
  const body = SRC.match(/_listNewlyCreatedApp\(slug\) \{[\s\S]*?\n  \},/);
  assert.ok(body, 'the helper is defined in app.js');
  const loads = [];
  const sandbox = { loads };
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(
    'var Home = { load: function () { loads.push(1); } };'
    + 'var window = { Home: Home };'
    + 'var App = { _listedNewApps: new Set(), '
    + body[0].replace(/,$/, '')
    + ' };'
    + 'globalThis.__App = App;',
    sandbox);
  return { App: sandbox.__App, loads };
}

test('the first status for an unlisted app pulls the list once', () => {
  const { App, loads } = harness();
  App._listNewlyCreatedApp('brand-new');
  assert.equal(loads.length, 1);
});

test('every later phase for that app pulls nothing more', () => {
  // A creation emits one app_status per phase. Without the guard the first
  // would be followed by a list fetch on each of the rest.
  const { App, loads } = harness();
  for (let i = 0; i < 6; i++) App._listNewlyCreatedApp('brand-new');
  assert.equal(loads.length, 1, 'one pull, not six');
});

test('two different apps each get their own pull', () => {
  const { App, loads } = harness();
  App._listNewlyCreatedApp('one');
  App._listNewlyCreatedApp('two');
  assert.equal(loads.length, 2);
});

test('a missing slug does nothing at all', () => {
  const { App, loads } = harness();
  App._listNewlyCreatedApp('');
  App._listNewlyCreatedApp(null);
  App._listNewlyCreatedApp(undefined);
  assert.equal(loads.length, 0);
});

test('it is reached exactly when there is no card for that slug', () => {
  // The existing branch updates a card that exists; this is its else.
  const handler = SRC.slice(SRC.indexOf('handleAppStatusUpdate(data) {'));
  const upToAppView = handler.slice(0, handler.indexOf('// Update app view'));
  assert.match(upToAppView, /const card = document\.querySelector\(/);
  assert.match(upToAppView, /\} else \{\s*\n\s*App\._listNewlyCreatedApp\(data\.slug\);/);
  // And the running/error reload the card branch already did is untouched.
  assert.match(upToAppView, /if \(data\.status === 'running' \|\| data\.status === 'error'\) \{/);
});

test('the tile already has the words for a building app', () => {
  // This change puts the card there; the label was never the missing part.
  // A project whose first version Homeroom bot makes says its build line
  // first (#4053); "Spinning up..." is left for one it does not.
  assert.match(HOME, /const statusLabel = buildLine \? BUILD_LINE_WORDS\[buildLine\]\s*: isRunning \? ''\s*: app\.status === 'creating' \? message\('home:grid\.tile\.status\.creating'\)/);
  assert.equal(message('home:grid.tile.status.creating'), 'Spinning up...');
});

test('#4053: a first version on its way says its build line on the tile, for every status but a failed set-up', () => {
  const tileBuildLine = HOME.match(/  tileBuildLine\(app\) \{[\s\S]*?\n  \},/);
  assert.ok(tileBuildLine, 'Home.tileBuildLine is defined');
  const WORDS = fs.readFileSync(path.join(ROOT, 'frontend/src/features/first-session/build-line-words.js'), 'utf8')
    .replace(/^export\s+/gm, '');
  const fn = vm.runInNewContext(`${WORDS}\n({ ${tileBuildLine[0].trim().replace(/,$/, '')} })`, {});
  assert.equal(fn.tileBuildLine({ status: 'creating', first_version_line: 'planning' }), 'planning');
  assert.equal(fn.tileBuildLine({ status: 'running', first_version_line: 'plan' }), 'plan');
  assert.equal(fn.tileBuildLine({ status: 'running', first_version_line: null }), null);
  assert.equal(fn.tileBuildLine({ status: 'error', first_version_line: 'planning' }), null, 'Error and Retry say it failed');
  assert.equal(fn.tileBuildLine({ status: 'running', first_version_line: 'Build it' }), null);
  // Both tiles draw it: the React grid's view and the string one.
  assert.equal((HOME.match(/const buildLine = Home\.tileBuildLine\(app\);/g) || []).length, 2);
  assert.match(HOME, /`<p class="\$\{buildLineTileClass\(buildLine\)\}" data-build-line="\$\{buildLine\}">\$\{statusLabel\}<\/p>`/);
  const GRID = fs.readFileSync(path.join(ROOT, 'frontend/src/features/home/app-grid.tsx'), 'utf8');
  assert.match(GRID, /app\.buildLine \? \([\s\S]*?<p className=\{buildLineTileClass\(app\.buildLine\)\} data-build-line=\{app\.buildLine\}>/);
  // The server says it per viewer, in the list (GET /api/apps).
  const APPS = fs.readFileSync(path.join(ROOT, 'src/routes/apps.js'), 'utf8');
  assert.match(APPS, /first_version_line: firstVersionLines\.get\(Number\(a\.id\)\) \|\| null,/);
});
