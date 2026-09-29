#!/usr/bin/env node
'use strict';

// Run after BOTH shell and CSS builds. These artifacts are image outputs,
// never source: a UI-only change must change /sw.js without a manual bump.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readBuildMeta, normalizeBuildSha } = require('./shell-stamp');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function buildShellRelease(root, { revision = process.env.GIT_SHA } = {}) {
  const publicDir = path.join(root, 'public');
  const document = fs.readFileSync(path.join(publicDir, 'index.html'));
  const sourceRevision = normalizeBuildSha(revision);
  if (readBuildMeta(document.toString()) !== sourceRevision) {
    throw new Error('Shell document and release revision disagree; rebuild the shell first');
  }
  const workerPath = path.join(publicDir, 'sw.js');
  // The source worker's exports do not execute browser code.
  delete require.cache[require.resolve(workerPath)];
  const { SHELL_ASSETS } = require(workerPath);
  const paths = new Set(SHELL_ASSETS);
  // Lazy route chunks participate in identity and verification, but not the
  // precache download. Adding a chunk requires no hand-maintained list.
  const chunks = path.join(publicDir, 'shell', 'assets');
  for (const name of fs.readdirSync(chunks)) {
    if (/\.(?:js|css)$/.test(name)) paths.add(`/shell/assets/${name}`);
  }
  const assets = [...paths].sort().map(url => ({
    path: url,
    hash: digest(fs.readFileSync(path.join(publicDir, url))),
    precache: SHELL_ASSETS.includes(url),
  }));
  const manifest = {
    version: 1,
    revision: sourceRevision,
    id: digest(JSON.stringify(assets)),
    assets,
  };
  const outputDir = path.join(publicDir, 'shell');
  fs.mkdirSync(outputDir, { recursive: true });
  const helper = fs.readFileSync(path.join(publicDir, 'sw-release.js'), 'utf8');
  const worker = fs.readFileSync(workerPath, 'utf8');
  const generated = `self.__USERNODE_SHELL_RELEASE__ = ${JSON.stringify(manifest)};\n${helper}\n${worker}`;
  // The worker script also changes when its implementation changes, while
  // unchanged assets keep their hashes and can be reused across releases.
  fs.writeFileSync(path.join(outputDir, 'release.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(outputDir, 'worker.js'), generated);
  return manifest;
}

if (require.main === module) {
  const release = buildShellRelease(path.join(__dirname, '..'));
  console.log(`[shell-release] ${release.revision}: ${release.assets.length} assets, ${release.id.slice(0, 12)}`);
}
module.exports = { buildShellRelease, digest };
