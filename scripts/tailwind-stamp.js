// Shared stamp logic for the shell's compiled Tailwind stylesheet.
//
// The compiled CSS is a COMMITTED artifact (the runtime image is built with
// `npm ci --production`, so tailwindcss isn't there to compile at deploy
// time, and neither the deploy workflow nor a worker checkout runs a build
// step). A committed artifact is only safe if staleness is detectable, so
// scripts/build-tailwind.js writes a stamp comment into the first line of
// public/css/tailwind.css: a sha256 over every input that can change the
// output. tests/tailwind-build.test.js recomputes it and fails when the
// committed CSS no longer matches the sources.
//
// Both sides MUST agree byte-for-byte, hence this shared module. The test
// deliberately requires nothing from node_modules (tailwindcss itself is
// not needed to verify freshness) — this file only uses node builtins.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = 'tailwind.config.js';
const INPUT_FILE = 'styles/tailwind-input.css';
const OUTPUT_FILE = 'public/css/tailwind.css';
const STAMP_PREFIX = '/*! tailwind-build stamp: ';
const STAMP_SUFFIX = ' */';

// Directories never worth walking when resolving a content glob.
const SKIP_DIRS = new Set(['node_modules', '.git']);

// Minimal glob → RegExp for the shapes tailwind.config.js actually uses:
// a literal path, or `**` / `*` segments (e.g. './public/js/**/*.js').
function globToRegExp(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` spans zero or more directories; a trailing `**` spans the rest.
        if (glob[i + 2] === '/') { out += '(?:[^/]+/)*'; i += 2; } else { out += '.*'; i += 1; }
      } else {
        out += '[^/]*';
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`${out}$`);
}

// The static leading directory of a glob — where the walk can start.
function globBase(glob) {
  const parts = glob.split('/');
  const base = [];
  for (const part of parts) {
    if (part.includes('*')) break;
    base.push(part);
  }
  // Drop a trailing filename component (a literal glob with no wildcard).
  const candidate = base.join('/');
  if (candidate && !glob.includes('*')) return path.posix.dirname(candidate) || '.';
  return candidate || '.';
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const rel = dir === '.' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else if (entry.isFile()) out.push(rel);
  }
}

// Every file the compiled CSS depends on, as repo-relative POSIX paths,
// sorted and de-duplicated. Content globs are resolved against the working
// tree, so a NEW file under public/js/ changes the stamp too (a new script
// almost always brings new classes with it).
function resolveInputs(contentGlobs) {
  const files = new Set([CONFIG_FILE, INPUT_FILE]);
  for (const raw of contentGlobs) {
    const glob = String(raw).replace(/^\.\//, '');
    if (!glob.includes('*')) {
      if (fs.existsSync(path.join(ROOT, glob))) files.add(glob);
      continue;
    }
    const re = globToRegExp(glob);
    const found = [];
    walk(globBase(glob), found);
    for (const rel of found) if (re.test(rel)) files.add(rel);
  }
  return [...files].sort();
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

// Recompute the stamp from the current working tree.
function expectedStamp() {
  // Read the config through require() so the globs stay single-sourced.
  const config = require(path.join(ROOT, CONFIG_FILE));
  const files = resolveInputs(config.content || []);
  return { stamp: computeStamp(files), files };
}

// Pull the stamp out of a built stylesheet; null when absent/unrecognised.
function readStamp(css) {
  const firstLine = String(css).split('\n', 1)[0];
  if (!firstLine.startsWith(STAMP_PREFIX) || !firstLine.endsWith(STAMP_SUFFIX)) return null;
  return firstLine.slice(STAMP_PREFIX.length, -STAMP_SUFFIX.length).trim() || null;
}

function formatStamp(stamp) {
  return `${STAMP_PREFIX}${stamp}${STAMP_SUFFIX}`;
}

module.exports = {
  ROOT,
  CONFIG_FILE,
  INPUT_FILE,
  OUTPUT_FILE,
  STAMP_PREFIX,
  computeStamp,
  expectedStamp,
  formatStamp,
  globToRegExp,
  readStamp,
  resolveInputs,
};
