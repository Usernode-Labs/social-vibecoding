// The document says which platform build it is.
//
// ── What was wrong ─────────────────────────────────────────────────────
//
// `App.loadedPlatformSha` is the baseline every "the platform moved on"
// decision is made against: the Improve button's dot, the drawer's reload
// row, the shell prefetch, and pull-to-refresh's upgrade to a full reload.
// It was captured from the FIRST /api/version answer each document saw.
//
// That is only a boot baseline when the document came off the network.
// public/sw.js races every navigation against the cached document on a
// deadline it documents as deliberately shorter than a round trip, and a cold
// start — the app killed and reopened, which is exactly when a deploy has
// most likely landed in between — loses it by design. Such a tab runs the OLD
// build, records the NEW sha as its own baseline, and `isStale` is false for
// the life of the document. No dot, no prefetch, no reload offer. The one
// state that whole machine exists for was the one state it could not observe,
// and the only way out was killing the app again and getting lucky.
//
// ── The contract ───────────────────────────────────────────────────────
//
//  1. The build identity is BAKED INTO THE DOCUMENT at generation time:
//     `<meta name="platform-build" content="…">`, written by
//     frontend/scripts/build-shell.mjs from the GIT_SHA the image was built
//     with. A cached document therefore carries the sha of the build it
//     actually is, not the sha of whatever the server answers later.
//  2. The Dockerfile's shell stage declares `ARG GIT_SHA` so that value can
//     reach the build at all — docker-compose.yml has passed it as a build
//     arg all along, and with no ARG declared it was silently dropped.
//  3. GIT_SHA comes from the environment, so it is NARROWED, not trusted:
//     a hex sha, or the `dev` sentinel.
//  4. `dev` means "no deploy behind this build" — local runs and the
//     platform's own staging previews. /api/version reports `dev` there too,
//     so both halves agree and the stale path stays off, exactly as before.
//     Only then does loadVersion's first-poll capture still fill the baseline
//     in, as the fallback it now is.
//
// Run with: node --test tests/platform-build-identity.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const {
  BUILD_META_NAME, normalizeBuildSha, formatBuildMeta, readBuildMeta,
  readHtmlStamp, HTML_OUTPUT,
} = require('../scripts/shell-stamp');

const appJs = read('public/js/app.js');
const buildShell = read('frontend/scripts/build-shell.mjs');
const dockerfile = read('Dockerfile');
const compose = read('docker-compose.yml');

// ─── 1. The value is narrowed, not trusted ──────────────────────────────

test('a GIT_SHA is narrowed to a hex sha or the dev sentinel', () => {
  assert.equal(normalizeBuildSha('DEADBEEFcafe1234567890abcdefabcdef123456'),
    'deadbeefcafe1234567890abcdefabcdef123456', 'a real sha, lowercased');
  assert.equal(normalizeBuildSha('  abc1234  '), 'abc1234', 'trimmed; short shas are shas');

  // Everything else is `dev` — including the things that would otherwise end
  // up inside the meta's quoted attribute value.
  for (const hostile of [
    '', null, undefined, 'dev', 'zzzzzzz', 'abc123', 'v1.2.3',
    '"><script>alert(1)</script>', 'abc1234 extra',
    'a'.repeat(41),
  ]) {
    assert.equal(normalizeBuildSha(hostile), 'dev',
      `${JSON.stringify(hostile)} is not a build id`);
  }
});

test('the writer and the reader cannot drift apart', () => {
  const sha = 'deadbeefcafe1234567890abcdefabcdef123456';
  assert.equal(readBuildMeta(formatBuildMeta(sha)), sha);
  assert.equal(readBuildMeta(formatBuildMeta('nonsense')), 'dev');
  assert.equal(readBuildMeta('<p>no meta here</p>'), null);
  assert.equal(BUILD_META_NAME, 'platform-build',
    'public/js/app.js selects on this literal name');
});

// ─── 2. The generated document carries it ───────────────────────────────

test(`${HTML_OUTPUT} carries its build identity beside the stamp`, () => {
  const html = read(HTML_OUTPUT);
  assert.ok(readHtmlStamp(html), 'the stamp is still the first line inside <head>');
  assert.equal(readBuildMeta(html), 'dev',
    'a checkout-local build has no GIT_SHA, so it says so rather than guessing');

  // Order matters only for the stamp (readHtmlStamp anchors on <head>), but
  // the meta must be in the head and ahead of the carried-over head.html, so
  // nothing in that verbatim block can be mistaken for it.
  const metaAt = html.indexOf(`<meta name="${BUILD_META_NAME}"`);
  assert.ok(metaAt > 0 && metaAt < html.indexOf('GENERATED FILE'),
    'the build id sits between the stamp and the do-not-edit banner');
  assert.equal(html.split(`name="${BUILD_META_NAME}"`).length - 1, 1,
    'exactly one build id in the document');
});

test('the builder writes it from the environment, through the narrowing', () => {
  assert.match(buildShell, /normalizeBuildSha\(process\.env\.GIT_SHA\)/,
    'the sha comes from the build environment and is narrowed on the way in');
  assert.match(buildShell, /\$\{formatBuildMeta\(buildSha\)\}/,
    'and is composed into the document by the shared formatter');
});

// ─── 3. The image build actually supplies it ────────────────────────────

test('the Dockerfile shell stage declares GIT_SHA so the build arg is not dropped', () => {
  const stage = dockerfile.slice(
    dockerfile.indexOf('FROM node:22-alpine AS shell'),
    dockerfile.indexOf('FROM node:22-alpine AS css'),
  );
  assert.ok(stage.length > 0, 'the shell stage is located');
  assert.match(stage, /^ARG GIT_SHA=dev$/m,
    'declared, and defaulted to the sentinel for builds with no deploy behind them');
  assert.match(stage, /^ENV GIT_SHA=\$GIT_SHA$/m,
    'and forwarded into the environment build-shell.mjs reads');

  // Layer-cache ordering: a new commit changes GIT_SHA on every single
  // deploy, so declaring it above `npm ci` would reinstall the whole frontend
  // dependency tree each time.
  assert.ok(stage.indexOf('RUN npm ci') < stage.indexOf('ARG GIT_SHA'),
    'the ARG comes AFTER npm ci — otherwise every deploy busts that layer');
  assert.ok(stage.indexOf('ARG GIT_SHA') < stage.indexOf('RUN node frontend/scripts/build-shell.mjs'),
    'and BEFORE the build that reads it');
});

test('compose passes the platform build arg on every build path', () => {
  const anchor = compose.slice(
    compose.indexOf('x-usernode-platform: &usernode-platform'),
    compose.indexOf('  image: usernode-platform:latest'),
  );
  assert.ok(anchor.length > 0, 'the shared platform build config is located');
  assert.match(anchor, /args:\s*\n\s*GIT_SHA: \$\{GIT_SHA:-dev\}/,
    'both colors build with the deploying commit; deploy.sh, platform-rollout.sh '
    + 'and rollback.sh each patch .env GIT_SHA before building');
});

// ─── 4. The tab reads it as its boot baseline ───────────────────────────

// Executed, not grepped: the reader is three lines and every one of them is a
// case that has to behave (absent meta, `dev`, a real sha, a throwing DOM).
function readerIn(metaContent) {
  const src = appJs.slice(
    appJs.indexOf('function documentPlatformSha() {'),
    appJs.indexOf('// Top-level `const` doesn\'t auto-write to `window`'),
  );
  assert.ok(src.length > 0, 'documentPlatformSha is defined at module scope');
  const ctx = {
    document: {
      querySelector: (sel) => {
        assert.equal(sel, 'meta[name="platform-build"]', 'selects the build meta by name');
        if (metaContent === 'THROW') throw new Error('no DOM');
        if (metaContent === null) return null;
        return { getAttribute: () => metaContent };
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${src}\nvar __out = documentPlatformSha();`, ctx);
  return ctx.__out;
}

test('the boot baseline is read from the document, not from a server answer', () => {
  const sha = 'deadbeefcafe1234567890abcdefabcdef123456';
  assert.equal(readerIn(sha), sha, 'a deployed build knows which build it is');
  assert.equal(readerIn('dev'), null, 'the sentinel is not a baseline');
  assert.equal(readerIn(''), null);
  assert.equal(readerIn(null), null, 'a document built before this shipped has no meta');
  assert.equal(readerIn('THROW'), null, 'and nothing here may throw during App construction');
});

test('App seeds loadedPlatformSha from the document', () => {
  assert.match(appJs, /\n  loadedPlatformSha: documentPlatformSha\(\),/,
    'the baseline is the document\'s own build id');
});

test('the first-poll capture survives as the fallback, for dev and staging only', () => {
  const fn = appJs.slice(
    appJs.indexOf('  async loadVersion() {'),
    appJs.indexOf('  async platformMovedOn()'),
  );
  assert.ok(fn.length > 0, 'loadVersion is located');
  assert.match(fn, /if \(!App\.loadedPlatformSha && info\.sha && info\.sha !== 'dev'\) \{/,
    'it only fills a baseline the document did not supply — so on a deploy, '
    + 'where the meta is a real sha, the old wrong-baseline path is unreachable');
});
