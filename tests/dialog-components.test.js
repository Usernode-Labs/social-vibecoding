// The shell's dialogs are React components now (#1078 chunk A), and they are
// deliberately STATIC. This file pins that, because "static" is the kind of
// property a later change removes by accident while everything still looks
// fine locally.
//
// Why it matters: PlatformUI.adoptStaticModal (public/js/platform-ui.js)
// observes each root in STATIC_MODAL_IDS and, when `hidden` comes off, lifts
// the card element OUT of the root — replacing it with a comment placeholder —
// into the native kit's presentModal shell, adding `platform-modal-adopted` to
// the root and `platform-modal-card` to the card. From that moment React's
// picture of the tree is wrong: the root's child is a comment, and the card
// carries a class React didn't render. A re-render of that subtree reconciles
// against the wrong parent (removeChild on a node that moved) or clobbers the
// kit's class. So:
//
//   1. every adopted id is rendered by a component under features/dialogs/;
//   2. none of those components uses state, effects or refs;
//   3. Shell.tsx renders them through <Dialogs /> and no longer inlines them.
//
// The way to lift (2) is to move the adoption seam itself inside React, so one
// owner writes to these nodes instead of two — not to relax this test.
//
// Run with: node --test tests/dialog-components.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIALOGS = path.join(ROOT, 'frontend', 'src', 'features', 'dialogs');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const PLATFORM_UI = read('public/js/platform-ui.js');
const SHELL = read('frontend/src/Shell.tsx');
const INDEX_HTML = read('public/index.html');

// The ids platform-ui.js adopts, read from the source rather than duplicated.
function adoptedIds() {
  const m = PLATFORM_UI.match(/const STATIC_MODAL_IDS = \[([\s\S]*?)\];/);
  assert.ok(m, 'platform-ui.js should still declare STATIC_MODAL_IDS');
  return [...m[1].matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]);
}

const componentFiles = fs.readdirSync(DIALOGS)
  .filter((f) => f.endsWith('.tsx') && f !== 'index.tsx');
const componentSrc = new Map(
  componentFiles.map((f) => [f, fs.readFileSync(path.join(DIALOGS, f), 'utf8')]),
);

test('every kit-adopted modal root is rendered by a dialog component', () => {
  const ids = adoptedIds();
  assert.ok(ids.length >= 9, `only ${ids.length} adopted ids — did the list shrink?`);
  for (const id of ids) {
    const owner = [...componentSrc].find(([, src]) => src.includes(`id="${id}"`));
    assert.ok(owner, `#${id} is adopted by platform-ui.js but no features/dialogs/* renders it`);
  }
  // And each component file owns exactly one root, so the mapping stays 1:1.
  for (const [file, src] of componentSrc) {
    const roots = [...src.matchAll(/id="([a-z0-9-]+-modal)"/g)].map((m) => m[1]);
    assert.equal(roots.length, 1, `${file} should render exactly one modal root, got ${roots}`);
  }
});

test('no dialog component is stateful', () => {
  // useRef is on the list too: a ref is only useful here for writing to the
  // node imperatively, which is the other half of the same conflict.
  const forbidden = ['useState', 'useReducer', 'useEffect', 'useLayoutEffect',
    'useSyncExternalStore', 'useRef', 'createRoot'];
  for (const [file, src] of componentSrc) {
    for (const hook of forbidden) {
      assert.ok(!src.includes(hook),
        `${file} uses ${hook} — but PlatformUI.adoptStaticModal moves this card out `
        + 'of the DOM at open time, so React must not re-render the subtree. Move the '
        + 'adoption seam inside React first.');
    }
    // No event handlers either: the legacy modules bind these controls by id,
    // and two owners for one click is worse than one legacy owner.
    assert.ok(!/\son[A-Z]\w+=\{/.test(src),
      `${file} attaches a React event handler — the legacy module still binds these by id`);
  }
});

test('Shell.tsx renders the dialogs through <Dialogs /> and inlines none of them', () => {
  assert.match(SHELL, /import \{ Dialogs \} from '\.\/features\/dialogs'/);
  assert.match(SHELL, /<Dialogs \/>/);
  for (const id of adoptedIds()) {
    assert.ok(!SHELL.includes(`id="${id}"`),
      `Shell.tsx still inlines #${id} — it belongs in features/dialogs/`);
  }
  // The index renders all of them, so the built document keeps every root.
  const index = fs.readFileSync(path.join(DIALOGS, 'index.tsx'), 'utf8');
  for (const [file, src] of componentSrc) {
    const comp = src.match(/export function (\w+)\(/)[1];
    assert.ok(index.includes(`<${comp} />`), `index.tsx does not render ${comp} (${file})`);
  }
});

test('the built document still carries every dialog root, hidden', () => {
  // The end-to-end check: extraction is only correct if the artifact is
  // unchanged. Each root ships with `hidden`, because the prerendered markup
  // is what a first paint (and every dapp.json `:not(.hidden)` check) sees.
  for (const id of adoptedIds()) {
    const m = INDEX_HTML.match(new RegExp(`<div[^>]*id="${id}"[^>]*>`));
    assert.ok(m, `public/index.html has no #${id} — run npm run build:shell`);
    assert.match(m[0], /class="hidden /, `#${id} should be prerendered hidden`);
  }
});
