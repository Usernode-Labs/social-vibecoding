'use strict';

// Resolve previously published worker/capture images by their complete tracked
// build inputs, not by the preceding commit or an expiring Actions artifact.
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const WORKFLOW = '.github/workflows/build-kubernetes-images.yml';
const RESOLVER = 'scripts/resolve-kubernetes-image.js';
const DIGEST = /^sha256:[a-f0-9]{64}$/;

function command(file, args, cwd) {
  return execFileSync(file, args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
  }).trim();
}

function inputKey({ component, revision, ref }, { cwd, run = command } = {}) {
  // The Git tree includes names, contents, executable modes, Dockerfiles and
  // .dockerignore. Workflow/resolver changes also invalidate the build recipe.
  // Keep candidate branches separate from main, even for identical inputs.
  const objects = [component, WORKFLOW, RESOLVER].map(path =>
    run('git', ['rev-parse', `${revision}:${path}`], cwd));
  return createHash('sha256').update(JSON.stringify({
    component, ref, platform: 'linux/amd64', objects,
  })).digest('hex');
}

function resolveImage({ component, owner, revision, ref, forceRebuild = 'none' }, dependencies = {}) {
  if (!['platform', 'worker', 'capture'].includes(component)) throw new Error('Invalid component');
  if (!/^[a-f0-9]{40}$/.test(revision || '')) throw new Error('Invalid source revision');
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(owner || '')) throw new Error('Invalid registry owner');
  if (!ref?.startsWith('refs/heads/')) throw new Error('Image releases require a branch ref');
  if (!['none', 'worker', 'capture', 'all'].includes(forceRebuild)) throw new Error('Invalid force_rebuild selection');

  const image = `ghcr.io/${owner.toLowerCase()}/social-vibecoding-${component}`;
  const refresh = forceRebuild === 'all' || forceRebuild === component;
  const result = { image, reuse_tag: '', digest: '', refresh: String(refresh), reason: 'platform-build' };
  // Platform source identity and generated assets remain tied to this release.
  if (component === 'platform') return result;

  result.reuse_tag = `${image}:inputs-${inputKey({ component, revision, ref }, dependencies)}`;
  if (refresh) return { ...result, reason: 'forced-refresh' };

  const { cwd, run = command } = dependencies;
  let output;
  try {
    output = run('docker', ['buildx', 'imagetools', 'inspect', result.reuse_tag,
      '--format', '{{json .Manifest}}'], cwd);
  } catch (error) {
    // Missing/removed registry artifacts rebuild normally. Authentication,
    // network and rate-limit errors fail rather than masquerading as a miss.
    if (/manifest unknown|not found|\b404\b/i.test(String(error.stderr || ''))) {
      return { ...result, reason: 'image-not-found' };
    }
    throw error;
  }
  const manifest = JSON.parse(output);
  if (!DIGEST.test(manifest.digest || '') || !manifest.manifests?.some(entry =>
    entry.platform?.os === 'linux' && entry.platform?.architecture === 'amd64')) {
    throw new Error('Reusable image must have a valid index digest and a linux/amd64 manifest');
  }
  return { ...result, digest: manifest.digest, reason: 'matching-build-inputs' };
}

if (require.main === module) {
  try {
    const result = resolveImage({
      component: process.env.COMPONENT,
      owner: process.env.GITHUB_REPOSITORY_OWNER,
      revision: process.env.GITHUB_SHA,
      ref: process.env.GITHUB_REF,
      forceRebuild: process.env.FORCE_REBUILD || 'none',
    });
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(''));
    console.log(`${process.env.COMPONENT}: ${result.reason}${result.digest ? ` (${result.digest})` : ''}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { inputKey, resolveImage };
