'use strict';

const crypto = require('crypto');
const log = require('./logger');

// Production-deploy plumbing for app groups (#6669): the two env vars an
// app container needs to tell Homeroom who is in a group its approval rules
// can name, plus lazy generation of the per-app credential. Exact sibling
// of app-storage-env.js.
//
//   USERNODE_GROUPS_URL    — in-network base URL of the app-groups API
//                            (http://usernode:3000/api/app-groups).
//   USERNODE_GROUPS_TOKEN  — apps.groups_api_token, random 64-hex,
//                            generated at first production deploy.
//
// STAGING DEPLOYS INJECT NEITHER: unreviewed PR code must not change who
// decides. An app checks for the token and does nothing when it is absent.

function groupsBaseUrl() {
  const base = process.env.PLATFORM_INTERNAL_URL || 'http://usernode:3000';
  return `${base.replace(/\/$/, '')}/api/app-groups`;
}

// Get-or-create apps.groups_api_token. The WHERE ... IS NULL guard +
// re-read makes concurrent first-deploys converge on one token instead
// of clobbering each other.
async function ensureGroupsApiToken(pool, appId) {
  const { rows } = await pool.query(
    'SELECT groups_api_token FROM apps WHERE id = $1', [appId]
  );
  let token = rows[0]?.groups_api_token || null;
  if (!token) {
    const fresh = crypto.randomBytes(32).toString('hex');
    await pool.query(
      'UPDATE apps SET groups_api_token = $1 WHERE id = $2 AND groups_api_token IS NULL',
      [fresh, appId]
    );
    const { rows: rows2 } = await pool.query(
      'SELECT groups_api_token FROM apps WHERE id = $1', [appId]
    );
    token = rows2[0]?.groups_api_token || fresh;
    log.info('app-groups-env', 'Generated groups_api_token', { appId });
  }
  return token;
}

// Env-var pair for a PRODUCTION container. Best-effort: a DB hiccup here
// must not fail the deploy that called it.
async function productionGroupsEnv(pool, appId) {
  try {
    const token = await ensureGroupsApiToken(pool, appId);
    return {
      USERNODE_GROUPS_URL: groupsBaseUrl(),
      USERNODE_GROUPS_TOKEN: token,
    };
  } catch (err) {
    log.warn('app-groups-env', 'Failed to resolve groups env; deploying without', {
      appId, err: err.message,
    });
    return {};
  }
}

module.exports = { groupsBaseUrl, ensureGroupsApiToken, productionGroupsEnv };
