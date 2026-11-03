'use strict';

// Platform previews (SEC-06): what the trusted orchestrator stamps on them,
// signs and lets them sign in as. Loaded by the deployed platform, never by
// the proposed checkout. A platform preview's database starts EMPTY
// (db-manager.js createEmptyPlatformDatabase): its own boot builds the
// schema and seeds its fixtures, and nothing is copied from production.
// docs/security/platform-preview-data.md.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const PLATFORM_SLUG = 'usernode-2d5619';
const PLATFORM_DATABASE = 'app_usernode_2d5619';
const LABEL = 'social.usernode.io/preview-data-policy';
const RECEIPT_LABEL = 'social.usernode.io/preview-data-receipt';
const APP_ID_LABEL = 'social.usernode.io/app-id';
// The code that makes and retires a platform preview's database: changing it
// invalidates every serving preview, which retirement then removes
// (platform-preview-retirement.js) and the preview machine builds again.
const DIGEST = crypto.createHash('sha256').update(fs.readFileSync(__filename))
  .update(fs.readFileSync(require.resolve('./db-manager')))
  .update(fs.readFileSync(require.resolve('./application-runtime')))
  .update(fs.readFileSync(require.resolve('./platform-preview-retirement'))).digest('hex').slice(0, 40);
// The two screenshot personas' fixed ids in every platform preview: the
// platform signs their tokens with these, and a preview's own seeds make
// them there (services/preview-personas.js).
const { PREVIEW_PERSONA_IDS, previewPersonaId } = require('./preview-personas');
function refuse(message) {
  return Object.assign(new Error(`Platform preview data policy: ${message}`), { noFallback: true, platformPreviewPolicy: true });
}
function sourceIdentity(name) {
  // Templates and frozen sources keep the full source prefix. Also cover a
  // differently named primary platform database on self-hosted installations.
  let primary = null;
  try { primary = new URL(process.env.DATABASE_URL).pathname.slice(1); } catch { /* no configured platform database */ }
  return [PLATFORM_DATABASE, primary].filter(Boolean).find(source => name === source
    || name === `${source}_stgtmpl` || name === `${source}_stgtmpl_next`
    || new RegExp(`^${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_evsrc_[0-9a-f]{12}$`).test(name)) || null;
}
// Only the two reserved persona handles survive. Other production handles
// may be undiscoverable or historically contain email addresses; the
// deterministic alias lets a reviewer sign in (the preview makes their row
// on first sign-in, middleware/auth.js) without making the production
// account directory enumerable.
function previewIdentity(user) {
  if (!Number.isSafeInteger(user?.id) || user.id < 1) throw refuse('invalid preview user identity');
  const persona = PREVIEW_PERSONA_IDS.has(user.username);
  return {
    ...user, id: previewPersonaId(user), username: persona ? user.username : `preview-user-${user.id}`,
    usernode_pubkey: null, locale: null,
  };
}
// A preview runs its proposal's own code, and shots run both revisions', so
// that code must know how to start empty: it makes the platform's row at its
// app id, the personas at their ids and a reviewer's row on first sign-in.
// Code from before then says so by lacking src/db/preview-boot.json, and is
// refused rather than started without them (signed-out checks and shots, no
// reviewer able to sign in).
const NEEDS_UPDATE = 'This change was started before platform previews stopped copying production data. Update it with main to preview it.';
const BOOT_FILE = 'src/db/preview-boot.json';
// The marker's text, as a checkout or the code host holds it (null: none).
function bootFileStartsEmpty(text) {
  try { return JSON.parse(text).startsEmpty >= 1; } catch { return false; }
}
function startsEmpty(checkoutDir) {
  try {
    return bootFileStartsEmpty(fs.readFileSync(path.join(checkoutDir, ...BOOT_FILE.split('/')), 'utf8'));
  } catch { return false; }
}
function isOpaqueDockerPreview(name) {
  return /^usernode-(shots|evidence)-[0-9a-f]{16}-(base|head)$/.test(name);
}
// Docker inherits image LABELs. Public policy labels therefore cannot attest
// a database. Only the trusted orchestrator can sign its exact runtime, app
// and injected connection URL. This key never enters a preview; do not fall
// back to SESSION_SECRET or any other preview-known key. Labels contain no URL.
function runtimeReceipt(config, { appId, runtimeName, policyTag, databaseUrl }) {
  const secret = config?.edgeJwtSecret || process.env.EDGE_JWT_SECRET;
  if (typeof secret !== 'string' || !secret) throw refuse('runtime receipt key is unavailable');
  if (!/^[1-9][0-9]*$/.test(String(appId)) || typeof runtimeName !== 'string' || !runtimeName
      || ![DIGEST, 'authored'].includes(policyTag) || typeof databaseUrl !== 'string' || !databaseUrl) {
    throw refuse('invalid runtime receipt inputs');
  }
  const key = crypto.createHmac('sha256', secret).update('homeroom:preview-runtime-receipt:v1').digest();
  const connection = crypto.createHash('sha256').update(databaseUrl).digest('hex');
  return crypto.createHmac('sha256', key)
    .update(JSON.stringify(['v1', DIGEST, String(appId), runtimeName, policyTag, connection]))
    .digest('hex').slice(0, 40);
}
function verifyRuntimeReceipt(config, inputs, receipt) {
  if (typeof receipt !== 'string' || !/^[0-9a-f]{40}$/.test(receipt)) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(receipt, 'hex'), Buffer.from(runtimeReceipt(config, inputs), 'hex'));
  } catch { return false; }
}
function runtimeLabels(result) {
  if (!result?.platformPreviewPolicy) return {};
  if (result.platformPreviewPolicy !== DIGEST) throw refuse('database was made by another policy');
  return { [LABEL]: DIGEST };
}
module.exports = { DIGEST, LABEL, RECEIPT_LABEL, APP_ID_LABEL, PLATFORM_SLUG, PLATFORM_DATABASE, PREVIEW_PERSONA_IDS, NEEDS_UPDATE,
  BOOT_FILE, bootFileStartsEmpty, startsEmpty,
  isOpaqueDockerPreview, runtimeReceipt, verifyRuntimeReceipt,
  sourceIdentity, runtimeLabels, previewIdentity, previewPersonaId, refuse };
