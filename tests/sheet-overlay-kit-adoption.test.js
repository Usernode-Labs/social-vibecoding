// The standing sheets: the Homeroom menu and Notifications, on the Sheet.
//
// Both are prerendered (their roots are always in the document) and opened
// by name from classic scripts and the header. They had a presentation route
// of their own, lib/sheet-controller.js, beside the Sheet (lib/sheet.ts) and
// the dialogs'; it folded into the Sheet. `createStandingSheet` is the name
// they are opened by, and `useSheet({ open, ...sheet.present })` presents
// them while the flag is up. These tests run the two against a hand-stepped
// React (tests/lib/sheet-harness.js) and pin what the old route promised.
//
// THE WEB OVERLAY STAYS DOWN WHILE THE KIT PRESENTS THE SURFACE. Each sheet
// pairs a full-screen dimming overlay with its CSS slide-over: `data-open`
// raises it and `transition: opacity` fades it with the slide. On touch the
// same element is adopted into a kit sheet instead, and the kit brings its
// own backdrop. Raising the web overlay there too was the reported "the
// background snaps" bug, so the overlay's `data-open` derives from
// `open && !adopted`, `adopted` being the Sheet's.
//
// Run with: node --test tests/sheet-overlay-kit-adoption.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { createFakeReact, createDom } = require('./lib/sheet-harness');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const SLIDE_MS = 15;

/**
 * One standing sheet, mounted. `touch` loads a kit that presents sheets; its
 * `dismiss()` only counts, and `endExit()` ends the exit it started (the
 * kit's callback at the end of its spring).
 */
function setup({ touch = false, top = (key) => key === 'test-sheet' } = {}) {
  const dom = createDom();
  const saved = { PlatformUI: globalThis.PlatformUI };
  globalThis.document = dom.doc;
  const panel = dom.node('panel');
  panel.append(dom.node('row', { focusable: true }));
  dom.doc.getElementById = (id) => (id === 'test-sheet' ? panel : null);
  const fake = createFakeReact();

  const back = { claims: [], releases: [] };
  const backStack = {
    pushDismissible(close) {
      back.claims.push(close);
      return (options) => back.releases.push(options || {});
    },
  };
  const surfaces = { claims: [], released: 0 };
  const openSurfaces = {
    claimSurface(key, kind, close) {
      surfaces.claims.push({ key, kind, close });
      return () => { surfaces.released += 1; };
    },
    isTopSurface: (key) => top(key),
  };

  const { createStore } = loadTsx('frontend/src/lib/plain-store.js');
  const store = createStore({ open: false });
  const kit = { presents: [], handles: [] };
  globalThis.PlatformUI = touch
    ? {
      isTouch: () => true,
      hasKit: () => true,
      sheet(opts) {
        const handle = {
          el: dom.node('un-sheet'),
          dismissed: 0,
          dismiss() { handle.dismissed += 1; },
          endExit: () => opts.onDismiss(),
        };
        kit.presents.push({ open: store.get().open, contentEl: opts.contentEl });
        kit.handles.push(handle);
        return handle;
      },
    }
    : undefined;

  const stubs = { react: fake.React, './back-stack': backStack, './open-surfaces': openSurfaces };
  const lib = loadTsx('frontend/src/lib/sheet.ts', { stubs, cache: false });
  let opens = 0;
  const sheet = lib.createStandingSheet({
    id: 'test-sheet', store, slideMs: SLIDE_MS, safetyMs: 2000, onOpen: () => { opens += 1; },
  });
  let result = null;
  const component = fake.mount(() => {
    result = lib.useSheet({ open: store.get().open, ...sheet.present });
    result.panelRef.current = panel;
  });
  // The mount module's flush: the store re-renders the island on the spot.
  store.subscribe(() => component.rerender());
  // The fake document stays until the next setup replaces it: a standing
  // sheet gives focus back in a microtask, once its commit is over.
  const restore = () => {
    component.unmount();
    globalThis.PlatformUI = saved.PlatformUI;
  };
  return {
    dom, panel, store, sheet, kit, back, surfaces, lib,
    result: () => { component.rerender(); return result; },
    get opens() { return opens; },
    restore,
  };
}

/** Whether `promise` has settled within `ms`. */
function settled(promise, ms = 5) {
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => { setTimeout(() => resolve(false), ms); }),
  ]);
}

// ── Presented by the Sheet ───────────────────────────────────────────────

test('touch: the kit takes the sheet once its flag is up, and the overlay stays down', () => {
  const t = setup({ touch: true });
  try {
    t.sheet.open();
    assert.equal(t.kit.presents.length, 1, 'the kit presented it');
    assert.equal(t.kit.presents[0].open, true, 'with the flag already up, so it measures the open sheet');
    assert.equal(t.kit.presents[0].contentEl, t.panel);
    assert.equal(t.result().adopted, true, 'the Sheet says adopted, so the web overlay stays down');
    assert.equal(t.opens, 1, 'onOpen runs once it is up');
    t.sheet.open();
    assert.equal(t.kit.presents.length, 1, 'opening it again presents nothing new');
    assert.equal(t.opens, 2, 'but refreshes again, as it always did');
  } finally { t.restore(); }
});

test('touch: closing plays the kit\'s exit on a copy, and the close resolves when it ends', async () => {
  const t = setup({ touch: true });
  try {
    t.sheet.open();
    const done = t.sheet.close();
    assert.equal(t.store.get().open, false);
    assert.equal(t.kit.handles[0].dismissed, 1, 'the kit was asked to leave');
    assert.equal(t.panel.parent, t.dom.doc.body, 'the sheet is home on <body> at once');
    assert.ok(t.panel.classList.contains('platform-surface-rehomed'), 'and out of sight there');
    assert.equal(await settled(done), false, 'not before the exit ends');
    t.kit.handles[0].endExit();
    assert.equal(await settled(done), true, 'and as soon as it does');
    assert.equal(t.result().adopted, false, 'the next opening starts unadopted');
  } finally { t.restore(); }
});

test('touch: the kit\'s own dismissal (a swipe, its backdrop) closes it and reports the exit', async () => {
  const t = setup({ touch: true });
  try {
    t.sheet.open();
    t.kit.handles[0].endExit();
    assert.equal(t.store.get().open, false, 'the flag went down');
    assert.equal(t.kit.handles[0].dismissed, 0, 'and nothing asked the kit to leave twice');
    assert.equal(t.back.releases.length, 1, 'the swipe did not leave a Back claim behind');
    assert.equal(await settled(t.sheet.close()), true, 'nothing is left to wait for');
  } finally { t.restore(); }
});

test('desktop: no kit, the slide is the presentation, and the close resolves after it', async () => {
  const t = setup();
  try {
    t.sheet.open();
    assert.equal(t.store.get().open, true);
    assert.equal(t.result().adopted, false, 'the CSS slide-over is the presentation, and the overlay is its dim');
    const done = t.sheet.close();
    assert.equal(t.store.get().open, false);
    assert.equal(await settled(done, 1), false, 'not before the slide is out');
    assert.equal(await settled(done, SLIDE_MS * 4), true);
  } finally { t.restore(); }
});

// ── The back button closes it (QA 2026-09-24 Q16) ────────────────────────
//
// Back walked the history UNDER an open sheet: the bell's sheet stayed up
// while Discover turned into Home behind it, and the Homeroom menu closed
// and took the page with it. A sheet claims the next press through the same
// lib/back-stack.ts the dialogs use, for as long as it is open.

for (const touch of [true, false]) {
  const label = touch ? 'touch' : 'desktop';
  test(`${label}: an open sheet claims Back, and Back closes it`, () => {
    const t = setup({ touch });
    try {
      t.sheet.open();
      assert.equal(t.back.claims.length, 1, 'one claim per presentation');
      t.sheet.open();
      assert.equal(t.back.claims.length, 1, 'not a second one for the sheet already up');
      assert.equal(t.back.claims[0](), true, 'the press is consumed');
      assert.equal(t.store.get().open, false, 'and the sheet is closed by it');
      assert.equal(t.back.releases.length, 0,
        'a press already spent the record, so nothing is handed back');
    } finally { t.restore(); }
  });

  test(`${label}: closing another way hands the claim back as a navigating release`, () => {
    // Most closes here are the first half of a navigation written in the same
    // task (a row, a link), so the record must not be spent under it.
    const t = setup({ touch });
    try {
      t.sheet.open();
      void t.sheet.close();
      assert.deepEqual(t.back.releases.map((o) => o.navigating), [true]);
      t.sheet.open();
      void t.sheet.dismissForNav();
      assert.deepEqual(t.back.releases.map((o) => o.navigating), [true, true]);
      assert.equal(t.back.claims.length, 2, 'and the next open claims again');
    } finally { t.restore(); }
  });
}

// ── One open panel at a time (#6981) ─────────────────────────────────────

test('opening claims the one-open-panel slot, and closing lets it go first thing', () => {
  const t = setup();
  try {
    t.sheet.open();
    assert.deepEqual(t.surfaces.claims.map((c) => [c.key, c.kind]), [['test-sheet', 'sheet']]);
    // Another panel claiming the slot closes this one through its own close.
    t.surfaces.claims[0].close();
    assert.equal(t.store.get().open, false);
    assert.equal(t.surfaces.released, 1, 'the claim went back at the start of the close');
  } finally { t.restore(); }
});

// ── Escape ───────────────────────────────────────────────────────────────

test('Escape closes it while it is the top panel, wherever focus is; not under another', () => {
  let onTop = true;
  const t = setup({ top: () => onTop });
  try {
    const bell = t.dom.node('bell', { focusable: true });
    bell.focus();
    t.sheet.open();
    onTop = false;
    assert.equal(t.dom.key('Escape').defaultPrevented, false, 'a panel over it (the tour) keeps the key');
    assert.equal(t.store.get().open, true);
    onTop = true;
    assert.equal(t.dom.key('Escape').defaultPrevented, true);
    assert.equal(t.store.get().open, false, 'the bell kept focus, and Escape still closed it');
  } finally { t.restore(); }
});

test('touch: Escape closes the kit\'s sheet too, unless a kit surface is drawn above it (#5927 item 10)', () => {
  const t = setup({ touch: true });
  try {
    t.sheet.open();
    t.dom.doc.querySelector = (sel) => (sel.includes('.un-alert') ? {} : null);
    t.dom.doc.querySelectorAll = () => [];
    t.dom.key('Escape');
    assert.equal(t.store.get().open, true, 'an alert above it keeps the key');
    t.dom.doc.querySelector = () => null;
    t.dom.doc.querySelectorAll = (sel) => (sel.includes('.un-sheet') ? [t.kit.handles[0].el] : []);
    t.kit.handles[0].el.append(t.panel);
    t.dom.key('Escape');
    assert.equal(t.store.get().open, false, 'held by the kit and on top, it closes');
  } finally { t.restore(); }
});

test('a standing sheet leaves the page and the header usable beside it', () => {
  const t = setup();
  try {
    t.sheet.open();
    assert.equal(t.dom.key('Tab').defaultPrevented, false, 'Tab is not trapped');
    const src = read('frontend/src/lib/sheet.ts');
    assert.match(src, /holdPage: false,\s*trapFocus: false,\s*surface: id,/);
  } finally { t.restore(); }
});

// ── The overlays actually read the flag ──────────────────────────────────

test('every sheet overlay derives data-open from open && !adopted, and taps through the Sheet', () => {
  const overlays = [
    ['frontend/src/features/app-context/app-context-sheet.tsx', 'apps-switcher-overlay', 'apps-switcher-sheet'],
    ['frontend/src/features/notifications/notifications-sheet.tsx', 'notifications-sheet-overlay', 'notifications-sheet'],
  ];
  for (const [file, id, panel] of overlays) {
    const src = read(file);
    assert.ok(src.includes(`id="${id}"`), `${file} renders #${id}`);
    // The overlay's raise condition, exactly: an overlay gated on `open`
    // alone would pin the dim at full opacity through the kit's exit spring.
    assert.match(
      src,
      /\{\.\.\.\(open && !adopted \? \{ 'data-open': '' \} : \{\}\)\}/,
      `${file}'s overlay stays down while the kit presents the surface`,
    );
    assert.match(src, /const adopted = !!sheet\?\.adopted;/, `${file} reads adopted from the Sheet`);
    assert.match(src, new RegExp(`id="${id}"[\\s\\S]{0,200}?\\{\\.\\.\\.sheet\\?\\.scrimProps\\}`),
      `${file}'s overlay closes by the Sheet's scrim rule`);
    assert.match(src, new RegExp(`id="${panel}"\\s*ref=\\{sheet\\?\\.panelRef\\}`),
      `${file}'s root is the panel the Sheet presents`);
  }
  for (const island of ['frontend/src/features/app-context/index.tsx', 'frontend/src/features/notifications/index.tsx']) {
    assert.match(read(island), /useSheet\(\{\s*open,\s*\.\.\.(AppContext|NotificationsSheet)\.present\b/);
  }
});

// ── #6813: opening a sheet puts away the keyboard of a field behind it ──
//
// iOS keeps focus on a text field when a button is tapped, so opening the
// bell while typing left the keyboard up; the kit rides every sheet on the
// keyboard, so the sheet came up with its title, tabs, search and close above
// the top of the screen. `open()` blurs a focused TEXT field outside the
// sheet — never one inside it (the sheet's own search) and never a button,
// menu or checkbox, so a sheet opened from another keeps that control.

/** A focusable stand-in for a DOM element, recording its blurs. */
function element(over = {}) {
  return {
    tagName: 'DIV',
    blurred: 0,
    blur() { this.blurred += 1; },
    getAttribute: () => null,
    ...over,
  };
}

test('#6813: a focused text field outside the sheet loses focus when it opens', () => {
  for (const field of [
    element({ tagName: 'TEXTAREA' }),
    element({ tagName: 'INPUT', getAttribute: (n) => (n === 'type' ? 'search' : null) }),
    element({ isContentEditable: true }),
  ]) {
    const t = setup();
    try {
      t.dom.doc.activeElement = field;
      t.sheet.open();
      assert.equal(field.blurred, 1, 'the keyboard goes away with the focus');
    } finally { t.restore(); }
  }
});

test('#6813: a field inside the sheet keeps its focus', () => {
  const t = setup();
  try {
    const search = t.panel.append(t.dom.node('search'));
    search.tagName = 'INPUT';
    search.blurred = 0;
    search.blur = () => { search.blurred += 1; };
    t.dom.doc.activeElement = search;
    t.sheet.open();
    assert.equal(search.blurred, 0,
      'the sheet\'s own search box is the one field it must not take focus from');
  } finally { t.restore(); }
});

test('#6813: a button, menu or checkbox behind the sheet is left alone', () => {
  for (const [tagName, type] of [
    ['BUTTON', null],
    ['INPUT', 'checkbox'],
    ['INPUT', 'radio'],
    ['INPUT', 'range'],
    ['SELECT', null],
  ]) {
    const t = setup();
    try {
      const el = element({ tagName, getAttribute: (n) => (n === 'type' ? type : null) });
      t.dom.doc.activeElement = el;
      t.sheet.open();
      assert.equal(el.blurred, 0, `${tagName}[${type || ''}] is not holding a keyboard up`);
    } finally { t.restore(); }
  }
});

// ── The menu's outside press (#2784) ─────────────────────────────────────

test('outside: a press outside a scrimless sheet closes it, and a spared one does not', () => {
  // The menu's option: the web popover under the mark, which has no scrim.
  const dom = createDom();
  const saved = { document: globalThis.document, window: globalThis.window };
  globalThis.document = dom.doc;
  // The frame rule listens for the window losing focus.
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  try {
    const fake = createFakeReact();
    const stubs = {
      react: fake.React,
      './back-stack': { pushDismissible: () => () => {} },
      './open-surfaces': { claimSurface: () => () => {}, isTopSurface: () => true },
    };
    const lib = loadTsx('frontend/src/lib/sheet.ts', { stubs, cache: false });
    const panel = dom.node('panel');
    const mark = dom.node('mark');
    const elsewhere = dom.node('elsewhere');
    for (const n of [panel, mark, elsewhere]) n.nodeType = 1;
    let closes = 0;
    fake.mount(() => {
      const r = lib.useSheet({
        kind: 'sheet', open: true, gate: 'touch', home: 'body', holdPage: false, trapFocus: false,
        onClose: () => { closes += 1; },
        outside: { inside: (target) => target === mark },
      });
      r.panelRef.current = panel;
    });
    const click = (target) => {
      for (const l of dom.listeners.slice()) {
        if (l.capture && l.type === 'pointerdown') l.fn({ target, clientX: NaN, clientY: NaN });
      }
      for (const l of dom.listeners.slice()) {
        if (l.capture && l.type === 'click') l.fn({ target, clientX: NaN, clientY: NaN });
      }
    };
    click(mark);
    assert.equal(closes, 0, 'the mark is spared: its own click toggles');
    click(panel);
    assert.equal(closes, 0, 'a press inside is inside');
    click(elsewhere);
    assert.equal(closes, 1, 'a press anywhere else closes it');
  } finally {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
  }
});

// ── Handed back, out of sight (onboarding run three, 12 Oct 2026) ───────
//
// The Homeroom menu's bottom sheet stood again at its open place for 190ms
// after the kit's exit had taken it away (the recording's frames show the
// web sheet, no grabber). A node homed on <body> goes back there with
// REHOMED_CLASS, which app.css keeps out of sight, until its next adoption
// starts, so a refused one still shows the web presentation.
test('kit-surface: a node the kit hands back to <body> stays out of sight until it is presented again', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/lib/kit-surface.ts'), 'utf8');
  assert.match(src, /export const REHOMED_CLASS = 'platform-surface-rehomed';/);
  assert.match(src, /\} else if \(presented\) \{\s+contentEl\.classList\.add\(REHOMED_CLASS\);\s+document\.body\.appendChild\(contentEl\);/);
  // Let go first thing, before any gate can refuse the adoption.
  const fn = src.slice(src.indexOf('export function adoptKitSurface('));
  assert.ok(fn.indexOf('options.contentEl.classList.remove(REHOMED_CLASS);') < fn.indexOf('const ui = kit();'));
  const css = fs.readFileSync(path.join(__dirname, '..', 'public/css/app.css'), 'utf8');
  assert.match(css, /\.platform-surface-rehomed \{\s+visibility: hidden !important;\s+transition: none !important;\s+\}/);
});
