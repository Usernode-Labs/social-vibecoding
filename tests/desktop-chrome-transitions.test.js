'use strict';
// Desktop chrome after the navigation redesign (#2740):
//
//   #2758 — the header and the rail flickered on every tab change. Both are
//   pinned view-transition groups, and translucent; the kit's fade-through
//   takes the root snapshot (which carries the body's wallpaper) to opacity 0
//   mid-swap, so the bars showed the flat canvas through them for those
//   frames. frontend/src/lib/transition-ground.ts copies the wallpaper onto
//   <html> as the transition starts and app.css paints ::view-transition with
//   it.
//
//   #2764 — with the rail folded, pointing at #sidebar-toggle fades the rail
//   in over the page, as pointing at the window's left edge already did.
//   frontend/src/features/nav/rail-peek.ts is the one enter/leave pair both
//   use, with ONE grace timer between them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── #2758: the ground under the transition ──────────────────────────────

const ground = loadTsx('frontend/src/lib/transition-ground.ts');

function fakeDoc({ vt, wallpaper }) {
  const attrs = new Set(vt ? ['data-un-vt'] : []);
  const props = {};
  const body = { wallpaper };
  return {
    props,
    doc: {
      documentElement: {
        hasAttribute: (name) => attrs.has(name),
        style: {
          setProperty: (k, v) => { props[k] = v; },
          removeProperty: (k) => { delete props[k]; },
        },
      },
      body,
    },
    compute: (el) => ({
      getPropertyValue: (name) => (name === '--home-wallpaper' ? (el.wallpaper || '') : ''),
    }),
  };
}

test('a starting transition carries the body’s wallpaper onto <html>', () => {
  const { doc, props, compute } = fakeDoc({ vt: true, wallpaper: ' radial-gradient(red, blue) #f4f2e4 ' });
  assert.equal(ground.syncTransitionGround(doc, compute), 'radial-gradient(red, blue) #f4f2e4');
  assert.equal(props['--un-vt-ground'], 'radial-gradient(red, blue) #f4f2e4');
});

test('a route with no wallpaper leaves the transition on the plain canvas', () => {
  const { doc, props, compute } = fakeDoc({ vt: true, wallpaper: '' });
  props['--un-vt-ground'] = 'stale';
  assert.equal(ground.syncTransitionGround(doc, compute), '');
  assert.ok(!('--un-vt-ground' in props), 'a ground from an earlier route is not left behind');
});

test('nothing is copied when no transition is starting', () => {
  // The observer fires on the attribute's REMOVAL too, at the end of every
  // transition — that must not do a style read for nothing.
  const { doc, props, compute } = fakeDoc({ vt: false, wallpaper: 'red' });
  assert.equal(ground.syncTransitionGround(doc, compute), '');
  assert.deepEqual(props, {});
});

test('the ground is installed at the browser entry and painted by app.css on desktop', () => {
  assert.match(read('frontend/src/main.tsx'), /^import '\.\/lib\/transition-ground';$/m);
  const src = read('frontend/src/lib/transition-ground.ts');
  assert.match(src, /attributeFilter: \['data-un-vt'\]/,
    'it follows the kit’s own marker for a transition in flight');

  const css = read('public/css/app.css');
  const at = css.indexOf('html[data-un-vt]::view-transition {');
  assert.ok(at > 0, 'app.css paints the ground');
  assert.match(css.slice(at, at + 120), /background: var\(--un-vt-ground\);/);
  // Desktop only: the phone's bar is another request's, and its iOS lane
  // slides an opaque snapshot over this ground anyway.
  const media = css.lastIndexOf('@media', at);
  assert.equal(css.slice(media, css.indexOf('{', media)).trim(), '@media (min-width: 768px)');
  // The bars stay pinned and non-fading — this rule adds to that, it does not
  // replace it.
  assert.match(css, /html\[data-un-vt\]::view-transition-group\(platform-tabs\) \{\s*animation: none;/);
  assert.match(css, /html\[data-un-vt\]::view-transition-group\(platform-header\) \{\s*animation: none;/);
});

// ── #2764: the folded rail peeks from the toggle ────────────────────────

function loadPeek() {
  let state = { peek: false, peekOut: false, railOpen: false };
  const navStore = { get: () => state, set: (patch) => { state = { ...state, ...patch }; } };
  const mod = loadTsx('frontend/src/features/nav/rail-peek.ts', {
    stubs: { './nav-store.js': { navStore } },
  });
  return { mod, peek: () => state.peek, peekOut: () => state.peekOut };
}

test('entering a peek target shows the rail, leaving fades it away after the grace period', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { mod, peek, peekOut } = loadPeek();
  mod.enterPeek();
  assert.equal(peek(), true);
  mod.leavePeek();
  t.mock.timers.tick(mod.PEEK_GRACE_MS - 1);
  assert.equal(peek(), true, 'the pointer is still crossing the gap');
  assert.equal(peekOut(), false);
  // #2795: the grace period ends in a FADE, not a snap. The peek stays up
  // for the fade so the element is still there to fade.
  t.mock.timers.tick(1);
  assert.equal(peek(), true, 'the rail is still drawn while it fades');
  assert.equal(peekOut(), true, 'and the fade has started');
  assert.equal(mod.PEEK_FADE_MS, 200);
  t.mock.timers.tick(mod.PEEK_FADE_MS);
  assert.equal(peek(), false);
  assert.equal(peekOut(), false, 'a finished fade leaves nothing set');
});

test('pointing back at the rail during its fade cancels the fade (#2795)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { mod, peek, peekOut } = loadPeek();
  mod.enterPeek();
  mod.leavePeek();
  t.mock.timers.tick(mod.PEEK_GRACE_MS + 80);
  assert.equal(peekOut(), true, 'mid-fade');
  mod.enterPeek();
  assert.equal(peek(), true);
  assert.equal(peekOut(), false, 'the fade is undone at once');
  t.mock.timers.tick(mod.PEEK_FADE_MS * 3);
  assert.equal(peek(), true, 'and the pending removal never lands');
});

test('leaving the toggle and reaching the rail is ONE timer, not two', (t) => {
  // The toggle and the rail are different components. If each kept its own
  // grace timer, the toggle's would fire after the pointer had already
  // arrived on the rail and put it away under the pointer.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { mod, peek } = loadPeek();
  mod.enterPeek();            // pointer on the toggle
  mod.leavePeek();            // …leaves it, heading down
  t.mock.timers.tick(100);
  mod.enterPeek();            // …and arrives on the rail
  t.mock.timers.tick(mod.PEEK_GRACE_MS * 2);
  assert.equal(peek(), true, 'the rail stays up under the pointer');
});

test('the toggle peeks only a FOLDED rail, and its markup does not change to do it', () => {
  const toggle = read('frontend/src/features/nav/sidebar-toggle.tsx');
  assert.match(toggle, /import \{ clearPeekTimer, enterPeek, leavePeek \} from '\.\/rail-peek';/);
  // A press ends the peek, or folding the rail again under the same pointer
  // would bring it straight back as an overlay.
  assert.match(toggle, /clearPeekTimer\(\);\s*navStore\.set\(\{ railOpen: !navStore\.get\(\)\.railOpen, peek: false, peekOut: false \}\);/);
  // An open rail has nothing to bring back, and the press that follows the
  // hover is about to fold it.
  assert.match(toggle, /onMouseEnter=\{railOpen \? undefined : enterPeek\}/);
  assert.match(toggle, /onMouseLeave=\{peek \? leavePeek : undefined\}/);
  // Handlers are not attributes: the prerender and the first client render
  // still agree whatever the store holds, so hydration stays silent.
  assert.ok(!/className=\{[^}]*peek/.test(toggle), 'no class is computed from the peek');

  const bar = read('frontend/src/features/nav/tab-bar.tsx');
  assert.match(bar, /import \{ clearPeekTimer, enterPeek, leavePeek \} from '\.\/rail-peek';/);
  assert.match(bar, /return \{ enter: enterPeek, leave: peek \? leavePeek : clearPeekTimer \};/);
  assert.ok(!/setTimeout/.test(bar), 'the grace timer lives in rail-peek.ts alone');
});
