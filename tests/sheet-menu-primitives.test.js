'use strict';

// One Sheet and one Menu for the shell (frontend/src/lib/sheet.ts,
// frontend/src/lib/menu.ts).
//
// Eighteen surfaces used to hand their own node to the native kit and then
// write Escape, Back, the scrim and focus by hand, each a little differently;
// the menus each wrote their own outside press and Escape. These tests run the
// two primitives against a hand-stepped React (effects included) and just
// enough DOM, and hold that every caller goes through them.
//
// Run with: node --test tests/sheet-menu-primitives.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { createFakeReact, createDom } = require('./lib/sheet-harness');

function setup() {
  const dom = createDom();
  const savedDocument = globalThis.document;
  globalThis.document = dom.doc;
  const fake = createFakeReact();
  const claims = [];
  const backStack = {
    pushDismissible(close) {
      const claim = { close, released: null };
      claims.push(claim);
      return (options) => { claim.released = options || {}; };
    },
  };
  const stubs = { react: fake.React, './back-stack': backStack };
  const sheet = loadTsx('frontend/src/lib/sheet.ts', { stubs, cache: false });
  const menu = loadTsx('frontend/src/lib/menu.ts', { stubs, cache: false });
  const restore = () => { globalThis.document = savedDocument; };
  return { dom, fake, claims, sheet, menu, restore };
}

/** Mount one sheet as its own component. Its panel holds `buttons` focusable children. */
function mountSheet(t, options = {}, buttons = 2) {
  const { dom, sheet } = t;
  const panel = dom.node('panel');
  const kids = Array.from({ length: buttons }, (_, i) => panel.append(dom.node(`button${i}`, { focusable: true })));
  let closes = 0;
  let result = null;
  const component = t.fake.mount(() => {
    result = sheet.useSheet({ kind: 'sheet', onClose: () => { closes += 1; }, ...options });
    result.panelRef.current = panel;
  });
  return { panel, kids, get closes() { return closes; }, result: () => result, unmount: component.unmount };
}

// ── The Sheet ────────────────────────────────────────────────────────────

test('Escape closes the sheet while focus is in it or nowhere, and stands aside otherwise', () => {
  const t = setup();
  try {
    const opener = t.dom.node('opener', { focusable: true });
    opener.focus();
    const s = mountSheet(t, { initialFocus: (panel) => panel.kids[1] });
    assert.equal(t.sheet.openSheetCount(), 1);
    assert.equal(t.dom.doc.activeElement, s.kids[1], 'focus goes where initialFocus says');

    // A key something else already handled (a dialog above, a menu) is not ours.
    t.dom.key('Escape', { prevented: true });
    assert.equal(s.closes, 0);
    // Focus somewhere else on the page: that surface's key.
    const elsewhere = t.dom.node('elsewhere');
    elsewhere.focus();
    t.dom.key('Escape');
    assert.equal(s.closes, 0, 'focus outside the sheet leaves it open');
    // Focus inside: closed, once, and the key is spent.
    s.kids[0].focus();
    const event = t.dom.key('Escape');
    assert.equal(s.closes, 1);
    assert.equal(event.defaultPrevented, true);
    // Asked twice in a frame (Escape and Back together), the owner hears once.
    t.dom.key('Escape');
    assert.equal(s.closes, 1, 'closing is asked for once');

    // Unmounted: off the stack, and focus goes back to what opened it.
    t.dom.doc.activeElement = t.dom.doc.body;
    s.unmount();
    assert.equal(t.sheet.openSheetCount(), 0);
    assert.equal(t.dom.doc.activeElement, opener, 'focus returns to the opener');
  } finally {
    t.restore();
  }
});

test('with two sheets up, Escape reaches only the top one', () => {
  const t = setup();
  try {
    const under = mountSheet(t);
    const over = mountSheet(t);
    t.dom.doc.activeElement = t.dom.doc.body;
    t.dom.key('Escape');
    assert.equal(over.closes, 1, 'the top sheet closes');
    assert.equal(under.closes, 0, 'the one under it stays');
    over.unmount();
    t.dom.key('Escape');
    assert.equal(under.closes, 1, 'then the next one down');
  } finally {
    t.restore();
  }
});

test('Tab stays inside the sheet, both ways', () => {
  const t = setup();
  try {
    const s = mountSheet(t, {}, 3);
    s.kids[2].focus();
    const forward = t.dom.key('Tab');
    assert.equal(forward.defaultPrevented, true);
    assert.equal(t.dom.doc.activeElement, s.kids[0], 'from the last, Tab wraps to the first');
    const back = t.dom.key('Tab', { shiftKey: true });
    assert.equal(back.defaultPrevented, true);
    assert.equal(t.dom.doc.activeElement, s.kids[2], 'from the first, Shift+Tab wraps to the last');
    s.kids[1].focus();
    assert.equal(t.dom.key('Tab').defaultPrevented, false, 'in the middle the browser moves it');
  } finally {
    t.restore();
  }
});

test('Back closes it; closed any other way, the claim goes back as a navigating one', () => {
  const t = setup();
  try {
    const first = mountSheet(t);
    assert.equal(t.claims.length, 1, 'opening claims the next Back');
    assert.equal(t.claims[0].close(), true, 'Back is consumed');
    assert.equal(first.closes, 1, 'and closes the sheet');
    first.unmount();
    assert.equal(t.claims[0].released, null, 'a record Back already spent is not spent again');

    const second = mountSheet(t);
    assert.equal(t.claims.length, 2);
    second.unmount();
    assert.deepEqual(t.claims[1].released, { navigating: true },
      'a close by any other way hands it back, spent a task later only if nothing moved');
  } finally {
    t.restore();
  }
});

test('the caller\'s own scrim closes it on a press that began and ended on it, after the opening tap', () => {
  const t = setup();
  try {
    const s = mountSheet(t);
    const { scrimProps } = s.result();
    const scrim = {};
    const realNow = Date.now;
    try {
      // The ghost click of the tap that opened it.
      scrimProps.onPointerDown({ target: scrim, currentTarget: scrim });
      scrimProps.onClick({ target: scrim, currentTarget: scrim, detail: 1 });
      assert.equal(s.closes, 0, 'inside the opening gesture\'s window, nothing closes');
      Date.now = () => realNow() + 1000;
      // A press that began in the sheet and ended on the scrim (a selection).
      scrimProps.onPointerDown({ target: s.panel, currentTarget: scrim });
      scrimProps.onClick({ target: scrim, currentTarget: scrim, detail: 1 });
      assert.equal(s.closes, 0, 'a release from inside is not a tap outside');
      // A tap inside the sheet bubbles to the scrim with another target.
      scrimProps.onClick({ target: s.panel, currentTarget: scrim, detail: 1 });
      assert.equal(s.closes, 0);
      scrimProps.onPointerDown({ target: scrim, currentTarget: scrim });
      scrimProps.onClick({ target: scrim, currentTarget: scrim, detail: 1 });
      assert.equal(s.closes, 1, 'a tap on the scrim closes it');
    } finally {
      Date.now = realNow;
    }
  } finally {
    t.restore();
  }
});

test('the Sheet presents through the dialogs\' kit seam, holds the page, and names the kit\'s shell', () => {
  const src = read('frontend/src/lib/sheet.ts');
  // The dialogs' seam by default; a standing sheet (the Homeroom menu,
  // Notifications) asks for the touch gate and a home on <body> instead.
  assert.match(src, /adoptKitSurface\(\{\s*kind,\s*contentEl: panel,\s*adoptedOn: rootRef\.current \|\| undefined,\s*home,\s*gate,/);
  assert.match(src, /gate = 'kit', home = 'placeholder',/);
  assert.match(src, /import \{ MODAL_GESTURE_GUARD_MS, nameKitShell \} from '\.\/static-modal';/,
    'the ghost-click window and the shell\'s name are the dialogs\' own');
  assert.match(src, /holdPage = true,/);
  assert.match(src, /const unlock = holdPage \? lockPage\(panel, \{ inert: false \}\) : null;/);
  assert.match(src, /if \(handle\) handle\.release\(\);/, 'the card comes home before React removes it');
  // The dialogs' route holds the page the same way.
  const staticModal = read('frontend/src/lib/static-modal.ts');
  assert.match(staticModal, /if \(!open \|\| !root\) return undefined;\s*return lockPage\(root, \{ inert: false \}\);/);
});

// ── The Menu ─────────────────────────────────────────────────────────────

test('the Menu closes on Escape before anything under it hears the key, and on Back', () => {
  const t = setup();
  try {
    const trigger = t.dom.node('trigger', { focusable: true });
    const panel = t.dom.node('menu');
    const rows = [panel.append(t.dom.node('row0', { focusable: true })), panel.append(t.dom.node('row1', { focusable: true }))];
    let closes = 0;
    let result = null;
    let open = true;
    trigger.focus();
    const component = t.fake.mount(() => {
      result = t.menu.useMenu(open, {
        trigger: { current: trigger },
        panel: { current: panel },
        onClose: () => { closes += 1; },
        keys: 'panel',
        initialFocus: () => rows[1],
      });
    });
    assert.equal(t.dom.doc.activeElement, rows[1], 'focus moves in on open');
    assert.equal(result.panelProps['data-owns-escape'], '', 'the kit\'s modal Escape stands aside while it is up');

    // A bubble listener under the menu (a sheet, a column) never hears it.
    let heardUnder = 0;
    t.dom.doc.addEventListener('keydown', () => { heardUnder += 1; });
    const event = t.dom.key('Escape');
    assert.equal(closes, 1);
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.stopped, true);
    assert.equal(heardUnder, 0);

    assert.equal(t.claims.length, 1, 'opening claims the next Back');
    assert.equal(t.claims[0].close(), true);
    assert.equal(closes, 2);

    // Closed: listeners off, focus back on the trigger.
    open = false;
    t.dom.doc.activeElement = t.dom.doc.body;
    component.rerender();
    assert.equal(t.dom.doc.activeElement, trigger, 'focus comes back to the trigger');
    assert.equal(t.claims[0].released, null, 'a record Back spent is not spent again');
    t.dom.key('Escape');
    assert.equal(closes, 2, 'a closed menu hears nothing');
  } finally {
    t.restore();
  }
});

test('a menu of rows closes on Tab and hands focus to its trigger; a panel keeps Tab', () => {
  const t = setup();
  try {
    const trigger = t.dom.node('trigger', { focusable: true });
    const panel = t.dom.node('menu');
    let closes = 0;
    let result = null;
    let keys = 'menu';
    const component = t.fake.mount(() => {
      result = t.menu.useMenu(true, { trigger: { current: trigger }, panel: { current: panel }, onClose: () => { closes += 1; }, keys });
    });
    result.panelProps.onKeyDown({ key: 'Tab', preventDefault() {} });
    assert.equal(closes, 1);
    assert.equal(t.dom.doc.activeElement, trigger);
    keys = 'panel';
    component.rerender();
    result.panelProps.onKeyDown({ key: 'Tab', preventDefault() {} });
    assert.equal(closes, 1, 'a panel with a search in it keeps Tab');
  } finally {
    t.restore();
  }
});

test('the Menu is built from the shared pieces: the anchored dismissal, the menu keys and the back stack', () => {
  const src = read('frontend/src/lib/menu.ts');
  assert.match(src, /import \{ MENU_ITEM_SELECTOR, focusFirstItem, roveMenuFocus \} from '\.\/menu-keys';/);
  assert.match(src, /import \{ useAnchoredDismiss \} from '\.\/popover-dismiss';/);
  assert.match(src, /useAnchoredDismiss\(open, \[trigger, options\.panel\], close, \{\s*escape: false,\s*move: !!options\.move,/);
  const dismiss = read('frontend/src/lib/popover-dismiss.ts');
  assert.match(dismiss, /const \{ escape = true, move = true \} = optionsRef\.current;/,
    'every other caller keeps the behaviour it had');
});

// ── Every caller goes through them ───────────────────────────────────────

const SHEET_CALLERS = [
  'frontend/src/features/profile/friends-sheet.tsx',
  'frontend/src/features/profile/app-slots-sheet.tsx',
  'frontend/src/features/profile/feedback-sheet.tsx',
  'frontend/src/features/profile/week-share-sheet.tsx',
  'frontend/src/features/profile/staking-sheet.tsx',
  'frontend/src/features/profile/profile-edit-sheet.tsx',
  'frontend/src/features/profile/avatar-crop-dialog.tsx',
  'frontend/src/features/versions/updates-sheet.tsx',
  'frontend/src/features/dev-board/suggest-back-dialog.tsx',
  'frontend/src/features/apps/featured-illustration-editor.tsx',
  'frontend/src/features/ai/project-picker.tsx',
  'frontend/src/features/messages/project-picker.tsx',
  'frontend/src/features/messages/thread-builder.tsx',
  'frontend/src/features/workshop/community-switcher.tsx',
  'frontend/src/features/mobile-install/install-steps-sheet.tsx',
  'frontend/src/features/notify-ask/get-app-sheet.tsx',
  // The two standing sheets, since lib/sheet-controller.js folded into the Sheet.
  'frontend/src/features/app-context/index.tsx',
  'frontend/src/features/notifications/index.tsx',
];

const MENU_CALLERS = [
  'frontend/src/features/ai/project-picker.tsx',
  'frontend/src/features/messages/project-picker.tsx',
  'frontend/src/features/messages/thread-builder.tsx',
  'frontend/src/features/workshop/community-switcher.tsx',
  'frontend/src/features/detail/detail-card.tsx',
  'frontend/src/features/side-panel/side-panel.tsx',
];

test('the sheets are the Sheet\'s, and write no Escape, Back or kit hand-off of their own', () => {
  for (const file of SHEET_CALLERS) {
    const src = read(file);
    assert.match(src, /useSheet\(\{/, `${file} is presented by the Sheet`);
    assert.doesNotMatch(src, /adoptKitSurface|lib\/kit-surface/, `${file} adopts nothing by hand`);
    assert.doesNotMatch(src, /pushDismissible/, `${file} claims no Back of its own`);
    assert.doesNotMatch(src, /onKeyDown=\{\(e(vent)?\) => \{ if \(e(vent)?\.key === 'Escape'\)/, `${file} writes no Escape of its own`);
  }
});

test('the menus are the Menu\'s', () => {
  for (const file of MENU_CALLERS) {
    const src = read(file);
    assert.match(src, /useMenu\((true|open|menu), \{/, `${file} hangs its menu through the Menu`);
    assert.match(src, /\{\.\.\.panelProps\}/, `${file} puts the Menu's keys and mark on its panel`);
    assert.doesNotMatch(src, /addEventListener\('pointerdown', (onDown|away), true\)/, `${file} writes no outside press of its own`);
  }
});

test('only the shared seams hand a node to the kit by hand', () => {
  // The Homeroom menu and Notifications moved onto the Sheet, and their
  // route (lib/sheet-controller.js) is gone. The one left is the developer
  // console's touch sheet.
  assert.equal(fs.existsSync(path.join(ROOT, 'frontend/src/lib/sheet-controller.js')), false);
  const allowed = new Set([
    'frontend/src/lib/kit-surface.ts',
    'frontend/src/lib/static-modal.ts',
    'frontend/src/lib/sheet.ts',
    'frontend/src/features/dev-console/store.ts',
  ]);
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return walk(rel);
    return /\.(tsx?|js)$/.test(entry.name) ? [rel] : [];
  });
  const offenders = walk('frontend/src')
    .filter((rel) => !allowed.has(rel))
    .filter((rel) => /\badoptKitSurface\s*\(/.test(read(rel)));
  assert.deepEqual(offenders, []);
});

test('the anchored panel nobody imported is gone', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'frontend/@/components/ui/anchored-panel.tsx')), false);
});
