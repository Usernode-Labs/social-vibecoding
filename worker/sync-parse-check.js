#!/usr/bin/env node
'use strict';

// A fast parse gate over the files a Claude-resolved merge touched (#6536).
//
// On 4 Nov 2026 a model's conflict resolution dropped the leading `/` of a
// doc comment in frontend/src/features/ai/index.tsx. The tree still had no
// conflict markers, so run-cc.sh committed and pushed it; the shell build
// then stopped on "Unexpected `**`", and the change sat unbuildable for days
// with nothing saying the sync had caused it. This runs before the push:
// every file the merge touched, or the model edited, must at least parse.
//
// It takes file paths (relative to the working directory) as arguments and
// prints one `path:line:column: message` line per file that fails, exiting 1
// when any do. Deleted files, files it cannot read, and extensions it does
// not know are skipped.
//
//   .js .mjs .cjs   node --check
//   .ts .tsx .jsx   esbuild.transformSync (the frontend's own esbuild first,
//                   then the worker image's esbuild binary, run as a command:
//                   worker/Dockerfile builds it from source with a patched Go)
//   .json           JSON.parse, then a walk that refuses a key defined twice
//
// When the merge touched a language catalog (frontend/locales/), the English
// catalogs are also read through scripts/language-packs.js `collectCatalogs`,
// the same check the shell build runs, because JSON.parse cannot see the
// duplicate keys it refuses. On 18 Nov 2026 a sync kept both sides of
// en/home.json, defining six keys twice; the file parsed, so it was pushed,
// and every preview build then failed with nothing saying the sync had done it.
//
// A TypeScript or JSX file is checked by a transform, not a type check:
// types are the checks' business, and this gate exists to stop a tree that
// does not parse.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const NODE_CHECKED = new Set(['.js', '.mjs', '.cjs']);
const TRANSFORMED = new Set(['.ts', '.tsx', '.jsx']);
const LOADERS = { '.ts': 'ts', '.tsx': 'tsx', '.jsx': 'jsx' };

let esbuild;
let esbuildTried = false;

// The worker image's esbuild binary (worker/Dockerfile). SYNC_PARSE_ESBUILD_BIN
// names another one, for tests.
const IMAGE_ESBUILD = '/usr/local/bin/esbuild';

// The frontend's pinned esbuild first (its lockfile's version), then the
// worker image's binary. Null means "not available".
function loadEsbuild() {
  if (esbuildTried) return esbuild;
  esbuildTried = true;
  const candidates = [
    path.join(process.cwd(), 'frontend', 'node_modules', 'esbuild'),
    path.join(__dirname, '..', 'frontend', 'node_modules', 'esbuild'),
  ];
  esbuild = null;
  for (const candidate of candidates) {
    try {
      esbuild = require(candidate);
      return esbuild;
    } catch {
      // next
    }
  }
  const bin = process.env.SYNC_PARSE_ESBUILD_BIN || IMAGE_ESBUILD;
  try {
    fs.accessSync(bin, fs.constants.X_OK);
    esbuild = binaryEsbuild(bin);
  } catch {
    // not there
  }
  return esbuild;
}

// esbuild's command line prints a parse error as
//   ✘ [ERROR] Unexpected "*"
//
//       frontend/src/x.tsx:2:0:
//         2 │ *
//           ╵ ^
// with the same text and 0-based column as the module's error.
function cliError(stderr) {
  const out = String(stderr || '');
  const text = (out.match(/\[ERROR\]\s*(.+)/) || [])[1];
  const at = out.match(/^\s*\S.*?:(\d+):(\d+):\s*$/m);
  const error = new Error(text ? text.trim() : 'does not parse');
  error.errors = [{
    text: text ? text.trim() : 'does not parse',
    location: at ? { line: Number(at[1]), column: Number(at[2]) } : null,
  }];
  return error;
}

// The image's esbuild binary in the module's shape: transformSync throws an
// error carrying `errors` when the source does not parse.
function binaryEsbuild(bin) {
  return {
    transformSync(source, { loader, sourcefile }) {
      try {
        execFileSync(bin, [`--loader=${loader}`, `--sourcefile=${sourcefile}`, '--log-level=error', '--color=false'], {
          input: source,
          stdio: ['pipe', 'ignore', 'pipe'],
          maxBuffer: 16 * 1024 * 1024,
        });
      } catch (err) {
        // It ran and refused the source: a parse error. It did not run (gone,
        // not executable, killed): nothing was checked, which is not a failure.
        if (typeof err.status === 'number') throw cliError(err.stderr);
        const unavailable = new Error(`esbuild could not run (${err.code || err.signal || err.message})`);
        unavailable.unavailable = true;
        throw unavailable;
      }
    },
  };
}

function clean(value) {
  return String(value == null ? '' : value).replace(/\r\n/g, '\n').trim();
}

// Node prints:
//   /path/file.js:2
//   const = 1
//         ^
//
//   SyntaxError: Unexpected token '='
// The caret line sits under the offending column.
function nodeCheck(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    return null;
  } catch (err) {
    const out = clean(err.stderr) || clean(err.message);
    const lines = out.split('\n');
    let line = 1;
    let column = 1;
    let message = 'does not parse';
    const at = (lines[0] || '').match(/^(.+):(\d+)$/);
    if (at) line = Number(at[2]);
    const caretIndex = lines.findIndex((l) => /^\s*\^+\s*$/.test(l));
    if (caretIndex >= 0) column = lines[caretIndex].indexOf('^') + 1;
    const said = lines.find((l) => /^[A-Za-z]*Error:/.test(l.trim()));
    if (said) message = said.trim();
    return `${file}:${line}:${column}: ${message}`;
  }
}

function positionOf(source, index) {
  const before = source.slice(0, index);
  const parts = before.split('\n');
  return { line: parts.length, column: parts[parts.length - 1].length + 1 };
}

// The first key a document defines twice, as `{ index, key }`, or null.
// `JSON.parse` keeps the last definition and says nothing about the first,
// so the text is walked instead. Every `{` pushes a frame with its own set of
// keys; `[` pushes a frame that has none; `}` and `]` pop. A string in key
// position (right after `{` or after a `,` in an object) is decoded with
// `JSON.parse`, escapes included, and checked against that frame's set. The
// file has already parsed, so the text is well-formed and an escaped quote is
// skipped by taking the backslash and the character after it together.
function duplicateKey(source) {
  const stack = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === '\\' ? 2 : 1;
      const frame = stack[stack.length - 1];
      if (frame && frame.expectKey) {
        const key = JSON.parse(source.slice(i, j + 1));
        frame.expectKey = false;
        if (frame.keys.has(key)) return { index: i, key };
        frame.keys.add(key);
      }
      i = j + 1;
      continue;
    }
    if (c === '{' || c === '[') {
      stack.push({ keys: c === '{' ? new Set() : null, expectKey: c === '{' });
    } else if (c === '}' || c === ']') {
      stack.pop();
    } else if (c === ',') {
      const frame = stack[stack.length - 1];
      if (frame && frame.keys) frame.expectKey = true;
    }
    i += 1;
  }
  return null;
}

function jsonCheck(file, source) {
  try {
    JSON.parse(source);
  } catch (err) {
    const text = String(err.message || 'does not parse');
    let line = 1;
    let column = 1;
    const at = text.match(/at position (\d+)/);
    if (at) ({ line, column } = positionOf(source, Number(at[1])));
    return `${file}:${line}:${column}: ${text}`;
  }
  const repeated = duplicateKey(source);
  if (repeated) {
    const { line, column } = positionOf(source, repeated.index);
    return `${file}:${line}:${column}: key "${repeated.key}" defined more than once`;
  }
  return null;
}

function transformCheck(file, source) {
  const ext = path.extname(file).toLowerCase();
  const builder = loadEsbuild();
  if (!builder) {
    process.stderr.write(`sync-parse-check: esbuild is not installed; ${file} was not checked\n`);
    return null;
  }
  try {
    builder.transformSync(source, { loader: LOADERS[ext], sourcefile: file });
    return null;
  } catch (err) {
    if (err && err.unavailable) {
      process.stderr.write(`sync-parse-check: ${err.message}; ${file} was not checked\n`);
      return null;
    }
    const first = (err && Array.isArray(err.errors) && err.errors[0]) || {};
    const location = first.location || {};
    const line = Number(location.line) || 1;
    const column = (Number(location.column) || 0) + 1;
    const text = first.text || err.message || 'does not parse';
    return `${file}:${line}:${column}: ${text}`;
  }
}

function checkFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (!NODE_CHECKED.has(ext) && !TRANSFORMED.has(ext) && ext !== '.json') return null;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null; // deleted, or never there
  }
  if (!stat.isFile()) return null;
  if (NODE_CHECKED.has(ext)) return nodeCheck(file);
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return `${file}:1:1: could not be read (${err.message})`;
  }
  if (ext === '.json') return jsonCheck(file, source);
  return transformCheck(file, source);
}

// A path as the merge wrote it, relative to the checkout, with `/` separators
// so the locales prefix matches however the caller spelled it.
function relativeToCwd(file) {
  return path.relative(process.cwd(), path.resolve(process.cwd(), file)).split(path.sep).join('/');
}

// The language catalogs, read the way the shell build reads them, when the
// merge touched them. Only the platform's own repository has the script, so
// another app's sync skips this silently. Each error becomes a
// `frontend/locales/...:1:1:` line, the shape the hand-back names files by.
function catalogFailures(files) {
  if (!files.some((file) => relativeToCwd(file).startsWith('frontend/locales/'))) return [];
  const script = path.join(process.cwd(), 'scripts', 'language-packs.js');
  if (!fs.existsSync(script)) return [];
  let collectCatalogs;
  try {
    ({ collectCatalogs } = require(script));
  } catch (err) {
    return [`frontend/locales:1:1: ${err.message}`];
  }
  try {
    collectCatalogs(process.cwd());
    return [];
  } catch (err) {
    const lines = String(err.message || '').split('\n');
    const list = lines.slice(1).filter((line) => line.trim());
    if (!list.length) return [`frontend/locales:1:1: ${lines[0] || err.message}`];
    return list.map((line) => {
      if (!line.startsWith('en/')) return `frontend/locales:1:1: ${line}`;
      const namespace = line.slice(3).split(/[:/]/)[0].replace(/\.json$/, '');
      return `frontend/locales/en/${namespace}.json:1:1: ${line}`;
    });
  }
}

const files = process.argv.slice(2);
const failures = [];
for (const file of files) {
  const failure = checkFile(file);
  if (failure) failures.push(failure);
}
failures.push(...catalogFailures(files));
if (failures.length) {
  process.stdout.write(`${failures.join('\n')}\n`);
  process.exit(1);
}
