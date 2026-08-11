// Freshness of the React shell's committed build artifacts.
//
// public/index.html and public/shell/assets/shell.js are GENERATED from
// frontend/ and committed to the repo. Unlike the deploy-generated Tailwind
// stylesheet, tests and non-Docker checkouts need the shell's rendered markup
// and executable bundle without installing the separate frontend workspace.
//
// That is only safe if staleness is impossible to miss, which is what this
// test is for. `npm run build:shell` stamps both artifacts with a sha256 over
// every input under frontend/; here we recompute it from the working tree and
// fail when they disagree.
//
// Run with: node --test tests/shell-build.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  expectedStamp, readHtmlStamp, readJsStamp, HTML_OUTPUT, JS_OUTPUT,
} = require('../scripts/shell-stamp');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, HTML_OUTPUT), 'utf8');
const js = fs.readFileSync(path.join(ROOT, JS_OUTPUT), 'utf8');

const REMEDY = 'Run `npm run build:shell` and commit the result in the same commit.';

test('the generated index.html is in sync with frontend/', () => {
  const stamped = readHtmlStamp(html);
  assert.ok(
    stamped,
    `${HTML_OUTPUT} has no shell-build stamp in its <head> — it was hand-edited or written by `
    + `something other than the build. ${REMEDY}`,
  );
  const { stamp, files } = expectedStamp();
  assert.equal(
    stamped, stamp,
    `${HTML_OUTPUT} is STALE (built from different sources than the ${files.length} files under `
    + `frontend/ that currently exist). ${REMEDY}`,
  );
});

test('the generated shell bundle is in sync with frontend/', () => {
  const stamped = readJsStamp(js);
  assert.ok(stamped, `${JS_OUTPUT} has no shell-build stamp on its first line. ${REMEDY}`);
  const { stamp } = expectedStamp();
  assert.equal(
    stamped, stamp,
    `${JS_OUTPUT} is STALE — it does not match the current frontend/ sources. ${REMEDY}`,
  );
});

test('both artifacts came from the SAME build', () => {
  // Catches the half-applied case: a rebuilt index.html committed next to a
  // stale bundle (or the reverse), which no single-artifact check would see.
  assert.equal(
    readJsStamp(js), readHtmlStamp(html),
    `${HTML_OUTPUT} and ${JS_OUTPUT} carry different stamps, so they were produced by different `
    + `builds. ${REMEDY}`,
  );
});

test('the generated index.html is a plausible shell document, not a stub', () => {
  assert.ok(
    html.length > 80000,
    `${HTML_OUTPUT} is only ${html.length} bytes — the prerender produced an empty or partial tree.`,
  );
  assert.ok(html.includes('GENERATED FILE — DO NOT EDIT'),
    `${HTML_OUTPUT} should carry the do-not-edit banner the build writes`);
  assert.ok(html.includes('id="home-screen"'), 'the home screen is missing from the generated markup');
  assert.ok(html.includes('id="app-view"'), 'the app view is missing from the generated markup');
});

test('the shell bundle is the real React build, not a stub', () => {
  assert.ok(js.length > 100000, `${JS_OUTPUT} is only ${js.length} bytes — the client build looks empty.`);
  // React's own hydration-mismatch message text survives minification, which
  // makes it a reliable marker that react-dom/client is actually bundled in
  // (rather than externalised or tree-shaken to nothing).
  assert.match(
    js, /[Hh]ydrat/,
    `${JS_OUTPUT} contains no hydration code — main.tsx must hydrate the existing markup, not `
    + 'client-render it. Client-rendering would blank the shell until JS ran and would break '
    + 'screenshot capture and the legacy scripts that query the DOM on DOMContentLoaded.',
  );
});

test('the shell bundle is the only asset the build emits, and it emits no CSS', () => {
  // A stylesheet emitted here would need a FOURTH <link> in the head, which
  // would land after /css/tailwind.css and invert the cascade contract the
  // head's own probe exists to defend. frontend/scripts/build-shell.mjs fails
  // the build on this; assert it from the committed tree too, so a
  // hand-copied artifact can't sneak one in.
  const assetsDir = path.join(ROOT, 'public', 'shell', 'assets');
  const emitted = fs.readdirSync(assetsDir).sort();
  assert.deepEqual(
    emitted, ['shell.js'],
    'public/shell/assets should contain exactly shell.js. A .css file here means something under '
    + 'frontend/ imported its own stylesheet; a second .js means code splitting got enabled (the '
    + 'output is deliberately a single unhashed chunk so sw.js SHELL_ASSETS stays a constant).',
  );
});
