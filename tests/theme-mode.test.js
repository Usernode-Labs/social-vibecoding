// Tests for the Light / Dark / System theme mode selector (#256).
//
// Static-assertion style (cf. tests/spec-sections.test.js,
// tests/app-conventions.test.js): read the shipped source files and assert
// the wiring is present, so the feature can't silently regress.
//
// Run with: node --test tests/theme-mode.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (...p) => fs.readFileSync(path.join(PUBLIC, ...p), 'utf8');

const THEMED_PAGES = [
  'index.html',
  'login.html',
  'register.html',
  'admin.html',
  'admin-features.html',
  'dashboard.html',
  'debug.html',
  'status.html',
];

// Standalone pages that get the SHARED theme-toggle control (#576) —
// every themed page EXCEPT index.html, which has its own drawer control.
const TOGGLE_PAGES = [
  'login.html',
  'register.html',
  'dashboard.html',
  'admin.html',
  'admin-features.html',
  'debug.html',
  'status.html',
];

// ── theme.js module contract ─────────────────────────────────────────────

test('public/js/theme.js exists and exposes the Theme API', () => {
  const src = read('js', 'theme.js');
  assert.match(src, /window\.Theme\s*=/, 'theme.js must assign window.Theme');
  for (const fn of ['get', 'set', 'apply', 'onChange']) {
    assert.match(src, new RegExp(`function ${fn}\\b`), `theme.js must define ${fn}()`);
  }
});

test('theme.js implements the localStorage.theme storage contract', () => {
  const src = read('js', 'theme.js');
  // 'light' / 'dark' stored explicitly; system removes the key.
  assert.match(src, /setItem\(\s*KEY/, 'set() must persist the key for light/dark');
  assert.match(src, /removeItem\(\s*KEY/, 'set() must remove the key for system');
  assert.match(src, /try\s*\{/, 'localStorage access must be wrapped in try/catch');
});

test('theme.js defines the three modes', () => {
  const src = read('js', 'theme.js');
  for (const mode of ['light', 'dark', 'system']) {
    assert.ok(src.includes(`'${mode}'`), `theme.js must reference the '${mode}' mode`);
  }
});

test('theme.js registers prefers-color-scheme and storage listeners', () => {
  const src = read('js', 'theme.js');
  assert.match(
    src,
    /matchMedia\(\s*'\(prefers-color-scheme: dark\)'\s*\)\.addEventListener\(\s*'change'/,
    'theme.js must listen for OS colour-scheme changes',
  );
  assert.match(
    src,
    /addEventListener\(\s*'storage'/,
    'theme.js must listen for cross-tab storage changes',
  );
});

// ── Per-page includes + no-flash guard ───────────────────────────────────

for (const page of THEMED_PAGES) {
  test(`${page} includes /js/theme.js`, () => {
    assert.ok(read(page).includes('/js/theme.js'), `${page} must load /js/theme.js`);
  });

  test(`${page} carries the inline no-flash guard`, () => {
    assert.ok(
      read(page).includes('localStorage.theme'),
      `${page} must contain the inline no-flash guard reading localStorage.theme`,
    );
  });
}

// ── Drawer control markup (index.html) ───────────────────────────────────

test('index.html has the theme drawer row inside the header menu panel', () => {
  const src = read('index.html');
  const panelIdx = src.indexOf('id="header-menu-panel"');
  const rowIdx = src.indexOf('id="drawer-row-theme"');
  assert.ok(panelIdx !== -1, 'header-menu-panel missing');
  assert.ok(rowIdx !== -1, 'drawer-row-theme missing');
  assert.ok(rowIdx > panelIdx, 'drawer-row-theme must live inside the header menu panel');
});

test('index.html exposes the three data-theme-mode buttons', () => {
  const src = read('index.html');
  for (const mode of ['light', 'dark', 'system']) {
    assert.ok(
      src.includes(`data-theme-mode="${mode}"`),
      `index.html must have a data-theme-mode="${mode}" button`,
    );
  }
});

// ── app.js wiring ────────────────────────────────────────────────────────

test('app.js HeaderMenu wires Theme.get / Theme.set', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(src, /Theme\.get\(\)/, 'app.js must read Theme.get()');
  assert.match(src, /Theme\.set\(/, 'app.js must call Theme.set()');
  assert.match(src, /_renderThemeButtons/, 'app.js must define/use the _renderThemeButtons helper');
});

test('the theme button click handler does NOT close the drawer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  // Isolate the theme-button click handler region and assert it sets the
  // mode without the HeaderMenu.close() that every navigation row uses.
  const setIdx = src.indexOf('Theme.set(');
  assert.ok(setIdx !== -1, 'Theme.set call not found');
  const window = src.slice(setIdx, setIdx + 200);
  assert.ok(
    !window.includes('HeaderMenu.close()'),
    'theme selection must keep the drawer open (no HeaderMenu.close())',
  );
});

// ── Shared theme-toggle module (#576) ────────────────────────────────────

test('public/js/theme-toggle.js exists and reuses window.Theme', () => {
  const src = read('js', 'theme-toggle.js');
  assert.match(src, /window\.Theme/, 'theme-toggle.js must reference window.Theme');
  assert.match(src, /Theme\.set\(/, 'theme-toggle.js must call Theme.set()');
  assert.match(src, /Theme\.get\(/, 'theme-toggle.js must read Theme.get()');
  assert.match(src, /Theme\.onChange\(/, 'theme-toggle.js must re-highlight on Theme.onChange');
});

test('theme-toggle.js renders the three data-theme-mode modes', () => {
  const src = read('js', 'theme-toggle.js');
  for (const mode of ['light', 'dark', 'system']) {
    assert.ok(src.includes(`'${mode}'`), `theme-toggle.js must reference the '${mode}' mode`);
  }
  assert.match(src, /themeMode\s*=/, 'theme-toggle.js must set data-theme-mode on its buttons');
});

test('theme-toggle.js targets an id="theme-toggle" host', () => {
  const src = read('js', 'theme-toggle.js');
  assert.match(src, /getElementById\(\s*'theme-toggle'\s*\)/, 'must look up the #theme-toggle host');
});

// ── Per-page toggle control wiring (#576) ────────────────────────────────

for (const page of TOGGLE_PAGES) {
  test(`${page} loads /js/theme-toggle.js after /js/theme.js`, () => {
    const src = read(page);
    const themeIdx = src.indexOf('/js/theme.js');
    const toggleIdx = src.indexOf('/js/theme-toggle.js');
    assert.ok(themeIdx !== -1, `${page} must load /js/theme.js`);
    assert.ok(toggleIdx !== -1, `${page} must load /js/theme-toggle.js`);
    assert.ok(toggleIdx > themeIdx, `${page} must load theme-toggle.js AFTER theme.js`);
  });

  test(`${page} has a #theme-toggle container`, () => {
    assert.ok(
      read(page).includes('id="theme-toggle"'),
      `${page} must carry a #theme-toggle container for the shared control`,
    );
  });
}

// index.html keeps its own drawer control and must NOT pull in the shared
// module (avoids a duplicate toggle).
test('index.html does NOT include the shared theme-toggle module', () => {
  assert.ok(
    !read('index.html').includes('/js/theme-toggle.js'),
    'index.html uses the drawer control, not the shared theme-toggle module',
  );
});

// ── CSS theme-invariant fixes (#576) ─────────────────────────────────────

test('app.css routes the vote chips through theme variables (no #fff/#1f2937)', () => {
  const css = read('css', 'app.css');
  const votedBox = css.slice(css.indexOf('.gc-vote-voted-box {'), css.indexOf('.gc-vote-voted-box-yes'));
  assert.ok(votedBox.includes('var(--bg-primary)'), '.gc-vote-voted-box must use var(--bg-primary)');
  assert.ok(!votedBox.includes('background: #fff'), '.gc-vote-voted-box must not hardcode background: #fff');

  const countPill = css.slice(css.indexOf('.gc-vote-count {'), css.indexOf('.gc-vote-count-pending'));
  assert.ok(countPill.includes('var(--bg-primary)'), '.gc-vote-count must use var(--bg-primary)');

  assert.match(
    css,
    /\.gc-vote-count-label\s*\{[^}]*color:\s*var\(--text-primary\)/,
    '.gc-vote-count-label must use var(--text-primary), not the fixed #1f2937',
  );
});
