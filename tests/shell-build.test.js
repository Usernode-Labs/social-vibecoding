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

// ── Adjacent text children ─────────────────────────────────────────────
//
// The prerender uses renderToStaticMarkup, which omits the `<!-- -->` markers
// React writes between two adjacent text children — and main.tsx hydrates that
// document, where the pair has already been parsed as ONE text node. React
// calls that a mismatch: error #418, a console.error on EVERY route, which
// fails the platform's proposal checks. #1082 chunk E shipped one for exactly
// one build before the browser caught it (`<span>…</span>{' '}` followed by a
// sentence, in the admin view-only banner), which is why there are guards now.
//
// The authoritative one is in the build: it renders the same tree a second time
// with renderToString and refuses to write the artifact if any separator comes
// out. That needs the frontend workspace installed, so the two tests below add
// a net that does not: one keeps the gate itself from being removed, the other
// looks for the idiom in the sources directly.
const buildScript = fs.readFileSync(path.join(ROOT, 'frontend', 'scripts', 'build-shell.mjs'), 'utf8');
const prerenderSrc = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'prerender.tsx'), 'utf8');

test('the build still gates on adjacent text children', () => {
  assert.match(
    prerenderSrc, /renderToString/,
    'frontend/src/prerender.tsx must keep exporting a renderToString probe alongside the '
    + 'renderToStaticMarkup render — it is what makes an unhydratable text pair visible.',
  );
  assert.match(
    prerenderSrc, /export function renderShellWithSeparators/,
    'the probe export build-shell.mjs imports is gone or renamed',
  );
  assert.match(
    buildScript, /renderShellWithSeparators\(\)/,
    'frontend/scripts/build-shell.mjs must call the separator probe',
  );
  assert.match(
    buildScript, /<!-- -->/,
    'frontend/scripts/build-shell.mjs must still look for `<!-- -->` in the probe output and fail '
    + 'the build on it. Without this gate a hydration mismatch reaches every route silently.',
  );
});

test('no shell source renders a bare whitespace expression between text runs', () => {
  // Redundant with the build gate on purpose: this one runs in the root
  // workspace, where frontend/node_modules need not exist.
  const roots = [path.join(ROOT, 'frontend', 'src'), path.join(ROOT, 'frontend', '@')];
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx|jsx)$/.test(entry.name)) files.push(full);
    }
  };
  roots.filter((d) => fs.existsSync(d)).forEach(walk);
  assert.ok(files.length > 20, `only found ${files.length} TSX sources — the walk is wrong`);

  const offenders = [];
  for (const file of files) {
    // Strip comments first: the fix for the original mismatch is documented at
    // the site it happened, and that prose quotes the idiom it forbids.
    const code = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    code.split('\n').forEach((line, i) => {
      if (/\{\s*(['"]) \1\s*\}/.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
    });
  }
  assert.deepEqual(
    offenders, [],
    `these lines render a whitespace-only JSX expression, which makes the text around it two `
    + `adjacent children and cannot survive hydration (React #418):\n  ${offenders.join('\n  ')}\n`
    + "Put the space inside the neighbouring string instead — {' word…'} — or interpolate the "
    + 'whole run as one child.',
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
