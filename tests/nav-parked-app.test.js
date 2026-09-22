'use strict';

// #platform-parked — the app you left, one tap above the tab bar (#2718).
//
// The bar makes the platform's five places one tap each, and in doing so it
// makes the app you were IN the one thing that is not: no tab, no header strip
// once you leave, and Home's grid is every app rather than the one you were
// halfway through. This is the handle back.
//
// Four things are pinned, and each is a way it can be quietly useless:
//
//   1. THE ROOT SHIPS EMPTY. It is in the frozen shell inventory, so it has to
//      be in the prerendered document — with nothing inside it, because the
//      app comes from localStorage and a read during a first render is a
//      hydration mismatch.
//   2. THE WHOLE STRIP RESUMES. A shortcut whose tappable area is a pill
//      inside a full-width bar is a shortcut you miss.
//   3. ONE PLACE PARKS. Eight call sites run AppView.close(); all of them
//      reveal a screen through _showOnlyScreen on the next line, and a rule
//      spelled once cannot be half-applied.
//   4. ENTERING THE APP CLEARS IT. Resuming the app you are in is a shortcut
//      to where you already are.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const HTML = read('public/index.html');
const APP_JS = read('public/js/app.js');

const ui = loadTsx('tests/fixtures/parked-strip-api.ts');
const render = (app) => {
  const before = ui.parkedStore.get().app;
  ui.parkedStore.set({ app });
  try {
    return renderToHtml(createElement(ui.ParkedStrip, {}));
  } finally {
    ui.parkedStore.set({ app: before });
  }
};

test('the root ships in the document, hidden and empty', () => {
  const at = HTML.indexOf('id="platform-parked"');
  assert.ok(at > 0, 'the strip is part of the shipped shell');
  const el = HTML.slice(HTML.lastIndexOf('<div', at), HTML.indexOf('</div>', at) + 6);
  assert.match(el, /class="platform-parked hidden"/,
    'hidden, with the class a CONSTANT — app.css reads it to reserve the band');
  assert.doesNotMatch(el, /platform-parked-resume|platform-parked-forget/,
    'and empty: the app comes from storage in an effect, never a first render');
});

test('the whole strip resumes, and the pill is a label inside it', () => {
  const html = render({ slug: 'notes-ab12', name: 'Notes', iconUrl: null, iconEmoji: null });
  assert.match(html, /id="platform-parked-resume"/);
  const anchor = html.slice(html.indexOf('<a '), html.indexOf('</a>') + 4);
  assert.match(anchor, /href="\/app\/notes-ab12"/,
    'a REAL path, so a modified click opens the app in a tab');
  assert.match(anchor, />Notes</, 'the app is named in full');
  assert.match(anchor, /platform-parked-pill">Resume</,
    'and Resume is inside the target, not beside it');
  assert.doesNotMatch(anchor, /<button/,
    'a button inside an anchor is invalid markup and browsers split it');
  assert.match(anchor, /app-icon-tile platform-parked-tile/, 'with the app’s own artwork');
});

test('the dismiss means forget, and says whose', () => {
  // A strip that comes back on the next screen swap is a strip you cannot get
  // rid of, and the handle's promise is that it is there until you are done.
  const html = render({ slug: 'notes-ab12', name: 'Notes', iconUrl: null, iconEmoji: null });
  assert.match(html, /id="platform-parked-forget"[^>]*aria-label="Forget Notes"/);
  const SRC = read('frontend/src/features/nav/parked-strip.tsx');
  assert.match(SRC, /onClick=\{\(\) => setParked\(null\)\}/,
    'it clears the store AND storage, which is what forgetting is');
});

test('a slug with no record still draws a strip', () => {
  // The display data is captured at parking time and may be missing — a cold
  // deep link into an app the launcher has never listed. A handle named after
  // the slug beats no handle.
  const html = render({ slug: 'notes-ab12', name: 'notes-ab12', iconUrl: null, iconEmoji: null });
  assert.match(html, />notes-ab12</);
  assert.match(html, /data-icon="letter"/, 'and falls back to the initial, like every tile');
});

test('one place parks, and it is the screen swap', () => {
  const at = APP_JS.indexOf('  _showOnlyScreen(revealId, keepAlso) {');
  const body = APP_JS.slice(at, APP_JS.indexOf('\n  },', at));
  assert.match(body, /App\._syncParkedApp\(revealId\);/,
    'every screen swap passes through here, including the eight that close an app');
  // …and NOT at the call sites, which is the whole point of putting it here.
  assert.equal((APP_JS.match(/_syncParkedApp\(/g) || []).length, 3,
    'the definition, the screen swap, and navigateToApp’s early clear');
});

test('entering an app clears its own handle, in the frame the app arrives', () => {
  const at = APP_JS.indexOf('  _syncParkedApp(revealId) {');
  assert.ok(at > 0, '_syncParkedApp went missing');
  const body = APP_JS.slice(at, APP_JS.indexOf('\n  },', at));
  assert.match(body, /if \(revealId === 'app-view'\) \{ bridge\.park\(null\); return; \}/);
  // navigateToApp clears it inside PlatformUI.transition's reveal callback
  // rather than waiting for _showOnlyScreen in `after`, so the strip does not
  // ride the zoom in and then vanish.
  const nav = APP_JS.slice(APP_JS.indexOf('  async navigateToApp(slug, tab, ref, subTab) {'));
  assert.match(nav.slice(0, nav.indexOf('\n  },')), /App\._syncParkedApp\('app-view'\);/);
});

test('the display data is captured, never looked up later', () => {
  // The strip's promise is to be instant. A handle that has to fetch a name
  // and an icon before it can draw appears after you have stopped looking.
  const body = APP_JS.slice(APP_JS.indexOf('  _syncParkedApp(revealId) {'));
  const fn = body.slice(0, body.indexOf('\n  },'));
  assert.match(fn, /AppView\.launchRecordFor\?\.\(slug\)/, 'the launcher’s cached row');
  assert.match(fn, /AppView\.appData\?\.slug === slug/, 'or the record the app view loaded');
  assert.match(fn, /name: rec\?\.name \|\| slug/, 'and the slug answers when neither does');
});

test('storage is read defensively and written through one key', () => {
  const SRC = read('frontend/src/features/nav/parked-store.js');
  assert.match(SRC, /const KEY = 'usernode_parked_app_v1';/);
  assert.equal(ui.PARKED_KEY, 'usernode_parked_app_v1');
  // Private mode, disabled site data, a corrupt entry: no strip is the
  // pre-existing behaviour, so there is nothing to report.
  assert.match(SRC, /function readParked\(\) \{\s*try \{/);
  assert.match(SRC, /\} catch \{/);
  // The store is written BEFORE storage, so a storage failure does not cost
  // the viewer the handle for the rest of the session.
  const set = SRC.slice(SRC.indexOf('export function setParked'));
  assert.ok(set.indexOf('parkedStore.set(') < set.indexOf('localStorage.setItem'));
});
