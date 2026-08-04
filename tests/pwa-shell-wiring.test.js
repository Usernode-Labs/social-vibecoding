// PWA offline-mode (#487) shell wiring: pins the contracts that keep the
// offline boot complete and the manifest installable.
//
//  1. Precache-list sync — every local script/stylesheet referenced by
//     index.html appears in sw.js's SHELL_ASSETS, so a newly-added
//     <script> can't silently break offline boot, AND index.html loads
//     nothing cross-origin at all (Tailwind is compiled into
//     /css/tailwind.css, marked/DOMPurify/qrcodejs are vendored under
//     /vendor/ — so SHELL_ASSETS is the complete render set and a first
//     offline launch can never come up unstyled). (index.html is the single
//     shell document now — the old standalone auth pages are redirect stubs
//     into the SPA's hash routes; fold-auth-pages-into-SPA.)
//  2. Every SHELL_ASSETS entry maps to a real file under public/ (no
//     dead precache entries, which would 404 during install).
//  3. manifest.webmanifest is valid and its icon files exist.
//  4. index.html carries the manifest link, theme-color, the offline
//     banner element, and loads offline.js (which registers the SW).
//  5. static-cache treats sw.js and the manifest as revalidate-every-load
//     shell assets.
//
// Run with: node --test tests/pwa-shell-wiring.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const sw = require('../public/sw.js');

function readPublic(rel) {
  return fs.readFileSync(path.join(PUBLIC, rel), 'utf8');
}

// Local script srcs + stylesheet hrefs referenced by an HTML shell page.
function localAssets(html) {
  const out = new Set();
  for (const m of html.matchAll(/<script[^>]+src="(\/[^"]+)"/g)) out.add(m[1]);
  for (const m of html.matchAll(/<link[^>]+href="(\/[^"]+\.css)"/g)) out.add(m[1]);
  return [...out];
}

// Cross-origin scripts / stylesheets referenced by an HTML shell page.
// Expected to be empty — see the invariant test below.
function crossOriginAssets(html) {
  const out = new Set();
  for (const m of html.matchAll(/<script[^>]+src="(https?:\/\/[^"]+)"/g)) out.add(m[1]);
  for (const m of html.matchAll(/<link[^>]+href="(https?:\/\/[^"]+)"/g)) out.add(m[1]);
  return [...out];
}

test('sw.js precaches every local asset index.html loads', () => {
  const html = readPublic('index.html');
  for (const asset of localAssets(html)) {
    assert.ok(
      sw.SHELL_ASSETS.includes(asset),
      `index.html loads ${asset} but sw.js SHELL_ASSETS doesn't precache it`
    );
  }
});

// The invariant that replaced the old CDN_ASSETS sync check: there is no
// third-party origin in the shell's critical path any more, so precaching
// SHELL_ASSETS is sufficient to render offline. Adding a CDN <script> back
// would silently reintroduce an unstyled/degraded offline boot and a
// dependency on someone else's uptime — compile it (npm run build:css) or
// vendor it (npm run vendor:assets) instead.
test('index.html loads no cross-origin scripts or stylesheets', () => {
  const offOrigin = crossOriginAssets(readPublic('index.html'));
  assert.deepEqual(
    offOrigin, [],
    `index.html must load every asset from its own origin; found: ${offOrigin.join(', ')}`
  );
});

// The native kit's demo page is served by this app too, and shares the one
// compiled stylesheet rather than pulling the Tailwind Play CDN.
test('the usernode-native demo page uses the compiled stylesheet, not a CDN', () => {
  const demo = readPublic('usernode-native/v1/demo.html');
  assert.deepEqual(crossOriginAssets(demo), []);
  assert.ok(demo.includes('<link rel="stylesheet" href="/css/tailwind.css">'),
    'demo.html should load the platform\'s compiled Tailwind');
});

test('sw.js precaches the shell page itself and the manifest, not the stubs', () => {
  for (const must of ['/index.html', '/manifest.webmanifest']) {
    assert.ok(sw.SHELL_ASSETS.includes(must), `SHELL_ASSETS missing ${must}`);
  }
  // The old standalone pages are redirect stubs — precaching them would
  // waste install work and could pin a stale redirect.
  for (const stub of ['/login.html', '/landing.html', '/register.html', '/waiting.html']) {
    assert.ok(!sw.SHELL_ASSETS.includes(stub), `SHELL_ASSETS still precaches stub ${stub}`);
  }
});

test('every SHELL_ASSETS entry exists under public/', () => {
  for (const asset of sw.SHELL_ASSETS) {
    const file = path.join(PUBLIC, asset.replace(/^\//, ''));
    assert.ok(fs.existsSync(file), `SHELL_ASSETS lists ${asset} but ${file} doesn't exist`);
  }
});

test('manifest.webmanifest is valid and installable', () => {
  const manifest = JSON.parse(readPublic('manifest.webmanifest'));
  assert.equal(typeof manifest.name, 'string');
  assert.ok(manifest.name.length > 0);
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2,
    'manifest needs at least two icons');
  for (const icon of manifest.icons) {
    const file = path.join(PUBLIC, icon.src.replace(/^\//, ''));
    assert.ok(fs.existsSync(file), `manifest icon ${icon.src} doesn't exist`);
    // PNG magic bytes — the generator must have produced real images.
    const head = fs.readFileSync(file).subarray(0, 8);
    assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `${icon.src} is not a PNG`);
  }
  const purposes = manifest.icons.map((i) => i.purpose);
  assert.ok(purposes.includes('maskable'), 'manifest needs a maskable icon');
});

test('index.html wires up the manifest, banner, and offline.js', () => {
  const html = readPublic('index.html');
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html, /<meta name="theme-color"/);
  assert.match(html, /id="offline-banner"/);
  assert.match(html, /<script src="\/js\/offline\.js"><\/script>/);
});

test('login.html is a redirect stub with no shell wiring of its own', () => {
  const html = readPublic('login.html');
  assert.match(html, /location\.replace\(/);
  // A stub must not register the SW or load app modules — the SPA it
  // redirects into owns all of that.
  assert.doesNotMatch(html, /offline\.js/);
  assert.doesNotMatch(html, /manifest\.webmanifest/);
});

test('offline.js registers the service worker at root scope', () => {
  const js = readPublic('js/offline.js');
  assert.match(js, /serviceWorker/);
  assert.match(js, /register\('\/sw\.js'\)/);
});

test('sw.js and manifest.webmanifest get the revalidate-every-load header', () => {
  const { shellAssetCacheControl, REVALIDATE } = require('../src/services/static-cache');
  assert.equal(shellAssetCacheControl('/srv/public/sw.js'), REVALIDATE);
  assert.equal(shellAssetCacheControl('/srv/public/manifest.webmanifest'), REVALIDATE);
  // Icons stay on the default policy (they're content-stable PNGs).
  assert.equal(shellAssetCacheControl('/srv/public/icons/icon-192.png'), null);
});
