// Contracts for the shell's COMPILED Tailwind stylesheet + vendored libs.
//
// Background: public/index.html used to load Tailwind's Play CDN, which
// compiled utilities in the browser on every page load and would generate
// CSS for any class it saw at runtime. That stylesheet is now built ahead of
// time (`npm run build:css`) and COMMITTED — the runtime image installs with
// `npm ci --production`, so tailwindcss isn't available to compile at deploy
// time, and neither the deploy workflow nor a worker checkout runs a build.
//
// A committed build artifact is only safe if staleness is detectable and the
// config can't silently drift, which is what this file pins:
//
//  1. FRESHNESS — the stamp in public/css/tailwind.css matches a hash
//     recomputed from tailwind.config.js, the input CSS and every scanned
//     source file. Edit markup without rebuilding and this fails.
//  2. CONFIG — the platform palette and the hoverOnlyWhenSupported future
//     flag (both formerly inline in index.html) actually reached the output.
//  3. SENTINEL CLASSES — the awkward shapes the shell really uses (arbitrary
//     values, opacity modifiers, dark:/group-hover: variants) are present, so
//     a content-glob regression shows up as a failing test rather than one
//     subtly unstyled badge on one screen.
//  4. WIRING — index.html links the stylesheet ahead of the native kit and
//     app.css (cascade order the shell depends on), references each vendored
//     library, and carries no CDN reference at all.
//
// Deliberately requires nothing from node_modules: freshness is verifiable
// without tailwindcss installed, so this runs in any checkout.
//
// Run with: node --test tests/tailwind-build.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { expectedStamp, readStamp, OUTPUT_FILE } = require('../scripts/tailwind-stamp');

const ROOT = path.join(__dirname, '..');
const CSS_PATH = path.join(ROOT, OUTPUT_FILE);
const css = fs.readFileSync(CSS_PATH, 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// Vendored third-party libs, in the load order index.html uses.
const VENDOR_FILES = [
  '/vendor/qrcode-1.0.0.min.js',
  '/vendor/marked-15.0.12.min.js',
  '/vendor/purify-3.4.4.min.js',
];

test('the committed stylesheet is in sync with its sources', () => {
  const stamped = readStamp(css);
  assert.ok(stamped, `${OUTPUT_FILE} has no build stamp on its first line — run \`npm run build:css\``);
  const { stamp, files } = expectedStamp();
  assert.equal(
    stamped, stamp,
    `${OUTPUT_FILE} is STALE (built from different sources than the ${files.length} files `
    + 'currently scanned). Run `npm run build:css` and commit the result.'
  );
});

test('the compiled stylesheet is substantial, not a stub', () => {
  // ~1100 distinct class tokens across the shell compile to tens of KB. A
  // near-empty file means the content globs matched nothing (e.g. a moved
  // public/js) — which would otherwise present as a totally unstyled app.
  assert.ok(css.length > 20000, `${OUTPUT_FILE} is only ${css.length} bytes — content globs likely matched nothing`);
  assert.ok(/\.dark\b/.test(css), 'expected darkMode:"class" output (.dark selectors)');
});

test('the platform palette from the old inline config reached the output', () => {
  // Tailwind emits palette colours as space-separated rgb triplets so the
  // opacity modifier can slot in: `rgb(8 8 15/var(--tw-bg-opacity,1))`.
  const triplets = {
    'zinc-950 (#08080f)': '8 8 15',
    'zinc-900 (#1a1a30)': '26 26 48',
    'violet-600 (#7c3aed)': '124 58 237',
    'violet-400 (#a78bfa)': '167 139 250',
  };
  for (const [name, rgb] of Object.entries(triplets)) {
    assert.ok(css.includes(rgb), `expected platform palette colour ${name} → rgb(${rgb}) in ${OUTPUT_FILE}`);
  }
  // And the stock ramp it replaces is absent — proof `theme.extend.colors`
  // actually applied rather than the defaults silently winning.
  assert.ok(!css.includes('rgb(9 9 11'), 'stock Tailwind zinc-950 (#09090b) leaked in — is the palette override wired up?');
});

test('future.hoverOnlyWhenSupported is compiled in', () => {
  // Without the flag, hover: utilities emit bare :hover rules, which stick
  // after taps on touch screens (the reason the flag was set originally).
  assert.match(css, /@media\s*\(hover:\s*hover\)/,
    'expected hover: utilities to be wrapped in an @media (hover: hover) guard');
});

test('sentinel classes used by the shell are present', () => {
  // Escaped forms as they appear in compiled CSS selectors.
  const sentinels = [
    // Arbitrary values (admin badges, mobile touch targets, modal heights).
    'text-\\[0\\.65rem\\]',
    'text-\\[11px\\]',
    'min-h-\\[44px\\]',
    'max-h-\\[70vh\\]',
    'max-w-\\[85vw\\]',
    // Opacity-modifier colours (status chips, focus rings).
    'bg-emerald-500\\/15',
    'ring-violet-500\\/40',
    // Plain palette utilities.
    'bg-violet-600',
    'text-zinc-400',
    'bg-zinc-950',
    // Variants: dark mode, hover, stacked dark+hover, focus, disabled,
    // responsive — each one used by real markup in the shell.
    'dark\\:bg-zinc-900:is(.dark *)',
    'hover\\:bg-violet-500',
    'dark\\:hover\\:bg-zinc-800',
    'focus\\:ring-violet-500',
    'disabled\\:opacity-60',
    'sm\\:col-span-2',
  ];
  for (const sentinel of sentinels) {
    assert.ok(css.includes(sentinel), `expected compiled utility for ${sentinel} in ${OUTPUT_FILE}`);
  }
});

test('index.html links the compiled stylesheet before the kit and app.css', () => {
  const tailwindAt = indexHtml.indexOf('href="/css/tailwind.css"');
  const kitAt = indexHtml.indexOf('href="/usernode-native/v1/native.css"');
  const appAt = indexHtml.indexOf('href="/css/app.css"');
  assert.ok(tailwindAt > -1, 'index.html must link /css/tailwind.css');
  assert.ok(kitAt > -1 && appAt > -1, 'index.html must still link the kit and app.css');
  // Cascade contract: utilities first, so the kit's --un-* overrides and
  // app.css keep winning equal-specificity conflicts (as they did when the
  // Play CDN injected its <style> at the top of <head>).
  assert.ok(tailwindAt < kitAt, '/css/tailwind.css must be linked BEFORE the native kit stylesheet');
  assert.ok(tailwindAt < appAt, '/css/tailwind.css must be linked BEFORE /css/app.css');
});

test('index.html loads nothing from a CDN and has no inline config left', () => {
  // Scoped to ASSET-loading tags: not the whole file (the comments recording
  // what these tags replaced would trip it) and not <a href>, since outbound
  // hyperlinks to third parties are entirely fine — it's fetched subresources
  // that must be same-origin.
  for (const m of indexHtml.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)="([^"]+)"/g)) {
    assert.ok(!/^https?:\/\//.test(m[1]), `index.html still loads an off-origin asset: ${m[1]}`);
  }
  assert.ok(!/tailwind\.config\s*=/.test(indexHtml),
    'the inline tailwind.config must live in tailwind.config.js — an inline one is dead code now');
});

test('every vendored library is referenced and present on disk', () => {
  for (const rel of VENDOR_FILES) {
    assert.ok(indexHtml.includes(`src="${rel}"`), `index.html should load ${rel}`);
    const file = path.join(ROOT, 'public', rel.replace(/^\//, ''));
    assert.ok(fs.existsSync(file), `${rel} is referenced but ${file} doesn't exist — run \`npm run vendor:assets\``);
    assert.ok(fs.statSync(file).size > 1000, `${rel} looks truncated`);
  }
  // Provenance for the SRI hashes the same-origin tags can no longer carry.
  const readme = path.join(ROOT, 'public', 'vendor', 'README.md');
  assert.ok(fs.existsSync(readme), 'public/vendor/README.md (provenance) is missing');
  const provenance = fs.readFileSync(readme, 'utf8');
  for (const rel of VENDOR_FILES) {
    assert.ok(provenance.includes(path.basename(rel)), `README.md should record provenance for ${rel}`);
  }
});

test('vendored tags carry no integrity/crossorigin attributes', () => {
  // SRI is meaningless same-origin, and a stale hash would break the shell.
  for (const m of indexHtml.matchAll(/<script[^>]+src="\/vendor\/[^"]+"[^>]*>/g)) {
    assert.ok(!/integrity=/.test(m[0]), `same-origin vendor tag should not carry integrity: ${m[0]}`);
    assert.ok(!/crossorigin=/.test(m[0]), `same-origin vendor tag should not carry crossorigin: ${m[0]}`);
  }
});
