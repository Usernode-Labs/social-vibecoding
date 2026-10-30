'use strict';

const { Readable } = require('node:stream');

// Injectable media store for tests. No application singleton and no S3 key.
function memoryMediaStore({ now = () => Date.now() } = {}) {
  const files = new Map();
  const calls = [];
  return {
    files, calls,
    async putObject(key, data, contentType) {
      calls.push({ op: 'put', key });
      files.set(key, { data: Buffer.from(data), contentType, lastModified: new Date(now()) });
    },
    async statObject(key) {
      calls.push({ op: 'stat', key });
      const file = files.get(key);
      return file ? { size: file.data.length, lastModified: file.lastModified } : null;
    },
    async getObjectStream(key, range = null) {
      calls.push({ op: 'get', key, range });
      const file = files.get(key);
      if (!file) throw Object.assign(new Error('Object not found'), { code: 'NoSuchKey' });
      return Readable.from([range ? file.data.subarray(range.start, range.end + 1) : file.data]);
    },
    async removeObject(key) {
      calls.push({ op: 'remove', key });
      files.delete(key);
    },
    async *objects(prefix, after = '') {
      calls.push({ op: 'list', prefix, after });
      for (const [name, file] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
        if (name.startsWith(prefix) && name > after) yield { name, lastModified: file.lastModified, size: file.data.length };
      }
    },
  };
}

function useMemoryMedia(context, options) {
  const store = memoryMediaStore(options);
  context.mock.method(require('../../src/services/media-store'), 'getStore', () => store);
  return store;
}

module.exports = { memoryMediaStore, useMemoryMedia };
