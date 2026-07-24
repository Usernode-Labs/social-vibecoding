'use strict';

const crypto = require('crypto');
const log = require('./logger');

// Production-deploy plumbing for app file storage (#752): the two env
// vars an app container needs to reach the platform's app-storage API,
// plus lazy generation of the per-app credential. Exact sibling of
// app-llm-env.js.
//
//   USERNODE_STORAGE_URL    — in-network base URL of the storage API
//                             (http://usernode:3000/api/app-storage).
//                             Points at the PLATFORM, never at MinIO —
//                             app containers can't reach the object
//                             store at all (it lives on the internal
//                             usernode-storage network).
//   USERNODE_STORAGE_TOKEN  — apps.storage_api_token, random 64-hex,
//                             generated at first production deploy
//                             (same adoption shape as llm_proxy_token).
//
// STAGING DEPLOYS INJECT NEITHER — the exact `private: true` secret
// precedent: unreviewed PR code must not write durable prod storage.
// Staging previews still exercise uploads through the bridge relay
// (shell-side, staging-stamped and GC'd); server-side callers detect
// the absent env vars and degrade (see app-conventions.md "App file
// storage").

// Same default as PLATFORM_INTERNAL_URL in services/worker.js — the
// platform's in-network hostname on the shared docker network.
function storageBaseUrl() {
  const base = process.env.PLATFORM_INTERNAL_URL || 'http://usernode:3000';
  return `${base.replace(/\/$/, '')}/api/app-storage`;
}

// Get-or-create apps.storage_api_token. The WHERE ... IS NULL guard +
// re-read makes concurrent first-deploys converge on one token instead
// of clobbering each other.
async function ensureStorageApiToken(pool, appId) {
  const { rows } = await pool.query(
    'SELECT storage_api_token FROM apps WHERE id = $1', [appId]
  );
  let token = rows[0]?.storage_api_token || null;
  if (!token) {
    const fresh = crypto.randomBytes(32).toString('hex');
    await pool.query(
      'UPDATE apps SET storage_api_token = $1 WHERE id = $2 AND storage_api_token IS NULL',
      [fresh, appId]
    );
    const { rows: rows2 } = await pool.query(
      'SELECT storage_api_token FROM apps WHERE id = $1', [appId]
    );
    token = rows2[0]?.storage_api_token || fresh;
    log.info('app-storage-env', 'Generated storage_api_token', { appId });
  }
  return token;
}

// Env-var pair for a PRODUCTION container. Best-effort: a DB hiccup
// here must not fail the deploy that called it — the app just comes up
// without storage access until the next rebuild.
async function productionStorageEnv(pool, appId) {
  try {
    const token = await ensureStorageApiToken(pool, appId);
    return {
      USERNODE_STORAGE_URL: storageBaseUrl(),
      USERNODE_STORAGE_TOKEN: token,
    };
  } catch (err) {
    log.warn('app-storage-env', 'Failed to resolve storage env; deploying without', {
      appId, err: err.message,
    });
    return {};
  }
}

module.exports = { storageBaseUrl, ensureStorageApiToken, productionStorageEnv };
