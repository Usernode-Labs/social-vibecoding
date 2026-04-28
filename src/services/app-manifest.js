'use strict';

/**
 * Reader for `social-vibecoding.json` — the per-dapp manifest declaring
 * which env vars the dapp needs at runtime.
 *
 * Lives in the dapp repo root, alongside Dockerfile and package.json. The
 * platform reads it from the freshly-cloned working tree on every deploy
 * (createApp / buildAndDeployStaging / rebuildProduction) so the manifest
 * is always the current code's source of truth. It is NEVER snapshotted
 * into the platform DB — staleness is a guaranteed pain we don't want.
 *
 * Shape:
 *   {
 *     "secrets": [
 *       {
 *         "key": "ECHO_APP_SECRET_KEY",       // env var name
 *         "description": "...",               // human help text for UI
 *         "required": true,                   // deploy blocks if unset
 *         "sensitive": true,                  // never returned by API
 *         "default": "..."                    // applied if no stored value
 *       },
 *       ...
 *     ]
 *   }
 *
 * Missing file or unparseable JSON is treated as `{ secrets: [] }` — i.e.
 * exactly the legacy behavior. The platform never refuses to deploy on
 * an absent manifest; only on declared-required-but-unset values.
 */

const fs = require('fs');
const path = require('path');
const log = require('./logger');

const MANIFEST_FILENAME = 'social-vibecoding.json';

// Reserved keys the platform owns. A manifest entry using one of these
// is rejected on read so a dapp can't shadow / spoof the platform-injected
// values that all dapps depend on.
const RESERVED_KEYS = new Set([
  'DATABASE_URL',
  'JWT_SECRET',
  'PORT',
  'USERNODE_ENV',
  'USERNODE_MISSING_SECRETS',
]);

const KEY_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

function read(cloneDir) {
  const filePath = path.join(cloneDir, MANIFEST_FILENAME);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return { secrets: [] };
    log.warn('app-manifest', 'Read failed (treating as empty)', { filePath, err: err.message });
    return { secrets: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn('app-manifest', 'Parse failed (treating as empty)', { filePath, err: err.message });
    return { secrets: [] };
  }

  const secretsIn = Array.isArray(parsed?.secrets) ? parsed.secrets : [];
  const seen = new Set();
  const secrets = [];

  for (const s of secretsIn) {
    if (!s || typeof s !== 'object') continue;
    const key = typeof s.key === 'string' ? s.key.trim() : '';
    if (!KEY_RE.test(key)) {
      log.warn('app-manifest', 'Skipping invalid key', { filePath, key: s.key });
      continue;
    }
    if (RESERVED_KEYS.has(key)) {
      log.warn('app-manifest', 'Skipping reserved key', { filePath, key });
      continue;
    }
    if (seen.has(key)) {
      log.warn('app-manifest', 'Skipping duplicate key', { filePath, key });
      continue;
    }
    seen.add(key);
    secrets.push({
      key,
      description: typeof s.description === 'string' ? s.description : '',
      required: !!s.required,
      sensitive: !!s.sensitive,
      default: typeof s.default === 'string' ? s.default : null,
    });
  }

  return { secrets };
}

module.exports = { read, RESERVED_KEYS, KEY_RE, MANIFEST_FILENAME };
