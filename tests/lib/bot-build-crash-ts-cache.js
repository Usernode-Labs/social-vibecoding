'use strict';

// The type-stripped source of the platform's TypeScript modules, kept on disk
// for the crash suite's workflow children (tests/lib/bot-build-crash-child.js
// says why). A module's stripped source is stored under a key of its URL and
// its content, so a changed file is stripped again; a file being written by
// another child is written beside it and renamed into place, so a reader
// never sees half of one. Anything this cannot do (no load hooks in this
// Node, an unreadable file) is left to Node's own loader.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { fileURLToPath } = require('node:url');

function register(dir) {
  if (typeof Module.registerHooks !== 'function' || typeof Module.stripTypeScriptTypes !== 'function') return false;
  fs.mkdirSync(dir, { recursive: true });
  Module.registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith('file:') || !url.endsWith('.ts')) return nextLoad(url, context);
      let source;
      try {
        source = fs.readFileSync(fileURLToPath(url), 'utf8');
      } catch {
        return nextLoad(url, context);
      }
      // Only what Node itself would load as an ES module written in
      // TypeScript; anything else keeps Node's own handling.
      const loaded = { format: null };
      const file = path.join(dir, `${crypto.createHash('sha256').update(`${url}\0${source}`).digest('hex')}.mjs`);
      let stripped = null;
      try {
        stripped = fs.readFileSync(file, 'utf8');
      } catch {
        const own = nextLoad(url, context);
        loaded.format = own.format;
        if (own.format !== 'module-typescript') return own;
        stripped = Module.stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: url });
        const tmp = `${file}.${process.pid}.tmp`;
        try {
          fs.writeFileSync(tmp, stripped);
          fs.renameSync(tmp, file);
        } catch { /* kept for this process only */ }
      }
      return { format: 'module', source: stripped, shortCircuit: true };
    },
  });
  return true;
}

module.exports = { register };
