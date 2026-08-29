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
};
