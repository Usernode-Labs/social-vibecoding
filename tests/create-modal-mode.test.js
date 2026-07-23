// Create-app modal mode state — regression pins for #748.
//
// The native-kit adopter (public/js/platform-ui.js, adoptStaticModal)
// re-parents each static modal's inner card OUT of its #<id> root and
// into the kit's presentModal shell while the modal is shown. Any CSS
// descendant selector keyed off the modal ROOT therefore stops matching
// the moment the modal is presented — which is exactly how #748
// happened: the create modal's data-mode / data-import-state gating
// lived on #create-modal, so the import block never hid and the mode
// pills never highlighted.
//
// The fix moves the state onto the card (#create-card), which travels
// with the re-parenting. These tests pin that contract:
//
//  1. index.html: #create-card exists, carries the default
//     data-mode="new" / data-import-state="idle", and #create-modal no
//     longer carries them.
//  2. app.css: all [data-mode] / [data-import-state] gating keys off
//     #create-card; nothing keys them off #create-modal.
//  3. app.js: setCreateMode / _setImportState / handleCreateApp target
//     create-card, not the root.
//  4. Guard against the whole bug class: app.css has no descendant
//     selectors whose ancestor is any adopted static-modal root
//     (platform-ui.js's STATIC_MODAL_IDS).
//
// Run with: node --test tests/create-modal-mode.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (rel) =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const HTML = read('public/index.html');
const CSS = read('public/css/app.css');
const APP_JS = read('public/js/app.js');
const PLATFORM_UI = read('public/js/platform-ui.js');

// ── 1. index.html — state attributes live on the card ─────────────────

test('index.html: #create-card carries the default mode/import-state', () => {
  const cardTag = HTML.match(/<div[^>]*id="create-card"[^>]*>/);
  assert.ok(cardTag, 'expected an element with id="create-card"');
  assert.match(cardTag[0], /data-mode="new"/, 'card must default data-mode="new"');
  assert.match(cardTag[0], /data-import-state="idle"/, 'card must default data-import-state="idle"');
});

test('index.html: #create-modal root no longer carries the state attributes', () => {
  const rootTag = HTML.match(/<div[^>]*id="create-modal"[^>]*>/);
  assert.ok(rootTag, 'expected an element with id="create-modal"');
  assert.doesNotMatch(rootTag[0], /data-mode=/, 'root must not carry data-mode');
  assert.doesNotMatch(rootTag[0], /data-import-state=/, 'root must not carry data-import-state');
});

test('index.html: #create-card is inside #create-modal (legacy fallback intact)', () => {
  const rootIdx = HTML.indexOf('id="create-modal"');
  const cardIdx = HTML.indexOf('id="create-card"');
  assert.ok(rootIdx >= 0 && cardIdx > rootIdx,
    '#create-card must appear inside the #create-modal markup');
});

// ── 2. app.css — gating selectors key off the card ────────────────────

test('app.css: no [data-mode]/[data-import-state] selector keys off #create-modal', () => {
  assert.doesNotMatch(CSS, /#create-modal\[data-mode/, 'found #create-modal[data-mode…] selector');
  assert.doesNotMatch(CSS, /#create-modal\[data-import-state/, 'found #create-modal[data-import-state…] selector');
});

test('app.css: the mode/import gating keys off #create-card', () => {
  assert.match(CSS, /#create-card\[data-mode="new"\][^{]*\.create-import-block\s*\{\s*display:\s*none/,
    '"new" mode must hide the import block via #create-card');
  assert.match(CSS, /#create-card\[data-mode="new"\][^,{]*\.create-mode-pill\[data-mode-pill="new"\]/,
    'active-pill highlight must key off #create-card');
  assert.match(CSS, /#create-card\[data-mode="import"\]\[data-import-state="ok"\]\s*#create-name-block/,
    'import name-field reveal must key off #create-card');
});

// ── 3. app.js — state read/write sites target the card ────────────────

test('app.js: setCreateMode and _setImportState write to create-card', () => {
  const setCreateMode = APP_JS.slice(
    APP_JS.indexOf('setCreateMode(mode)'), APP_JS.indexOf('_setImportState(state)'));
  assert.match(setCreateMode, /getElementById\('create-card'\)/,
    'setCreateMode must target #create-card');
  const setImportState = APP_JS.slice(
    APP_JS.indexOf('_setImportState(state)'), APP_JS.indexOf('async handleImportCheck'));
  assert.match(setImportState, /getElementById\('create-card'\)/,
    '_setImportState must target #create-card');
});

test('app.js: handleCreateApp reads mode/import-state from the card', () => {
  const handleCreateApp = APP_JS.slice(
    APP_JS.indexOf('async handleCreateApp(e)'), APP_JS.indexOf('// ── Homescreen zoom transition'));
  assert.match(handleCreateApp, /card\?\.dataset\.mode/,
    'handleCreateApp must read dataset.mode from the card');
  assert.match(handleCreateApp, /card\.dataset\.importState/,
    'handleCreateApp must read dataset.importState from the card');
  assert.doesNotMatch(handleCreateApp, /modal\??\.dataset\./,
    'handleCreateApp must not read state off the modal root');
});

// ── 4. Bug-class guard — no descendant CSS keyed off adopted roots ────

test('app.css: no descendant selectors keyed off any adopted static-modal root', () => {
  const idsMatch = PLATFORM_UI.match(/STATIC_MODAL_IDS\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(idsMatch, 'expected STATIC_MODAL_IDS in platform-ui.js');
  const ids = [...idsMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(ids.includes('create-modal'), 'sanity: create-modal is adopted');

  // Strip comments, then scan selector text (everything before each "{",
  // reset at "}") for "#<root>" followed by a descendant part — i.e. the
  // root used as an ANCESTOR. "#root {", "#root," and "#root.cls/#root[x]"
  // (compound, same element) are fine; "#root .child" / "#root > .child"
  // are the re-parenting hazard.
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const offenders = [];
  for (const id of ids) {
    const re = new RegExp(`#${id}(\\[[^\\]]*\\]|\\.[\\w-]+|:[\\w-]+)*\\s*[\\s>+~][^,{}]*\\{`, 'g');
    let m;
    while ((m = re.exec(css)) !== null) {
      // Exclude pure "#id {" (whitespace before the brace, no descendant).
      const sel = m[0].slice(0, -1).trim();
      if (sel !== `#${id}` && !/^#[\w-]+(\[[^\]]*\]|\.[\w-]+|:[\w-]+)*$/.test(sel)) {
        offenders.push(`#${id}: "${sel}"`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    `descendant selectors keyed off adopted modal roots stop matching while presented:\n${offenders.join('\n')}`);
});
