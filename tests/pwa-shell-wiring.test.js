// PWA offline-mode (#487) shell wiring: pins the contracts that keep the
// offline boot complete and the manifest installable.
//
//  1. Precache-list sync — every local script/stylesheet (and CDN script)
//     referenced by index.html / login.html appears in sw.js's
//     SHELL_ASSETS / CDN_ASSETS, so a newly-added <script> can't silently
//     break offline boot.
//  2. Every SHELL_ASSETS entry maps to a real file under public/ (no
//     dead precache entries, which would 404 during install).
//  3. manifest.webmanifest is valid and its icon files exist.
//  4. index.html / login.html carry the manifest link, theme-color, the
//     offline banner element, and load offline.js (which registers the SW).
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

function cdnAssets(html) {
  const out = new Set();
  for (const m of html.matchAll(/<script[^>]+src="(https:\/\/[^"]+)"/g)) out.add(m[1]);
  return [...out];
}

test('sw.js precaches every local asset index.html and login.html load', () => {
  for (const page of ['index.html', 'login.html']) {
    const html = readPublic(page);
    for (const asset of localAssets(html)) {
      assert.ok(
        sw.SHELL_ASSETS.includes(asset),
        `${page} loads ${asset} but sw.js SHELL_ASSETS doesn't precache it`
      );
    }
    for (const url of cdnAssets(html)) {
      assert.ok(
        sw.CDN_ASSETS.includes(url),
        `${page} loads ${url} but sw.js CDN_ASSETS doesn't list it`
      );
    }
  }
});

test('sw.js precaches the shell pages themselves and the manifest', () => {
  for (const must of ['/index.html', '/login.html', '/manifest.webmanifest']) {
    assert.ok(sw.SHELL_ASSETS.includes(must), `SHELL_ASSETS missing ${must}`);
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

test('login.html wires up the manifest, banner, and offline.js', () => {
  const html = readPublic('login.html');
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html, /id="offline-banner"/);
  assert.match(html, /<script src="\/js\/offline\.js"><\/script>/);
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
