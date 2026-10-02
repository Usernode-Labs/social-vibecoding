#!/usr/bin/env node
'use strict';

// Offline historical replay only. This module is not a live worker dependency.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

function checksum(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function openArchive(directory = __dirname) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  for (const [name, expected] of Object.entries(manifest.artifacts)) {
    if (checksum(fs.readFileSync(path.join(directory, name))) !== expected) {
      throw new Error(`Archive checksum mismatch: ${name}`);
    }
  }

  const sources = JSON.parse(gunzipSync(fs.readFileSync(path.join(directory, 'sources.json.gz'))));
  for (const [name, source] of Object.entries(sources)) {
    if (checksum(Buffer.from(source, 'base64')) !== manifest.sources[name]) {
      throw new Error(`Source checksum mismatch: ${name}`);
    }
  }

  const cache = new Map();
  const builtins = new Set(['node:crypto', 'node:util', 'crypto']);
  const context = vm.createContext({ Buffer, console: Object.freeze({ log() {} }) });

  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    if (!sources[filename]) throw new Error(`Dependency not archived: ${filename}`);
    const module = { exports: {} };
    cache.set(filename, module);

    function archivedRequire(request) {
      if (builtins.has(request)) return require(request);
      if (request === 'zod') return load('node_modules/zod/index.cjs');
      if (!request.startsWith('.')) throw new Error(`External dependency unavailable: ${request}`);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(filename), request));
      const target = [resolved, `${resolved}.js`, `${resolved}.cjs`, `${resolved}/index.js`]
        .find(name => Object.hasOwn(sources, name));
      if (!target) throw new Error(`Dependency not archived: ${resolved}`);
      return load(target);
    }

    const source = Buffer.from(sources[filename], 'base64').toString('utf8');
    const compile = new vm.Script(`(function(require, module, exports) {\n${source}\n})`, { filename });
    compile.runInContext(context)(archivedRequire, module, module.exports);
    return module.exports;
  }

  function replay(machine, entry) {
    const supported = manifest.versions[machine];
    if (!supported?.includes(entry.reducer_version)) throw new Error('Version not present in historical archive');
    const reducer = load(manifest.reducers[machine][entry.reducer_version]);
    // Serialize across the VM boundary, just as persisted JSON traces do.
    return JSON.parse(JSON.stringify(reducer.reduce(entry.pre_state, entry.action, entry.facts || {})));
  }

  function verify() {
    const cases = fs.readFileSync(path.join(directory, 'goldens.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const totals = {};
    for (const record of cases) {
      const result = replay(record.machine, record.entry);
      if (!isDeepStrictEqual(result, record.decision)) {
        throw new Error(`Golden replay mismatch: ${record.machine} v${record.entry.reducer_version} (${record.source})`);
      }
      totals[record.kind] = (totals[record.kind] || 0) + 1;
    }
    for (const [machine, versions] of Object.entries(manifest.versions)) {
      for (const version of versions) {
        if (!cases.some(record => record.machine === machine && record.entry.reducer_version === version)) {
          throw new Error(`Missing historical witness: ${machine} v${version}`);
        }
      }
    }
    return { producingRevision: manifest.producingRevision, cases: cases.length, totals };
  }

  return { replay, verify, manifest };
}

if (require.main === module) {
  try {
    const archive = openArchive();
    if (process.argv[2] === '--verify') console.log(JSON.stringify(archive.verify()));
    else {
      const machine = process.argv[2];
      if (!machine) throw new Error('Use --verify or <machine>; supply JSONL traces on stdin');
      for (const line of fs.readFileSync(0, 'utf8').split('\n').filter(Boolean)) {
        console.log(JSON.stringify(archive.replay(machine, JSON.parse(line))));
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { openArchive };
