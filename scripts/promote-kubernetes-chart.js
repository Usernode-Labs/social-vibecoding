'use strict';

const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const HELM_CONFIG = 'application/vnd.cncf.helm.config.v1+json';
const HELM_LAYER = 'application/vnd.cncf.helm.chart.content.v1.tar+gzip';
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const VERSION = /^0\.1\.(0|[1-9][0-9]*)$/;
const TARGET = 'release';

function patchVersion(version) {
  const match = VERSION.exec(version);
  if (!match) throw new Error('Invalid stable Helm chart version');
  return BigInt(match[1]);
}

function digestOf(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function registryError(operation, status) {
  return Object.assign(new Error(`${operation} failed (HTTP ${status})`), {
    retryable: status === 429 || status >= 500,
  });
}

async function ghcrRequest(path, options = {}) {
  try {
    return await fetch(`https://ghcr.io${path}`, { ...options, signal: AbortSignal.timeout(12_000) });
  } catch {
    throw Object.assign(new Error('Could not reach GHCR'), { retryable: true });
  }
}

async function connectRegistry(repository, username, password) {
  const permissions = username && password ? 'pull,push' : 'pull';
  const query = new URLSearchParams({ service: 'ghcr.io', scope: `repository:${repository}:${permissions}` });
  const headers = {};
  if (permissions === 'pull,push') headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const response = await ghcrRequest(`/token?${query}`, { headers, redirect: 'error' });
  if (!response.ok) throw registryError('GHCR authentication', response.status);
  const { token } = await response.json();
  if (typeof token !== 'string' || !token) throw new Error('GHCR did not return a bearer token');
  const registryHeaders = { Authorization: `Bearer ${token}`, 'Cache-Control': 'no-cache' };
  return {
    async manifest(reference) {
      const response = await ghcrRequest(`/v2/${repository}/manifests/${reference}`, {
        headers: { ...registryHeaders, Accept: MANIFEST }, redirect: 'error',
      });
      if (response.status === 404) {
        const body = await response.json();
        if (body.errors?.length && body.errors.every(error => error.code === 'MANIFEST_UNKNOWN')) return null;
      }
      if (!response.ok) throw registryError('Chart manifest lookup', response.status);
      const bytes = Buffer.from(await response.arrayBuffer());
      const digest = digestOf(bytes);
      if (response.headers.get('docker-content-digest') !== digest) throw new Error('GHCR chart manifest digest mismatch');
      const doc = JSON.parse(bytes);
      if (doc.schemaVersion !== 2 || doc.config?.mediaType !== HELM_CONFIG || !DIGEST.test(doc.config.digest)
          || !doc.layers?.some(layer => layer.mediaType === HELM_LAYER)) throw new Error('GHCR manifest is not a Helm chart');
      const version = doc.annotations?.['org.opencontainers.image.version'];
      patchVersion(version);
      return { bytes, digest, version, configDigest: doc.config.digest };
    },
    async config(digest) {
      const response = await ghcrRequest(`/v2/${repository}/blobs/${digest}`, { headers: registryHeaders });
      if (!response.ok) throw registryError('Chart config lookup', response.status);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (digestOf(bytes) !== digest) throw new Error('GHCR chart config digest mismatch');
      return JSON.parse(bytes);
    },
    async putRelease(bytes) {
      const response = await ghcrRequest(`/v2/${repository}/manifests/${TARGET}`, {
        method: 'PUT', headers: { ...registryHeaders, 'Content-Type': MANIFEST }, body: bytes, redirect: 'error',
      });
      if (!response.ok) throw registryError('OCI release tag update', response.status);
    },
  };
}

async function promoteChart({ version, revision, registry, newestVersion }) {
  const patch = patchVersion(version);
  const [candidate, active] = await Promise.all([registry.manifest(version), registry.manifest(TARGET)]);
  if (!candidate) throw Object.assign(new Error('Published chart is not yet visible in GHCR'), { retryable: true });
  if (candidate.version !== version) throw new Error('Published chart version does not match its tag');

  // Only the serialized release job writes this tag. A rerun can still be
  // older than the current release, even when its source is the branch tip.
  if (active) {
    if (patchVersion(active.version) > patch) return { version: active.version, digest: active.digest, updated: false };
    if (active.version === version && active.digest !== candidate.digest) {
      throw new Error('The release tag already has this version with a different digest');
    }
  } else if (patchVersion(await newestVersion()) > patch) {
    throw new Error('Cannot initialize the release tag from an older chart');
  }

  const config = await registry.config(candidate.configDigest);
  if (config.name !== 'social-vibecoding-platform' || config.version !== version || config.appVersion !== revision) {
    throw new Error('Published chart config does not match this release');
  }
  if (active?.digest === candidate.digest) return { version, digest: candidate.digest, updated: false };
  await registry.putRelease(candidate.bytes);
  const published = await registry.manifest(TARGET);
  if (published?.digest !== candidate.digest) {
    throw Object.assign(new Error('The release tag does not yet resolve to the published chart digest'), { retryable: true });
  }
  return { version, digest: published.digest, updated: true };
}

async function main(env) {
  const { REGISTRY_OWNER: owner, CHART_VERSION: version, GITHUB_SHA: revision, GHCR_USER: username, GHCR_TOKEN: password } = env;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(owner || '') || !/^[a-f0-9]{40}$/.test(revision || '') || !username || !password) {
    throw new Error('Invalid GHCR chart promotion environment');
  }
  const repository = `${owner}/charts/social-vibecoding-platform`;
  const newestVersion = () => {
    const metadata = execFileSync('helm', ['show', 'chart', `oci://ghcr.io/${repository}`, '--version', '0.1.*'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
    });
    return /^version: (\S+)$/m.exec(metadata)?.[1];
  };
  for (let attempt = 1; ; attempt += 1) {
    try {
      const registry = await connectRegistry(repository, username, password);
      const result = await promoteChart({ version, revision, registry, newestVersion });
      console.log(`OCI release tag ${result.updated ? 'advanced to' : 'already tracks'} ${result.version} (${result.digest})`);
      return;
    } catch (error) {
      if (!error.retryable || attempt === 3) throw error;
      console.warn(`OCI release tag update will retry after ${error.message}`);
      await delay(attempt * 1000);
    }
  }
}

if (require.main === module) {
  main(process.env).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { connectRegistry, promoteChart };
