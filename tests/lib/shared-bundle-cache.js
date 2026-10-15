'use strict';

// Compiled bundles, shared between test processes.
//
// `node --test` runs every suite in its own process, so the per-process cache
// in compiled-code-cache.js cannot help the second suite that needs a bundle
// the first one already built. What each of those processes pays is not the
// bundling (a few milliseconds once esbuild is up) but starting esbuild at
// all: a median 65 ms for the first call, in 400 of the suite's 1,592
// processes when this was written. A process that finds every bundle it
// needs here never starts it.
//
// Only compiled TEXT is stored. The caller still evaluates it into a fresh
// module on every load, so no module state, export, mock or verdict crosses
// from one process to another.
//
// An entry is trusted only while everything it was built from is unchanged,
// judged by content and never by timestamps: a file by its bytes, a directory
// by the names in it (a new file can change how an import resolves without
// touching an existing input), and a path with nothing at it as `missing` (so
// a tsconfig.json that appears later counts). A cache that outlives the
// process that wrote it cannot lean on mtimes the way the per-process one
// does: a checkout, a restore or a coarse clock can each leave them unchanged
// over different bytes.
//
// Everything here is best-effort. An entry that cannot be read is a miss, a
// directory that cannot be written means every process builds for itself as
// before, and a build that throws stores nothing.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Bump when the layout of an entry changes: older entries then stop matching.
const FORMAT = 1;

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// What `file` holds right now, as a string that differs whenever a bundle
// built from it could.
function contentStamp(file) {
  try {
    return `file:${sha256(fs.readFileSync(file))}`;
  } catch (err) {
    if (err.code === 'EISDIR') return `dir:${sha256(fs.readdirSync(file).sort().join('\0'))}`;
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return 'missing';
    throw err;
  }
}

// `shared(key, build)` returns `{ code, inputs }`: from the entry stored under
// `key` when every input still matches, otherwise from `build()`, whose result
// is stored for the next process. `build` returns `{ code, inputs }` with
// `inputs` the paths the code was built from.
function createSharedBundleCache({ dir, enabled = true } = {}) {
  const active = enabled && typeof dir === 'string' && dir.length > 0;

  function read(file) {
    try {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!entry || entry.format !== FORMAT || typeof entry.code !== 'string' || !Array.isArray(entry.inputs)) {
        return null;
      }
      for (const input of entry.inputs) {
        // A path must be a string: fs would read a number as a file descriptor.
        if (!Array.isArray(input) || typeof input[0] !== 'string' || contentStamp(input[0]) !== input[1]) return null;
      }
      return { code: entry.code, inputs: entry.inputs.map(([input]) => input) };
    } catch {
      // Absent, half-written by a version without the rename, or damaged: the
      // next store replaces it.
      return null;
    }
  }

  function write(file, built) {
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      const inputs = built.inputs.map((input) => [input, contentStamp(input)]);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({ format: FORMAT, code: built.code, inputs }));
      // A rename is atomic: another process reads the whole entry or none of
      // it. Two processes that built the same bundle at once write the same
      // text, and the later rename wins.
      fs.renameSync(temporary, file);
    } catch {
      try { fs.unlinkSync(temporary); } catch { /* it was never written */ }
    }
  }

  return function shared(key, build) {
    if (!active) return build();
    const file = path.join(dir, `${sha256(key)}.json`);
    const stored = read(file);
    if (stored) return stored;
    // A thrown build leaves the function here, before anything is stored.
    const built = build();
    write(file, built);
    return { code: built.code, inputs: built.inputs };
  };
}

module.exports = { createSharedBundleCache, contentStamp };
