// Tests for AppView.visualsTilesHtml (#353): clicking a before/after tile
// must open the in-app side-by-side comparison overlay
// (AppView.openVisualComparison) instead of opening the raw asset in a new
// tab. So the rendered tiles are <button> elements carrying the whole
// group's artifact ids as data-* attributes — NOT <a target="_blank">
// anchors to /visuals/<id>.
//
// app-view.js is a plain browser script (`const AppView = {…}`). We load
// its source into a vm context, stub the globals it touches, expose
// AppView, and assert on the returned HTML string.
//
// Run with: node --test tests/visuals-tiles-render.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function makeAppView() {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 1 } },
    Kudos: { renderButton: () => '' },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return sandbox.__AppView;
}

const ID = (c) => c.repeat(32);

test('tiles are clickable comparison triggers, not raw-asset anchors', () => {
  const AppView = makeAppView();
  const html = AppView.visualsTilesHtml({
    captures: [{
      index: 0, path: '/',
      before: { png: ID('a') },
      after: { png: ID('b') },
    }],
  });
  // No new-tab anchor escape hatch on the tiles themselves.
  assert.doesNotMatch(html, /target="_blank"/, 'tiles must not be new-tab anchors');
  // Clicking opens the in-app comparison overlay.
  assert.match(html, /AppView\.openVisualComparison\(this\)/, 'tile wired to openVisualComparison');
  // The whole group travels on the tile as data-* attributes.
  assert.match(html, new RegExp(`data-before-png="${ID('a')}"`));
  assert.match(html, new RegExp(`data-after-png="${ID('b')}"`));
  assert.match(html, /data-visual-tile="before"/);
  assert.match(html, /data-visual-tile="after"/);
});

test('non-hex ids are dropped exactly like idOk did before', () => {
  const AppView = makeAppView();
  const html = AppView.visualsTilesHtml({
    captures: [{
      index: 0, path: '/',
      before: { png: 'not-a-valid-id' },
      after: { png: ID('b') },
    }],
  });
  assert.doesNotMatch(html, /not-a-valid-id/, 'invalid id never reaches the DOM');
  // The before side has no valid media, so it renders no before tile, but
  // the after tile still appears (and still carries the valid after id).
  assert.match(html, new RegExp(`data-after-png="${ID('b')}"`));
  assert.doesNotMatch(html, /data-before-png=/, 'no before id when its media is invalid');
});

test('webm tile prefers the video branch with the PNG poster', () => {
  const AppView = makeAppView();
  const html = AppView.visualsTilesHtml({
    captures: [{
      index: 0, path: '/board',
      before: { png: ID('a'), webm: ID('c') },
      after: { png: ID('b') },
    }],
  });
  assert.match(html, new RegExp(`<video src="/visuals/${ID('c')}" poster="/visuals/${ID('a')}"`));
  assert.match(html, /Before \/ after: <code>\/board<\/code>/, 'non-root group is path-labelled');
});

test('empty / missing visuals render nothing', () => {
  const AppView = makeAppView();
  assert.equal(AppView.visualsTilesHtml(null), '');
  assert.equal(AppView.visualsTilesHtml({}), '');
  assert.equal(AppView.visualsTilesHtml({ captures: [] }), '');
});

// ── mobile capture groups (#768) ───────────────────────────────────────

test('a mobile group is labelled "(mobile)" and stamps data-viewport on its tiles', () => {
  const AppView = makeAppView();
  const html = AppView.visualsTilesHtml({
    captures: [{
      index: 0, path: '/board', viewport: 'mobile',
      before: { png: ID('a') },
      after: { png: ID('b') },
    }],
  });
  assert.match(html, /Before \/ after: <code>\/board<\/code> \(mobile\)/, 'row label carries the frame');
  assert.match(html, /data-viewport="mobile"/, 'tiles carry the viewport for the overlay');
});

test('a lone mobile ROOT group is still labelled (desktop root stays unlabelled)', () => {
  const AppView = makeAppView();
  const mobileHtml = AppView.visualsTilesHtml({
    captures: [{ index: 0, path: '/', viewport: 'mobile', after: { png: ID('b') } }],
  });
  assert.match(mobileHtml, /Before \/ after: <code>\/<\/code> \(mobile\)/);
  const desktopHtml = AppView.visualsTilesHtml({
    captures: [{ index: 0, path: '/', after: { png: ID('b') } }],
  });
  assert.doesNotMatch(desktopHtml, /Before \/ after —/, 'single desktop root group renders unlabelled');
  assert.doesNotMatch(desktopHtml, /data-viewport=/);
});

// ── Honest-pair captions (screenshot-reliability spec) ─────────────────

test('an after-only group renders the "new page" caption', () => {
  const AppView = makeAppView();
  const html = AppView.visualsTilesHtml({
    captures: [{ index: 0, path: '/settings', after: { png: ID('b') } }],
  });
  assert.match(html, /New page \(no production version to compare\)/);
});

test('a fell-back before renders the home-page caption', () => {
  const AppView = makeAppView();
  const html = AppView.visualsTilesHtml({
    captures: [{
      index: 0, path: '/board', beforeFellBack: true,
      before: { png: ID('a') }, after: { png: ID('b') },
    }],
  });
  assert.match(html, /shows the home page. This page didn’t exist in production yet/);
});

test('a complete pair renders no caption', () => {
  const AppView = makeAppView();
  const html = AppView.visualsTilesHtml({
    captures: [{
      index: 0, path: '/board',
      before: { png: ID('a') }, after: { png: ID('b') },
    }],
  });
  assert.doesNotMatch(html, /New page \(/);
  assert.doesNotMatch(html, /shows the home page/);
});

// ── gallery mode options (admin /gallery reuses this renderer) ──────────

test('default output is byte-identical to calling with no options', () => {
  const AppView = makeAppView();
  const visuals = {
    captures: [{
      index: 0, path: '/board',
      before: { png: ID('a'), webm: ID('c') },
      after: { png: ID('b'), webm: ID('d') },
    }],
  };
  // The proposal-card / dev-chat call sites pass nothing — that path must not
  // shift when the gallery's options are added.
  assert.equal(AppView.visualsTilesHtml(visuals), AppView.visualsTilesHtml(visuals, {}));
  assert.match(AppView.visualsTilesHtml(visuals), /muted loop autoplay playsinline/);
});

test('gallery mode makes recordings click-to-play instead of autoplaying', () => {
  const AppView = makeAppView();
  const html = AppView.visualsTilesHtml({
    captures: [{ index: 0, path: '/board', before: { png: ID('a') }, after: { png: ID('b'), webm: ID('d') } }],
  }, { preload: 'none', overlay: false });
  assert.match(html, /preload="none"/);
  assert.match(html, /controls/);
  assert.doesNotMatch(html, /autoplay/, '20 autoplaying clips per page is not acceptable');
});

test('gallery mode drops the SPA comparison-overlay wiring', () => {
  const AppView = makeAppView();
  const html = AppView.visualsTilesHtml({
    captures: [{ index: 0, path: '/board', before: { png: ID('a') }, after: { png: ID('b') } }],
  }, { preload: 'none', overlay: false });
  // openVisualComparison depends on SPA state the standalone page lacks, so
  // tiles must be inert figures rather than buttons that do nothing.
  assert.doesNotMatch(html, /openVisualComparison/);
  assert.doesNotMatch(html, /<button/);
  assert.match(html, /<figure/);
  // The path/viewport data attributes still ride along for debugging.
  assert.match(html, /data-visual-tile="before"/);
});

test('gallery mode marks a still-only tile "no recording"', () => {
  const AppView = makeAppView();
  const withRec = AppView.visualsTilesHtml({
    captures: [{ index: 0, path: '/board', after: { png: ID('b'), webm: ID('d') } }],
  }, { preload: 'none', overlay: false });
  const stillOnly = AppView.visualsTilesHtml({
    captures: [{ index: 0, path: '/board', after: { png: ID('b') } }],
  }, { preload: 'none', overlay: false });
  assert.match(stillOnly, /no recording/);
  assert.doesNotMatch(withRec, /no recording/);
  // The marker is gallery-only — proposal cards stay unchanged.
  assert.doesNotMatch(AppView.visualsTilesHtml({
    captures: [{ index: 0, path: '/board', after: { png: ID('b') } }],
  }), /no recording/);
});

test('gallery mode still renders the honest captions', () => {
  const AppView = makeAppView();
  const html = AppView.visualsTilesHtml({
    captures: [{
      index: 0, path: '/board', beforeFellBack: true,
      before: { png: ID('a') }, after: { png: ID('b') },
    }],
  }, { preload: 'none', overlay: false });
  assert.match(html, /shows the home page/);
});
