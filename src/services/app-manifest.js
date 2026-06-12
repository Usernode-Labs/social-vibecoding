'use strict';

/**
 * Reader for `dapp.json` — the per-dapp manifest declaring which env
 * vars the dapp needs at runtime.
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
 *         "private": true,                    // encrypted at rest, never
 *                                             // returned by API, AND not
 *                                             // propagated from prod into
 *                                             // staging — sibling to
 *                                             // staging:private for SQL.
 *                                             // See app-conventions.md.
 *         "default": "...",                   // applied if no stored value
 *         "staging_default": "..."            // committed staging fallback
 *                                             // for private entries.
 *                                             // Wins over `default` in
 *                                             // staging.
 *       },
 *       ...
 *     ]
 *   }
 *
 * `sensitive: true` is accepted as a backward-compatible alias for
 * `private: true` — the canonical field is `private`. Existing
 * dapp.json files written before the rename keep working unchanged.
 *
 * Missing file or unparseable JSON is treated as `{ secrets: [] }` — i.e.
 * exactly the legacy behavior. The platform never refuses to deploy on
 * an absent manifest; only on declared-required-but-unset values.
 */

const fs = require('fs');
const path = require('path');
const log = require('./logger');

const MANIFEST_FILENAME = 'dapp.json';

// Reserved keys the platform owns. A manifest entry using one of these
// is rejected on read so a dapp can't shadow / spoof the platform-injected
// values that all dapps depend on.
const RESERVED_KEYS = new Set([
  'DATABASE_URL',
  'JWT_SECRET',
  'PORT',
  'USERNODE_ENV',
  'USERNODE_MISSING_SECRETS',
  'USERNODE_LLM_PROXY_URL',
  'USERNODE_LLM_PROXY_TOKEN',
]);

// Reserved prefix for the LLM-proxy env-var family (issue #34) — any
// future USERNODE_LLM_PROXY_* addition stays platform-owned without
// another set entry.
const RESERVED_KEY_PREFIXES = ['USERNODE_LLM_PROXY'];

const KEY_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

// Bounds for the optional top-level `name` field (see readName). Matches
// the rename flow's MAX_APP_NAME_LENGTH so a hand-written manifest name
// can't outrun the apps.name column or the rename UI's validation.
const MAX_APP_NAME_LENGTH = 64;
const MIN_APP_NAME_LENGTH = 1;

// Normalize a raw top-level `name` into a trimmed string or null. Anything
// that isn't a string, is empty after trimming, or busts the length bound
// resolves to null — i.e. "no manifest name", so the platform name (the
// apps.name column) stays the effective display name. Never throws.
function readName(parsed) {
  const raw = typeof parsed?.name === 'string' ? parsed.name.trim() : '';
  if (raw.length < MIN_APP_NAME_LENGTH || raw.length > MAX_APP_NAME_LENGTH) return null;
  return raw;
}

// Bound on the consent dialog's purpose line — one short sentence, not
// a marketing paragraph.
const MAX_LLM_PURPOSE_LENGTH = 140;

// Normalize the optional top-level `llm` block (issue #34) — consent
// metadata for the platform's app-LLM proxy:
//   "llm": {
//     "purpose": "Summarizes long threads for you",
//     "suggested_daily_cap_cents": 300
//   }
// `purpose` is shown in the platform's consent dialog; the suggested
// cap pre-fills the dialog's editable cap field (instead of the $1.00
// default). Both presentation-only — the dialog's server-side grant
// validation is the authority on what cap actually gets stored, and
// the user can always edit the pre-fill. Lenient like everything else
// here: garbage values (non-string purpose, non-positive or
// non-integer cap) are dropped, an absent/empty block resolves to
// null and the dialog falls back to generic copy. Never throws.
function readLlm(parsed) {
  const raw = parsed?.llm;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const purpose = typeof raw.purpose === 'string' && raw.purpose.trim()
    ? raw.purpose.trim().slice(0, MAX_LLM_PURPOSE_LENGTH)
    : null;
  const cap = raw.suggested_daily_cap_cents;
  const suggestedCap = Number.isInteger(cap) && cap > 0 ? cap : null;
  if (purpose == null && suggestedCap == null) return null;
  const out = {};
  if (purpose != null) out.purpose = purpose;
  if (suggestedCap != null) out.suggested_daily_cap_cents = suggestedCap;
  return out;
}

function read(cloneDir) {
  const filePath = path.join(cloneDir, MANIFEST_FILENAME);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return { name: null, secrets: [], llm: null };
    log.warn('app-manifest', 'Read failed (treating as empty)', { filePath, err: err.message });
    return { name: null, secrets: [], llm: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn('app-manifest', 'Parse failed (treating as empty)', { filePath, err: err.message });
    return { name: null, secrets: [], llm: null };
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
    if (RESERVED_KEYS.has(key) || RESERVED_KEY_PREFIXES.some((p) => key.startsWith(p))) {
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
      // `private` is the canonical field; `sensitive` is accepted as
      // a backward-compatible alias. Either present (and truthy) flips
      // the entry to private. Internally we expose only `.private`.
      private: !!s.private || !!s.sensitive,
      default: typeof s.default === 'string' ? s.default : null,
      staging_default: typeof s.staging_default === 'string' ? s.staging_default : null,
    });
  }

  return { name: readName(parsed), secrets, llm: readLlm(parsed) };
}

/**
 * Write-through name resolution. Given a freshly-read manifest and the
 * app row it was read for, reconcile `apps.name` to the manifest's
 * top-level `name` when one is present and differs (case-sensitively)
 * from the stored name. This is how a `dapp.json` name takes precedence
 * over the platform name: it's resolved once, at deploy time, so the
 * large surface of display sites that read `apps.name` directly keeps
 * working unchanged.
 *
 * No-op (returns false) when the manifest carries no name — existing
 * apps with no `name` in `dapp.json` keep their platform name exactly.
 * Broadcasts the existing `app_update` `renamed` event on a real change
 * so connected clients update live (public/js/app.js handleAppUpdate).
 *
 * Best-effort and self-contained: a DB or WS hiccup here must never
 * fail the deploy that called it, so callers fire-and-log.
 */
async function reconcileAppName(pool, app, manifest) {
  const manifestName = manifest && typeof manifest.name === 'string' ? manifest.name : null;
  if (!manifestName) return false;
  const oldName = app.name || '';
  if (manifestName === oldName) return false;

  await pool.query('UPDATE apps SET name = $1 WHERE id = $2', [manifestName, app.id]);
  log.info('app-manifest', 'Reconciled app name from dapp.json', {
    appId: app.id, slug: app.slug, oldName, newName: manifestName,
  });

  try {
    const { pushAppUpdate } = require('./ws');
    pushAppUpdate({
      action: 'renamed',
      appId: app.id,
      slug: app.slug,
      oldName,
      newName: manifestName,
    });
  } catch (err) {
    log.warn('app-manifest', 'Rename broadcast failed', { appId: app.id, err: err.message });
  }
  return true;
}

module.exports = {
  read,
  readName,
  readLlm,
  reconcileAppName,
  RESERVED_KEYS,
  RESERVED_KEY_PREFIXES,
  KEY_RE,
  MANIFEST_FILENAME,
  MAX_APP_NAME_LENGTH,
  MIN_APP_NAME_LENGTH,
};
