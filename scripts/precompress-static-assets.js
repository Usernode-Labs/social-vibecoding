'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const DIRECTORY = '.precompressed';
const artifactDir = (publicDir) => `${publicDir}${DIRECTORY}`;
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function eligibleAsset(url) {
  return url.startsWith('/') && !url.includes('\\') && !url.includes('\0')
    && !url.split('/').some((part) => part.startsWith('.'))
    && /\.(?:js|css)$/i.test(url) && url !== '/sw.js' && url !== '/shell/worker.js';
}

function precompress(publicDir, build = process.env.GIT_SHA || 'dev') {
  const output = artifactDir(publicDir);
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  const manifest = { version: 1, build, assets: {} };
  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const file = path.join(dir, entry.name);
      const url = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(file, url);
      if (!entry.isFile() || !eligibleAsset(url)) continue;
      const bytes = fs.readFileSync(file);
      if (bytes.length < 1024) continue;
      const sourceHash = digest(bytes);
      const variants = {};
      for (const [encoding, encoded] of [
        ['br', zlib.brotliCompressSync(bytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })],
        ['gzip', zlib.gzipSync(bytes)],
      ]) {
        if (encoded.length >= bytes.length) continue;
        const hash = digest(encoded);
        fs.writeFileSync(path.join(output, `${hash}.${encoding}`), encoded);
        variants[encoding] = hash;
      }
      if (Object.keys(variants).length) manifest.assets[url] = { sourceHash, variants };
    }
  }
  walk(publicDir);
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}

if (require.main === module) {
  const manifest = precompress(path.join(__dirname, '..', 'public'));
  console.log(`[precompress] generated Brotli/gzip for ${Object.keys(manifest.assets).length} static assets`);
}

module.exports = { precompress, eligibleAsset, DIRECTORY, artifactDir, digest };
