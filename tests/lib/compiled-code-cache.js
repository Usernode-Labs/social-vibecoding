'use strict';

const fs = require('node:fs');

function fingerprint(file) {
  try {
    const s = fs.statSync(file, { bigint: true });
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return 'missing';
    throw err;
  }
}

// Per-process artifacts only. Callers must evaluate the cached factory with
// fresh module state. Bound both count and source bytes; no files on disk and
// no sharing of stores, mocks, exports, or test verdicts between invocations.
function createCompiledCodeCache({ maxEntries = 64, maxBytes = 16 * 1024 * 1024 } = {}) {
  const entries = new Map();
  let bytes = 0;
  function remove(key) {
    const old = entries.get(key);
    if (old) bytes -= old.bytes;
    entries.delete(key);
  }
  return function compiled(key, build, { cache = true } = {}) {
    if (!cache) return build().value;
    const old = entries.get(key);
    if (old && old.inputs.every(([file, stamp]) => fingerprint(file) === stamp)) {
      entries.delete(key);
      entries.set(key, old);
      return old.value;
    }
    remove(key);
    // A thrown build is never cached; a corrected source can load next time.
    const result = build();
    if (result.bytes <= maxBytes && maxEntries > 0) {
      while (entries.size >= maxEntries || bytes + result.bytes > maxBytes) {
        remove(entries.keys().next().value);
      }
      entries.set(key, {
        ...result,
        inputs: [...new Set(result.inputs)].map((file) => [file, fingerprint(file)]),
      });
      bytes += result.bytes;
    }
    return result.value;
  };
}

module.exports = { createCompiledCodeCache };
