'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// A seed run against the pair's OTHER copy (src/db/seed-other-copy.js) must
// not write a file into this process's own media directory: that copy could
// not serve it. While `useOtherCopy` is set, a file counts as present only
// when the other database already held its media_objects row, read on a
// second connection so the seed's own uncommitted insert does not count.
// A file the other copy never had throws, and its seed is left out.
let otherCopy = null;

class StagingMediaNotShared extends Error {
  constructor(key) {
    super(`The other copy does not hold ${key}, so this seed cannot be written there.`);
    this.name = 'StagingMediaNotShared';
    this.code = 'staging_media_not_shared';
  }
}

function useOtherCopy(queryable) { otherCopy = queryable; }
function clearOtherCopy() { otherCopy = null; }

// Platform previews have no production bucket credentials. Their fake boot
// fixtures are rebuilt on every boot, including after container replacement.
// Keep these small files with that preview, never in the production bucket.
// This is not a store for production captures or a database-byte fallback.
function createStagingMediaStore({ directory = path.join(os.tmpdir(), 'homeroom-staging-media') } = {}) {
  const fileOf = (key) => {
    const match = /^media\/sha256\/([a-f0-9]{64})$/.exec(key);
    if (!match) throw new TypeError('Invalid media object key');
    return path.join(directory, match[1]);
  };
  return {
    async statObject(key) {
      if (otherCopy) {
        let rows;
        try {
          ({ rows } = await otherCopy.query(
            'SELECT 1 FROM media_objects WHERE object_key = $1 LIMIT 1', [key]));
        } catch (err) {
          // An old clone without the registry has no file to serve either.
          if (err.code === '42P01') return null;
          throw err;
        }
        // `sizeKnown: false`: media-store.put compares a size to the bytes it
        // has, and this row records no size. The key is the content hash, so
        // a row that exists already refers to exactly these bytes.
        return rows.length ? { size: null, sizeKnown: false, lastModified: null } : null;
      }
      try {
        const stat = await fsp.stat(fileOf(key));
        return { size: stat.size, lastModified: stat.mtime };
      } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
    },
    async putObject(key, data) {
      if (otherCopy) throw new StagingMediaNotShared(key);
      const file = fileOf(key);
      await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = file + '.' + randomUUID();
      try {
        await fsp.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
        await fsp.rename(temporary, file);
      } finally { await fsp.rm(temporary, { force: true }); }
    },
    async getObjectStream(key, range = null) {
      return fs.createReadStream(fileOf(key), range ? { start: range.start, end: range.end } : {});
    },
  };
}

module.exports = {
  createStagingMediaStore,
  StagingMediaNotShared,
  useOtherCopy,
  clearOtherCopy,
};
