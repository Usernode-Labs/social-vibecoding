'use strict';

const crypto = require('crypto');
const log = require('./logger');

// Production-deploy plumbing for app → platform calls: the env vars an
// app container needs to reach the platform's LLM proxy (issue #34) and
// the read-only app-platform API (#744), plus lazy generation of the
// per-app credential.
//
//   USERNODE_LLM_PROXY_URL    — in-network base URL of the proxy
//                               (http://usernode:3000/api/app-llm).
//   USERNODE_LLM_PROXY_TOKEN  — apps.llm_proxy_token, random 64-hex,
//                               generated at first production deploy
//                               (same adoption shape as db_password).
//   USERNODE_PLATFORM_API_URL — in-network base URL of the app-facing
//                               read-only platform API
//                               (http://usernode:3000/api/app-platform),
//                               authenticated with the same token.
//
// STAGING DEPLOYS INJECT NONE OF THESE — the exact `private: true`
// secret precedent: unreviewed PR code must not be able to spend grants
// (and gets no platform-API access either). Apps detect the absent env
// vars and degrade their AI / governance-feed features (see
// app-conventions.md "App LLM access" + "App governance feed").

// Same default as PLATFORM_INTERNAL_URL in services/worker.js — the
// platform's in-network hostname on the shared docker network.
function llmProxyBaseUrl() {
  const base = process.env.PLATFORM_INTERNAL_URL || 'http://usernode:3000';
  return `${base.replace(/\/$/, '')}/api/app-llm`;
}

// #744: base URL of the app-facing read-only platform API (governance
// feed). Injected as USERNODE_PLATFORM_API_URL alongside the proxy
// pair below; authenticated with the SAME per-app token
// (USERNODE_LLM_PROXY_TOKEN), so no extra credential plumbing.
function platformApiBaseUrl() {
  const base = process.env.PLATFORM_INTERNAL_URL || 'http://usernode:3000';
  return `${base.replace(/\/$/, '')}/api/app-platform`;
}

// Get-or-create apps.llm_proxy_token. The WHERE ... IS NULL guard +
// re-read makes concurrent first-deploys converge on one token instead
// of clobbering each other.
async function ensureLlmProxyToken(pool, appId) {
  const { rows } = await pool.query(
    'SELECT llm_proxy_token FROM apps WHERE id = $1', [appId]
  );
  let token = rows[0]?.llm_proxy_token || null;
  if (!token) {
    const fresh = crypto.randomBytes(32).toString('hex');
    await pool.query(
      'UPDATE apps SET llm_proxy_token = $1 WHERE id = $2 AND llm_proxy_token IS NULL',
      [fresh, appId]
    );
    const { rows: rows2 } = await pool.query(
      'SELECT llm_proxy_token FROM apps WHERE id = $1', [appId]
    );
    token = rows2[0]?.llm_proxy_token || fresh;
    log.info('app-llm-env', 'Generated llm_proxy_token', { appId });
  }
  return token;
}

// Env-var pair for a PRODUCTION container. Best-effort: a DB hiccup
// here must not fail the deploy that called it — the app just comes up
// without LLM access until the next rebuild.
async function productionLlmEnv(pool, appId) {
  try {
    const token = await ensureLlmProxyToken(pool, appId);
    return {
      USERNODE_LLM_PROXY_URL: llmProxyBaseUrl(),
      USERNODE_LLM_PROXY_TOKEN: token,
      // #744: app-facing read-only platform API (governance feed),
      // authenticated with the same token. Production-only like the
      // proxy pair — the staging deploy path injects none of these.
      USERNODE_PLATFORM_API_URL: platformApiBaseUrl(),
    };
  } catch (err) {
    log.warn('app-llm-env', 'Failed to resolve LLM proxy env; deploying without', {
      appId, err: err.message,
    });
    return {};
  }
}

module.exports = { llmProxyBaseUrl, platformApiBaseUrl, ensureLlmProxyToken, productionLlmEnv };
