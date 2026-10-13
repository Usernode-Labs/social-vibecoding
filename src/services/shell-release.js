'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeBuildSha, readBuildMeta } = require('../../scripts/shell-stamp');

// Read once at startup. No hashing or filesystem scans on browser requests.
function loadShellRelease(publicDir, env = process.env) {
  const file = path.join(publicDir, 'shell', 'release.json');
  if (!fs.existsSync(file)) {
    if (env.NODE_ENV === 'production') throw new Error('Missing generated shell release; rebuild the image');
    return null;
  }
  const release = JSON.parse(fs.readFileSync(file, 'utf8'));
  const workerFile = path.join(publicDir, 'shell', 'worker.js');
  const expected = normalizeBuildSha(env.GIT_SHA);
  const document = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  if (release.version !== 1 || !/^[a-f0-9]{64}$/.test(release.id)
      || readBuildMeta(document) !== release.revision
      || (expected !== 'dev' && expected !== release.revision)
      || !fs.existsSync(workerFile)
      || !fs.readFileSync(workerFile, 'utf8').startsWith(`self.__USERNODE_SHELL_RELEASE__ = ${JSON.stringify(release)};\n`)) {
    throw new Error('Inconsistent shell release artifacts; rebuild the image');
  }
  if (env.NODE_ENV === 'production' && release.revision === 'dev') {
    throw new Error('Hosted shell requires an exact build revision');
  }
  return release;
}

module.exports = { loadShellRelease };
