// The shell's nine dialogs, and the seam that presents them.
//
// #1078 chunk A extracted their markup into components and this file pinned
// them as deliberately STATIC — no state, no effects, no refs, no handlers.
// That was not a style rule: `PlatformUI.adoptStaticModal` observed each root
// in `STATIC_MODAL_IDS` and, when `hidden` came off, lifted the card element
// OUT of the root into the native kit's `presentModal` shell, leaving a
// comment placeholder behind and writing `platform-modal-adopted` to the root.
// From that moment React's picture of the tree was wrong, so re-rendering the
// subtree reconciled against the wrong parent or clobbered the kit's class.
//
// The note here said the way to lift that restriction was to move the adoption
// seam inside React, so one owner writes to these nodes instead of two. Chunk I
// did exactly that: frontend/src/lib/static-modal.ts performs the lift, driven
// by React state, and public/js/platform-ui.js no longer has the seam at all.
//
// So this file now pins the OTHER side of the same property — the contract
// that makes the lift safe under React:
//
//   1. every dialog root is rendered by a component under features/dialogs/;
//   2. every one of them drives its visibility through `useDialog`, which
//      means `useStaticModal` owns the `hidden` class and the kit lift;
//   3. no dialog renders ANY className on its ROOT — the kit writes to that
//      node, so the class attribute belongs to <DialogRoot> alone;
//   4. no dialog renders a controlled input, because the prerendered markup
//      must match the hand-written shell's byte for byte;
//   5. the seam really is gone from platform-ui.js, and the two modules the
//      dialogs owned are gone from public/js/.
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
const STATIC_MODAL = read('frontend/src/lib/static-modal.ts');
const KIT_SURFACE = read('frontend/src/lib/kit-surface.ts');
const USE_DIALOG = read('frontend/src/features/dialogs/use-dialog.ts');

// The nine roots. This list was read out of platform-ui.js's STATIC_MODAL_IDS
// until chunk I retired it; it is spelled out here now, and the first test
// below is what keeps it honest against the components.
const DIALOG_IDS = [
  'create-modal', 'rename-modal', 'close-issue-modal', 'fork-modal',
  'import-pr-modal', 'members-modal', 'feedback-modal', 'share-modal',
  'app-secrets-modal',
];

const componentFiles = fs.readdirSync(DIALOGS)
  .filter((f) => f.endsWith('.tsx') && f !== 'index.tsx');
const componentSrc = new Map(
  componentFiles.map((f) => [f, fs.readFileSync(path.join(DIALOGS, f), 'utf8')]),
);

/**
 * The opening tag of a component's modal root, as source text.
 *
 * The root is a <DialogRoot>, not a <div>: the backdrop root, the centring
 * wrapper that carries `data-modal-backdrop`, and the two class strings the
 * shell ships for them all live in frontend/@/components/ui/dialog.tsx now.
 */
function rootTag(src, id) {
  const at = src.indexOf(`id="${id}"`);
  if (at < 0) return null;
  const open = src.lastIndexOf('<DialogRoot', at);
  if (open < 0) return null;
  return src.slice(open, src.indexOf('>', at) + 1);
}

test('every dialog root is rendered by exactly one dialog component', () => {
  assert.equal(DIALOG_IDS.length, 9);
  for (const id of DIALOG_IDS) {
    const owners = [...componentSrc].filter(([, src]) => src.includes(`id="${id}"`));
    assert.equal(owners.length, 1, `#${id} should be rendered by exactly one features/dialogs/* component, got ${owners.map((o) => o[0])}`);
  }
  // And each component file owns exactly one root, so the mapping stays 1:1.
  for (const [file, src] of componentSrc) {
    const roots = [...src.matchAll(/id="([a-z0-9-]+-modal)"/g)].map((m) => m[1]);
    assert.equal(roots.length, 1, `${file} should render exactly one modal root, got ${roots}`);
  }
});

test('every dialog drives its visibility through useDialog', () => {
  // This is the seam contract. A dialog that toggles `hidden` some other way
  // is a dialog the kit does not present and React does not know about — the
  // exact split ownership chunk I removed.
  for (const [file, src] of componentSrc) {
    assert.match(src, /from '\.\/use-dialog'/, `${file} does not import useDialog`);
    assert.match(src, /useDialog[<(]/, `${file} does not call useDialog`);
    assert.match(src, /ref=\{dialog\.rootRef\}/,
      `${file} does not put dialog.rootRef on its modal root — useStaticModal has nothing to lift`);
    assert.match(src, /\{\.\.\.dialog\.backdropProps\}/,
      `${file} does not spread dialog.backdropProps — its backdrop would not dismiss`);
  }
});

test('no dialog reaches the class attribute the kit writes to its root', () => {
  // `useStaticModal` mutates `hidden` through classList and the kit adds
  // `platform-modal-adopted`, both on the ROOT. React must therefore render
  // that node's className to the same string on every pass — an unequal
  // string means React writes the attribute and the kit's class is gone.
  //
  // Nine hand-written constants used to carry that. The chassis carries it
  // now, and DialogRoot has NO className prop at all (see its header), so the
  // rule is enforced by the type rather than by nine transcriptions of it.
  // Inside the card className may be computed freely; only the root is shared.
  for (const id of DIALOG_IDS) {
    const [file, src] = [...componentSrc].find(([, s]) => s.includes(`id="${id}"`));
    const tag = rootTag(src, id);
    assert.ok(tag, `${file}: #${id} is not rendered by <DialogRoot> — the chassis owns the root`);
    assert.ok(!/className/.test(tag),
      `${file}: #${id} passes className to DialogRoot, but the kit writes platform-modal-adopted to that node: ${tag}`);
    assert.ok(!tag.includes('platform-modal-adopted'),
      `${file}: #${id} renders platform-modal-adopted — that class belongs to the kit at runtime`);
  }
});

test('the chassis owns the backdrop root, the wrapper and the card', () => {
  // The point of the chassis: these strings exist once. A dialog that
  // transcribes one again is a dialog that can drift from the other eight.
  const DIALOG_UI = read('frontend/@/components/ui/dialog.tsx');
  assert.match(DIALOG_UI, /cva\('hidden fixed inset-0 z-50'/,
    'the root base string must lead with `hidden` — the prerendered roots are hidden');
  assert.match(DIALOG_UI, /data-modal-backdrop=""/,
    'DialogRoot must render the wrapper useDialog dismisses on');

  for (const [file, src] of componentSrc) {
    assert.match(src, /from '@\/components\/ui\/dialog'/, `${file} does not import the chassis`);
    assert.ok(!src.includes('data-modal-backdrop'),
      `${file} hand-writes the backdrop wrapper — DialogRoot renders it`);
    assert.ok(!/fixed inset-0 z-50/.test(src),
      `${file} hand-writes the backdrop root class — DialogRoot owns it`);
    assert.ok(!/bg-white dark:bg-zinc-900 rounded-xl p-6 w-full/.test(src),
      `${file} hand-writes the card class — DialogCard owns it`);
  }
});

test('the chassis renders in place, never through a portal', () => {
  // A portal emits nothing during renderToStaticMarkup, so the nine roots
  // would be absent from the prerendered public/index.html — and the kit
  // already reparents the card itself. This is why the primitive is
  // hand-rolled rather than @radix-ui/react-dialog; see its header.
  const DIALOG_UI = read('frontend/@/components/ui/dialog.tsx');
  assert.ok(!DIALOG_UI.includes('createPortal'), 'dialog.tsx portals — the roots must prerender in place');
  assert.ok(!/^import .*@radix-ui/m.test(DIALOG_UI),
    'dialog.tsx imports Radix; no @radix-ui/* dependency exists (the header explains why)');
  const pkg = JSON.parse(read('frontend/package.json'));
  assert.ok(!Object.keys(pkg.dependencies || {}).some((d) => d.startsWith('@radix-ui/')),
    'a @radix-ui/* dependency appeared — the dialog seam has to be reconciled with it first');
});

test('no dialog renders a controlled text field', () => {
  // A controlled <input value>/<textarea value> emits a value attribute during
  // renderToStaticMarkup, so the prerendered public/index.html would diverge
  // from the hand-written shell that tests/baselines/shell-markup.json and the
  // dapp.json selector chains are written against. Every text field here is
  // uncontrolled and read through a ref (or by its controller module).
  //
  // Radios and checkboxes are exempt: the only ones in these dialogs are the
  // import-PR chooser's rows, which render inside a `!dialog.isOpen ? null`
  // branch and so are absent from the prerendered document entirely.
  for (const [file, src] of componentSrc) {
    for (const tag of src.match(/<input[^>]*>/gs) || []) {
      if (/type="(radio|checkbox)"/.test(tag)) continue;
      assert.ok(!/\svalue=\{/.test(tag),
        `${file} renders a controlled <input> — use defaultValue or a ref: ${tag}`);
    }
    assert.ok(!/<textarea[^>]*\svalue=\{/s.test(src),
      `${file} renders a controlled <textarea> — use a ref`);
  }
});

test('the adoption seam is inside React, and gone from platform-ui.js', () => {
  assert.ok(!PLATFORM_UI.includes('function adoptStaticModal'),
    'public/js/platform-ui.js still defines adoptStaticModal — chunk I retired it');
  assert.ok(!/const STATIC_MODAL_IDS = \[/.test(PLATFORM_UI),
    'public/js/platform-ui.js still declares STATIC_MODAL_IDS — chunk I retired it');
  // PlatformUI.modal() is the kit entry point the hook calls; it must stay.
  assert.match(PLATFORM_UI, /modal\(opts\)/);
  // And the hook is what calls it — through the shared lift (#1120 slice 3),
  // gated on kit presence, NOT on isTouch(), which would change desktop
  // presentation for all nine dialogs.
  assert.match(STATIC_MODAL, /adoptKitSurface\(\{/);
  assert.match(KIT_SURFACE, /ui\.hasKit\(\)/);
  assert.match(STATIC_MODAL, /gate: 'kit'/,
    "static-modal.ts must ask for the kit-presence gate, not the drawers' touch gate");
  assert.ok(!/isTouch\(\)\s*[?&]/.test(STATIC_MODAL),
    'static-modal.ts routes on isTouch() — the retired adopter gated on kit presence alone');
  // The ghost-click guard `AppView.revealModal` used to stamp lives here now.
  assert.match(STATIC_MODAL, /MODAL_GESTURE_GUARD_MS = 450/);
  assert.match(USE_DIALOG, /isDismissGuarded\(rootRef\.current\)/);
});

test('the dialogs still publish controllers for the legacy call sites', () => {
  // app.js and app-view.js keep their entry points (App.showCreateModal,
  // AppView.promptRename, …) and forward to these. If the registration goes,
  // those names silently become no-ops.
  assert.match(USE_DIALOG, /UsernodeReact/);
  assert.match(USE_DIALOG, /dialogs\[name\] = controller/);
  const appJs = read('public/js/app.js');
  const appViewJs = read('public/js/app-view.js');
  assert.match(appJs, /window\.UsernodeReact\?\.dialogs\?\.create\?\.open\(\)/);
  for (const name of ['rename', 'closeIssue', 'fork', 'importPr', 'share']) {
    assert.ok(appViewJs.includes(`dialogIsland('${name}')`),
      `app-view.js no longer forwards to the ${name} dialog island`);
  }
});

test('Shell.tsx renders the dialogs through <Dialogs /> and inlines none of them', () => {
  assert.match(SHELL, /import \{ Dialogs \} from '\.\/features\/dialogs'/);
  assert.match(SHELL, /<Dialogs \/>/);
  for (const id of DIALOG_IDS) {
    assert.ok(!SHELL.includes(`id="${id}"`),
      `Shell.tsx still inlines #${id} — it belongs in features/dialogs/`);
  }
  // The index renders all of them, so the built document keeps every root.
  const index = fs.readFileSync(path.join(DIALOGS, 'index.tsx'), 'utf8');
  for (const [file, src] of componentSrc) {
    // A file may export helpers alongside its component (import-pr.tsx exports
    // importPrErrorMessage for its own test); one of the exports has to be the
    // dialog the index renders.
    const exported = [...src.matchAll(/export function (\w+)\(/g)].map((m) => m[1]);
    assert.ok(exported.some((name) => index.includes(`<${name} />`)),
      `index.tsx renders none of ${file}'s exports (${exported.join(', ')})`);
  }
});

test('the built document still carries every dialog root, hidden', () => {
  // The end-to-end check: the conversion is only correct if the artifact is
  // unchanged. Each root ships with `hidden`, because the prerendered markup
  // is what a first paint (and every dapp.json `:not(.hidden)` check) sees.
  // It must also carry NO data-opened-at and no platform-modal-* class: those
  // are runtime-only, and an island whose initial render emitted them would
  // hydration-mismatch.
  for (const id of DIALOG_IDS) {
    const m = INDEX_HTML.match(new RegExp(`<div[^>]*id="${id}"[^>]*>`));
    assert.ok(m, `public/index.html has no #${id} — run npm run build:shell`);
    assert.match(m[0], /class="hidden /, `#${id} should be prerendered hidden`);
    assert.ok(!m[0].includes('data-opened-at'), `#${id} prerenders a runtime-only attribute`);
    assert.ok(!m[0].includes('platform-modal-'), `#${id} prerenders a runtime-only kit class`);
  }
});

test('the two modules the dialogs owned are retired from public/js/', () => {
  // tests/shell-script-order.test.js checks the tag and the RETIRED_SCRIPTS
  // bookkeeping; this checks the files themselves and their new homes.
  for (const gone of ['public/js/app-secrets.js', 'public/js/screenshot-select.js']) {
    assert.ok(!fs.existsSync(path.join(ROOT, gone)), `${gone} should be deleted — it moved into the bundle`);
  }
  for (const moved of ['app-secrets-controller.js', 'screenshot-select.js']) {
    assert.ok(fs.existsSync(path.join(DIALOGS, moved)), `features/dialogs/${moved} is missing`);
  }
  // Both keep their window.X publication for the callers that were not
  // converted, behind the prerender guard.
  const secrets = fs.readFileSync(path.join(DIALOGS, 'app-secrets-controller.js'), 'utf8');
  const shot = fs.readFileSync(path.join(DIALOGS, 'screenshot-select.js'), 'utf8');
  assert.match(secrets, /typeof window !== 'undefined'/);
  assert.match(secrets, /window\.Secrets = /);
  assert.match(shot, /typeof window !== 'undefined'/);
  assert.match(shot, /window\.ScreenshotSelect = /);
  // screenshot-select's only consumer is the feedback dialog, which imports it.
  const feedback = fs.readFileSync(path.join(DIALOGS, 'feedback-controller.js'), 'utf8');
  assert.match(feedback, /import '\.\/screenshot-select'/);
});
