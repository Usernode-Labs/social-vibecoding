// The sheets' web overlay stays DOWN while the kit presents the surface.
//
// The Improve panel, the app-context sheet and the Notifications sheet each
// pair a full-screen dimming overlay with their CSS slide-over: `data-open`
// raises it and `transition: opacity` fades it with the slide. On touch the
// same element is adopted into a kit sheet instead — and the kit brings its
// own backdrop, which fades 1:1 with the drag and the exit spring.
//
// Raising the web overlay there too was the reported "the background snaps"
// bug: the kit's backdrop faded out under a second overlay pinned at full
// opacity, so the scene stayed dimmed through the whole slide-out and only
// un-dimmed after the deferred teardown — a late 200ms fade that reads as a
// snap. (While open, the two 40% backdrops also stacked into an over-dim.)
// The hamburger drawer has always handled this by never raising its overlay
// on the kit path; these tests pin the same rule for the sheets.
//
// The contract: the controllers publish `adopted` beside `open`, and the
// overlay's `data-open` derives from `open && !adopted`. `adopted` is
// published AFTER the present (the store flush is synchronous, so it never
// reaches a paint) because `open` itself must be published BEFORE the present
// — the kit measures the content's height at present time.
//
// Run with: node --test tests/sheet-overlay-kit-adoption.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { runModules, makeStoreStub } = require('./helpers/bundle-module');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const SHEET_CONTROLLER = read('frontend/src/lib/sheet-controller.js');
const IMPROVE_CONTROLLER = read('frontend/src/features/improve/improve-controller.js');

function makeSandbox(panelIds) {
  const panels = Object.fromEntries(panelIds.map((id) => [id, { id }]));
  const sandbox = {
    console,
    Promise,
    setTimeout,
    clearTimeout,
    location: { search: '' },
    URLSearchParams,
    document: {
      getElementById: (id) => panels[id] || null,
      addEventListener: () => {},
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

// A kit-surface stub for the TOUCH branch: the present succeeds, and
// `dismiss()` runs the caller's onDismiss synchronously — the exit spring's
// terminal state, which is all the controllers observe. `atPresent` snapshots
// the store the moment the kit takes the element, so the tests can assert the
// publish-before-present ordering AND that `adopted` is not yet up then.
function touchKitSurface(store, log) {
  return {
    adoptKitSurface: (opts) => {
      log.push(['present', opts.kind, { ...store.state }]);
      return {
        kind: opts.kind,
        contentEl: opts.contentEl,
        restore: () => {},
        dismiss: () => {
          log.push(['kit-dismiss']);
          opts.onDismiss();
        },
      };
    },
  };
}

const DESKTOP = { adoptKitSurface: () => null };

// ── the shared chassis (app-context, notifications, messages) ────────────

function loadSheetController(kitSurface) {
  const store = makeStoreStub({ open: false, adopted: false });
  const log = [];
  const sandbox = makeSandbox(['test-sheet']);
  runModules(sandbox, [['sheet-controller.js', SHEET_CONTROLLER]], {
    imports: {
      './kit-surface': typeof kitSurface === 'function'
        ? kitSurface(store, log)
        : kitSurface,
    },
    tail: 'window.__make = createSheetController;',
  });
  const controller = sandbox.__make({ elementId: 'test-sheet', store });
  return { controller, store, log };
}

test('touch: adopted is published with open, and the present sees open first', () => {
  const { controller, store, log } = loadSheetController(touchKitSurface);
  controller.open();
  const present = log.find((c) => c[0] === 'present');
  assert.ok(present, 'the kit surface presented');
  assert.equal(present[2].open, true, 'open is published BEFORE the present');
  assert.equal(present[2].adopted, false, 'adopted is not up yet at present time');
  assert.deepEqual(
    { open: store.state.open, adopted: store.state.adopted },
    { open: true, adopted: true },
    'after open() the store says adopted, so the web overlay stays down',
  );
});

test('touch: the kit teardown clears open AND adopted together', () => {
  const { controller, store } = loadSheetController(touchKitSurface);
  controller.open();
  controller.close();
  assert.deepEqual(
    { open: store.state.open, adopted: store.state.adopted },
    { open: false, adopted: false },
  );
});

test('desktop: adopted never rises, so the overlay fades with the CSS slide', () => {
  const { controller, store } = loadSheetController(DESKTOP);
  controller.open();
  assert.equal(store.state.open, true);
  assert.equal(store.state.adopted, false,
    'the CSS slide-over is the presentation, and the overlay is its dim');
  controller.close();
  assert.equal(store.state.open, false);
  assert.equal(store.state.adopted, false);
});

// ── the Improve panel (its own copy of the chassis, predating it) ────────

function loadImprove(kitSurface) {
  const store = makeStoreStub({
    open: false,
    adopted: false,
    slug: 'demo',
    name: 'Demo',
    sessionsLoaded: false,
  });
  const log = [];
  const sandbox = makeSandbox(['improve-panel']);
  // loadSessions() needs a fetch; failing is fine — the catch keeps state.
  sandbox.fetch = async () => ({ ok: false });
  runModules(sandbox, [['improve-controller.js', IMPROVE_CONTROLLER]], {
    imports: {
      '../../lib/kit-surface': typeof kitSurface === 'function'
        ? kitSurface(store, log)
        : kitSurface,
      './improve-store.js': { improveStore: store },
      // The controller remembers the panel's target for the next cold paint
      // (frontend/src/lib/shell-snapshot.ts). Irrelevant to adoption, and a
      // no-op here rather than a localStorage stub: what this file tests is
      // when `platform-sheet-adopted` rises and falls.
      '../../lib/shell-snapshot': { saveShellSnapshot() {} },
      // open() dismisses the sheets built on lib/sheet-controller.js, so that
      // pressing Improve from a live header does not leave two panels up. No
      // sheet is registered in this sandbox and none of these tests opens
      // one, so the real function would sweep an empty set — the stub says
      // that out loud rather than pulling the registry in.
      '../../lib/sheet-controller.js': { dismissRegisteredSheets() {} },
      // The change rows carry the app's own artwork, resolved from the two
      // `app_icon_*` columns the list endpoints send. Also irrelevant here,
      // and stubbed with the real function's SHAPE rather than a bare
      // `() => ({})`: a stub that returns something a caller cannot use turns
      // a future adoption bug into a confusing one about icons.
      '../apps/app-card.js': {
        iconViewFor: (app) => (app.icon_url
          ? { kind: 'image', src: app.icon_url }
          : app.icon_emoji
            ? { kind: 'emoji', emoji: app.icon_emoji }
            : { kind: 'letter', letter: String(app.name || '?').charAt(0).toUpperCase() }),
      },
    },
  });
  return { Improve: sandbox.Improve, store, log };
}

test('improve, touch: adopted rises with the present and falls with the teardown', () => {
  const { Improve, store, log } = loadImprove(touchKitSurface);
  Improve.open();
  const present = log.find((c) => c[0] === 'present');
  assert.ok(present, 'the kit sheet presented');
  assert.equal(present[2].open, true, 'open is published BEFORE the present');
  assert.deepEqual(
    { open: store.state.open, adopted: store.state.adopted },
    { open: true, adopted: true },
  );
  Improve.close();
  assert.deepEqual(
    { open: store.state.open, adopted: store.state.adopted },
    { open: false, adopted: false },
  );
});

test('improve, desktop: adopted never rises', () => {
  const { Improve, store } = loadImprove(DESKTOP);
  Improve.open();
  assert.deepEqual(
    { open: store.state.open, adopted: store.state.adopted },
    { open: true, adopted: false },
  );
  Improve.close();
  assert.equal(store.state.open, false);
});

// ── the overlays actually read the flag ──────────────────────────────────

test('every sheet overlay derives data-open from open && !adopted', () => {
  const overlays = [
    ['frontend/src/features/improve/improve-panel.tsx', 'improve-overlay'],
    ['frontend/src/features/app-context/app-context-sheet.tsx', 'apps-switcher-overlay'],
    ['frontend/src/features/notifications/notifications-sheet.tsx', 'notifications-sheet-overlay'],
  ];
  for (const [file, id] of overlays) {
    const src = read(file);
    assert.ok(src.includes(`id="${id}"`), `${file} renders #${id}`);
    // The overlay's raise condition, exactly: an overlay gated on `open`
    // alone would pin the dim at full opacity through the kit's exit spring.
    assert.match(
      src,
      /\{\.\.\.\(open && !adopted \? \{ 'data-open': '' \} : \{\}\)\}/,
      `${file}'s overlay stays down while the kit presents the surface`,
    );
  }
});
