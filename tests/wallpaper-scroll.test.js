'use strict';
// The wallpaper's star rides the page: frontend/src/lib/wallpaper-scroll.ts
// writes --home-star-y on <html> from the visible screen's scroll offset,
// and app.css reads it as the star layer's vertical position. See the
// module header for why the star stays a body-background layer at all.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const mod = loadTsx('frontend/src/lib/wallpaper-scroll.ts');

// A document of scrollers: { id: { hidden, scrollTop, offsetHeight } }.
function fakeDoc(elements) {
  const listeners = {};
  const props = {};
  const els = {};
  for (const [id, spec] of Object.entries(elements)) {
    const classes = new Set(spec.hidden ? ['hidden'] : []);
    els[id] = {
      id,
      scrollTop: spec.scrollTop || 0,
      offsetHeight: spec.offsetHeight || 0,
      classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    };
  }
  const doc = {
    els,
    props,
    getElementById: (id) => els[id] || null,
    addEventListener: (type, fn, opts) => { listeners[type] = { fn, opts }; },
    documentElement: { style: { setProperty: (k, v) => { props[k] = v; } } },
    fire: (type, targetId) => listeners[type].fn({ target: els[targetId] || { id: targetId } }),
    listeners,
  };
  return doc;
}
function fakeWin() {
  const frames = [];
  const listeners = {};
  return {
    frames,
    listeners,
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    flush() { while (frames.length) frames.shift()(); },
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
}
function boot(elements) {
  delete globalThis.__usernodeVisibility;
  const doc = fakeDoc(elements);
  const win = fakeWin();
  const apply = mod.initWallpaperScroll(doc, win);
  win.flush();
  return { doc, win, apply };
}

test('the launcher at rest reads as unscrolled: rest is the parked search bar', () => {
  const { doc } = boot({
    'home-search-bar': { offsetHeight: 52 },
    'home-screen': { scrollTop: 52 },
  });
  assert.equal(doc.props['--home-star-y'], '0px');
});

test('scrolling the launcher moves the star up by the distance past rest', () => {
  const { doc } = boot({
    'home-search-bar': { offsetHeight: 52 },
    'home-screen': { scrollTop: 52 },
  });
  doc.els['home-screen'].scrollTop = 172;
  doc.fire('scroll', 'home-screen');
  assert.equal(doc.props['--home-star-y'], '-120px', 'written inside the scroll event, no frame later');
  // Pulling the search bar into view moves the page — and the star — down.
  doc.els['home-screen'].scrollTop = 0;
  doc.fire('scroll', 'home-screen');
  assert.equal(doc.props['--home-star-y'], '52px');
});

test('the listener is capture-phase and passive, and ignores nested scrollers', () => {
  const { doc } = boot({ 'home-screen': { scrollTop: 0 } });
  assert.deepEqual(doc.listeners.scroll.opts, { capture: true, passive: true },
    'scroll does not bubble; only a capturing document listener sees every scroller');
  doc.els['home-screen'].scrollTop = 40;
  doc.fire('scroll', 'discover-rail');
  assert.equal(doc.props['--home-star-y'], '0px', 'a rail or a sheet scrolling is not the page scrolling');
});

test('the peer screens scroll from zero, and the landing overlay wins while it shows', () => {
  const { doc, win } = boot({
    'home-screen': { hidden: true, scrollTop: 300 },
    'leaderboard-screen': { scrollTop: 30 },
  });
  assert.equal(doc.props['--home-star-y'], '-30px');
  // The landing is a fixed overlay above the signed-in shell: while it
  // shows, its own scroller is the page, whatever is underneath.
  doc.els['auth-landing-screen'] = { id: 'auth-landing-screen', classList: { contains: () => false } };
  doc.els['auth-landing-scroll'] = { id: 'auth-landing-scroll', scrollTop: 12 };
  win.listeners.hashchange();
  win.flush();
  assert.equal(doc.props['--home-star-y'], '-12px');
});

test('a screen change re-reads the offset from the store, a frame later', () => {
  const { doc, win } = boot({
    'home-screen': { scrollTop: 200 },
    'browse-screen': { hidden: true, scrollTop: 0 },
  });
  assert.equal(doc.props['--home-star-y'], '-200px');
  doc.els['home-screen'].classList.add('hidden');
  doc.els['browse-screen'].classList.remove('hidden');
  for (const fn of globalThis.__usernodeVisibility.listeners) fn();
  assert.equal(doc.props['--home-star-y'], '-200px', 'deferred: the DOM may not have settled');
  win.flush();
  assert.equal(doc.props['--home-star-y'], '0px');
});

test('inside an app (no wallpaper scroller showing) the star sits at rest', () => {
  const { doc } = boot({
    'home-screen': { hidden: true, scrollTop: 500 },
    'app-view': { scrollTop: 0 },
  });
  assert.equal(doc.props['--home-star-y'], '0px');
});

test('app.css reads the property on every star layer and never declares it', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'app.css'), 'utf8');
  const layers = css.match(/var\(--home-star\) right 32px top [^/]+\//g) || [];
  assert.equal(layers.length, 4, 'phone + desktop, light + dark');
  for (const layer of layers) {
    assert.match(layer, /top var\(--home-star-y, 0px\) \//, 'the star layer follows the scroll property');
  }
  // The value lives on <html> as an inline style. A declaration in the
  // stylesheet's body rule would sit between that and the star and win.
  assert.doesNotMatch(css, /--home-star-y\s*:/, 'no stylesheet rule may set --home-star-y');
});

test('the shell entry loads the module as a side effect', () => {
  const main = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'main.tsx'), 'utf8');
  assert.match(main, /import '\.\/lib\/wallpaper-scroll';/);
});
