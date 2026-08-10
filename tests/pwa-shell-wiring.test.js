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
//  4. index.html carries the manifest link, theme-color and the offline
//     banner element, and loads the React bundle — which registers the SW
//     and owns the connectivity engine since #1078 retired /js/offline.js.
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

test('index.html wires up the manifest, the banner, and the React bundle', () => {
  const html = readPublic('index.html');
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html, /<meta name="theme-color"/);
  assert.match(html, /id="offline-banner"/);
  // The SW used to be registered by <script src="/js/offline.js">. #1078
  // converted the offline banner to a React island and retired that module,
  // so the registration moved into the React bundle — which is the one
  // module script the document loads.
  assert.doesNotMatch(html, /\/js\/offline\.js/,
    'offline.js was retired in #1078; index.html must not still load it');
  assert.match(html, /<script type="module"[^>]+src="\/shell\/assets\/shell\.js"/,
    'the React bundle (which now registers the SW) must be loaded');
});

test('login.html is a redirect stub with no shell wiring of its own', () => {
  const html = readPublic('login.html');
  assert.match(html, /location\.replace\(/);
  // A stub must not register the SW or load app modules — the SPA it
  // redirects into owns all of that.
  assert.doesNotMatch(html, /offline\.js/);
  assert.doesNotMatch(html, /manifest\.webmanifest/);
});

test('the React bundle registers the service worker at root scope', () => {
  // Source-level, because the built bundle is minified: the registration
  // module is asserted by name, and main.tsx must actually call it. Root
  // scope ('/sw.js', not '/js/sw.js') is what lets the SW control every
  // navigation — a scope regression only shows up as "offline boot stopped
  // working", long after the change.
  const mod = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'lib', 'service-worker.ts'), 'utf8',
  );
  assert.match(mod, /serviceWorker/);
  assert.match(mod, /register\('\/sw\.js'\)/);

  const entry = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'main.tsx'), 'utf8',
  );
  assert.match(entry, /registerServiceWorker\(\)/,
    'main.tsx must call registerServiceWorker() — nothing else does');

  // And the shipped bundle really contains it (the source could be right
  // while the committed artifact is stale).
  assert.match(readPublic('shell/assets/shell.js'), /register\("\/sw\.js"\)|register\('\/sw\.js'\)/,
    'public/shell/assets/shell.js is stale — run npm run build:shell');
});

test('the offline engine kept window.Offline and its consumers', () => {
  // Six call sites across app.js, app-view.js, home.js and auth-screens.js
  // reach for this global, and app.js's ?shot=offline / ?shot=offline-signin
  // deep links depend on forceOffline() specifically — those captures are the
  // only way the offline UI can be photographed on a working network.
  const mod = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'lib', 'offline.ts'), 'utf8',
  );
  assert.match(mod, /Offline: OfflineApi \}\)\.Offline = api/,
    'lib/offline.ts must install window.Offline');
  for (const member of ['isOffline', 'nudge', 'forceOffline', 'probe']) {
    assert.ok(mod.includes(member), `window.Offline lost its ${member}() member`);
  }
  // The body class every offline affordance in app.css hangs off, and the
  // event other modules re-render on.
  assert.match(mod, /classList\.toggle\('is-offline'/);
  assert.match(mod, /usernode:offline-change/);
  // /health, uncached — the SW bypasses it so the probe reflects real
  // reachability rather than a cached copy.
  assert.match(mod, /fetch\('\/health', \{ cache: 'no-store' \}\)/);
});

test('sw.js and manifest.webmanifest get the revalidate-every-load header', () => {
  const { shellAssetCacheControl, REVALIDATE } = require('../src/services/static-cache');
  assert.equal(shellAssetCacheControl('/srv/public/sw.js'), REVALIDATE);
  assert.equal(shellAssetCacheControl('/srv/public/manifest.webmanifest'), REVALIDATE);
  // Icons stay on the default policy (they're content-stable PNGs).
  assert.equal(shellAssetCacheControl('/srv/public/icons/icon-192.png'), null);
});

test('offline affordances only gate the anonymous auth screens (#1021)', () => {
  const html = readPublic('index.html');
  // Both places an offline visitor can land carry an explanation.
  assert.ok(html.split('class="offline-only').length - 1 >= 2,
    'the login and landing screens should each explain the offline state');
  // data-offline-disabled greys a control out AND blocks its clicks, so a
  // stray one in the authed shell would silently break a working feature
  // for anyone whose probe is briefly failing. Keep them confined to the
  // auth overlays, whose actions genuinely cannot work offline.
  const authStart = html.indexOf('id="auth-landing-screen"');
  const authEnd = html.indexOf('id="auth-waitlist-screen"');
  assert.ok(authStart > -1 && authEnd > authStart);
  for (const m of html.matchAll(/data-offline-disabled/g)) {
    assert.ok(m.index > authStart && m.index < authEnd,
      `data-offline-disabled at index ${m.index} is outside the auth screens`);
  }
});

test('the offline state is styled from the committed stylesheet, not inline', () => {
  // body.is-offline is toggled by src/lib/offline.ts and every visual consequence
  // lives in app.css — nothing here depends on a Tailwind utility that
  // would have to be generated for a class name built at runtime.
  const css = readPublic('css/app.css');
  for (const sel of ['body.is-offline', '.offline-only', '[data-offline-disabled]']) {
    assert.ok(css.includes(sel), `app.css has no ${sel} rule`);
  }
});
