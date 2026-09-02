// Shared stamp logic for the React shell build artifacts.
//
// public/index.html and public/shell/assets/shell.js are generated from
// frontend/. Docker builds both for every image; tests and native local
// startup create ignored checkout-local copies through
// scripts/ensure-shell-artifacts.js.
//
// frontend/scripts/build-shell.mjs writes a stamp — a sha256 over every input
// that can change the output — into both artifacts. The local ensure step uses
// it to skip fresh outputs and rebuild stale ones; the image always generates
// both artifacts from scratch.
//
// The builder and dependency-light test MUST compute the stamp byte-for-byte
// the same way, hence this shared module. It uses node builtins only so the
// root suite can verify freshness without frontend/node_modules installed.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

const HTML_OUTPUT = 'public/index.html';
const JS_OUTPUT = 'public/shell/assets/shell.js';

// Every directory/file under frontend/ whose contents can change what the
// build emits. Both package files are inputs: package.json declares the direct
// dependencies and package-lock.json pins the complete transitive tree used by
// the Docker builder. node_modules is deliberately not an input.
const INPUT_PATHS = [
  'frontend/src',
  'frontend/@',
  'frontend/vite.config.ts',
  'frontend/vite.ssr.config.ts',
  'frontend/tsconfig.json',
  'frontend/package.json',
  'frontend/package-lock.json',
  'frontend/scripts/build-shell.mjs',
  'scripts/shell-stamp.js',
];

const HTML_STAMP_PREFIX = '<!-- shell-build stamp: ';
const HTML_STAMP_SUFFIX = ' -->';
const JS_STAMP_PREFIX = '/*! shell-build stamp: ';
const JS_STAMP_SUFFIX = ' */';

const SKIP_DIRS = new Set(['node_modules', '.git', '.ssr']);

function walk(rel, out) {
  const abs = path.join(ROOT, rel);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return;
  }
  if (stat.isFile()) {
    out.push(rel);
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    walk(`${rel}/${entry.name}`, out);
  }
}

// Every file the artifacts depend on, as repo-relative POSIX paths, sorted
// and de-duplicated. Resolved against the working tree, so a NEW component
// under frontend/@/components/ui/ changes the stamp too.
function resolveInputs() {
  const files = [];
  for (const rel of INPUT_PATHS) walk(rel, files);
  return [...new Set(files)].sort();
}

// sha256 over (path, byte length, bytes) of every input. Lengths are hashed
// explicitly so no concatenation of two files can collide with another pair.
function computeStamp(files) {
  const hash = crypto.createHash('sha256');
  for (const rel of files) {
    const bytes = fs.readFileSync(path.join(ROOT, rel));
    hash.update(rel);
    hash.update('\0');
    hash.update(String(bytes.length));
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function expectedStamp() {
  const files = resolveInputs();
  return { stamp: computeStamp(files), files };
}

// Pull the stamp out of the generated HTML. It is the first line inside
// <head> rather than the first line of the file, because a comment ahead of
// <!DOCTYPE html> is what puts old browsers into quirks mode.
function readHtmlStamp(html) {
  const m = /<head>\s*\n\s*<!-- shell-build stamp: ([0-9a-f]{64}) -->/.exec(String(html));
  return m ? m[1] : null;
}

function readJsStamp(js) {
  const firstLine = String(js).split('\n', 1)[0];
  if (!firstLine.startsWith(JS_STAMP_PREFIX) || !firstLine.endsWith(JS_STAMP_SUFFIX)) return null;
  const value = firstLine.slice(JS_STAMP_PREFIX.length, -JS_STAMP_SUFFIX.length).trim();
  return /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function formatHtmlStamp(stamp) {
  return `${HTML_STAMP_PREFIX}${stamp}${HTML_STAMP_SUFFIX}`;
}

function formatJsStamp(stamp) {
  return `${JS_STAMP_PREFIX}${stamp}${JS_STAMP_SUFFIX}`;
}

// ── The document's own build identity ──────────────────────────────────
//
// The stamp above answers "were these artifacts built from these sources".
// This answers a different question, and one the RUNNING TAB has to be able
// to ask: "which platform build am I?".
//
// It exists because App.loadedPlatformSha used to be captured from the FIRST
// /api/version answer a document saw. That is only a boot baseline when the
// document came off the network. A tab booting from the service worker's
// shell cache — a cold start after the app was killed, exactly when a
// platform deploy is most likely to have happened in between — runs the OLD
// build and records the NEW sha as its baseline, so `isStale` is false
// forever and the reload offer never appears. The one state the reload
// button exists for was the one state it could not reach.
//
// So the document says which build it is, baked in when it was generated:
// docker-compose.yml already passes GIT_SHA as a build arg, the Dockerfile's
// shell stage forwards it, and public/js/app.js reads the meta below instead
// of guessing from a server answer.
//
// `dev` is the honest answer, not a failure: local builds and the platform's
// own staging previews are built without a GIT_SHA (see
// src/services/mcp-connect-constants.js), and /api/version reports `dev`
// there too — so both halves agree and the stale path stays off, which is
// what it did before this existed.
const BUILD_META_NAME = 'platform-build';

// GIT_SHA arrives from the environment rather than from this repository, so
// it is narrowed rather than trusted: a commit sha, or the `dev` sentinel.
// Narrowed the same way src/services/mcp-connect-constants.js narrows it for
// the MCP server version, and to the full 40 characters because /api/version
// reports the full sha and app.js compares the two as strings.
function normalizeBuildSha(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(raw) ? raw : 'dev';
}

function formatBuildMeta(sha) {
  return `<meta name="${BUILD_META_NAME}" content="${normalizeBuildSha(sha)}">`;
}

// Pull the build id back out of a generated document. Kept beside the writer
// so the two spellings cannot drift; public/js/app.js reads the real one
// through the DOM.
function readBuildMeta(html) {
  const m = new RegExp(`<meta name="${BUILD_META_NAME}" content="([0-9a-f]{7,40}|dev)">`)
    .exec(String(html));
  return m ? m[1] : null;
}

// ── Build-scoped asset URLs ───────────────────────────────────────────
//
// The meta above says which build the DOCUMENT is. This is how its assets
// say it: a deployed document loads every script and stylesheet from
// `/b/<build sha>/…` instead of `/js/…`, so the URL changes exactly when the
// build does. That is the property that lets src/services/static-cache.js
// answer those requests with a year-long `immutable` Cache-Control instead
// of `no-cache, must-revalidate` — and the reason to want that is not the
// round trip (the service worker already answers a same-build asset from
// its cache without one) but V8's compiled-code cache: the browser keeps it
// only for a response it did not have to revalidate, so under the old
// policy every load PRODUCED a code cache for the 1.3MB shell bundle and
// never once consumed it. Measured warm at 4x CPU that was 81ms of the
// shell's boot, per load, for nothing.
//
// `dev` has no build id, so a checkout's document keeps the plain paths and
// today's policy: an edit to public/js/app.js must still show up on the next
// reload. Only a document generated with GIT_SHA gets the prefix, and only
// on the asset kinds a build owns — scripts and stylesheets. The document
// itself, the manifest and the icons keep their fixed URLs: the document is
// the one thing that must stay fresh, and the manifest's URL is the
// installed PWA's identity. /sw.js is excluded by name: its URL is the
// registration, and a per-build worker URL would register a new worker per
// deploy instead of updating the one there is.
//
// frontend/src/lib/asset-url.ts is the browser-side twin (the prerendered
// <script> tags at the end of <body> hydrate through it) and must produce
// byte-identical strings; tests/build-scoped-assets.test.js holds the two
// to that.
const BUILD_SCOPED_PREFIX = '/b/';
const BUILD_SCOPED_PATH_RE = /^\/b\/([0-9a-f]{7,40})(\/.*)$/;

function isBuildScopedAssetPath(pathname) {
  const p = String(pathname == null ? '' : pathname);
  if (p === '/sw.js') return false;
  return /\.(?:js|css)$/i.test(p);
}

/** `/js/app.js` → `/b/<sha>/js/app.js` for a build; unchanged for `dev` or a non-asset. */
function buildScopedAssetUrl(pathname, sha) {
  const id = normalizeBuildSha(sha);
  if (id === 'dev' || !isBuildScopedAssetPath(pathname)) return pathname;
  // Already scoped (a document rewritten twice) stays as it is: never /b/x/b/x/.
  if (parseBuildScopedPath(pathname)) return pathname;
  return `${BUILD_SCOPED_PREFIX}${id}${pathname}`;
}

/** `{ build, path }` for a build-scoped pathname, or null for any other. */
function parseBuildScopedPath(pathname) {
  const m = BUILD_SCOPED_PATH_RE.exec(String(pathname == null ? '' : pathname));
  return m ? { build: m[1], path: m[2] } : null;
}

// Rewrite the local script srcs and stylesheet hrefs of a document for a
// build. Only same-origin absolute paths, only the asset kinds above, and
// nothing else in the markup is touched — the head's tags keep their order
// and every other attribute, which is the whole reason build-shell.mjs
// carries src/head.html over as a string.
const ASSET_TAG_RE = /(<(?:script|link)\b[^>]*?\s(?:src|href)=")(\/[^"]*)(")/g;

function prefixShellAssetUrls(html, sha) {
  const id = normalizeBuildSha(sha);
  if (id === 'dev') return String(html);
  return String(html).replace(ASSET_TAG_RE, (match, before, pathname, after) => (
    isBuildScopedAssetPath(pathname) ? `${before}${buildScopedAssetUrl(pathname, id)}${after}` : match
  ));
}

module.exports = {
  ROOT,
  HTML_OUTPUT,
  JS_OUTPUT,
  INPUT_PATHS,
  computeStamp,
  expectedStamp,
  resolveInputs,
  readHtmlStamp,
  readJsStamp,
  formatHtmlStamp,
  formatJsStamp,
  BUILD_META_NAME,
  normalizeBuildSha,
  formatBuildMeta,
  readBuildMeta,
  BUILD_SCOPED_PREFIX,
  isBuildScopedAssetPath,
  buildScopedAssetUrl,
  parseBuildScopedPath,
  prefixShellAssetUrls,
};
