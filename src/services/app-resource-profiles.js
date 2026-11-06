'use strict';

// Operator-assigned production profiles. Requests change scheduling and CPU
// share under contention; the ceilings stay the same so a small app can start
// and burst. An unmeasured app, a preview, and Homeroom keep the standard one.
const PROFILES = Object.freeze({
  standard: Object.freeze({ cpu: '100m', memory: '128Mi' }),
  small: Object.freeze({ cpu: '25m', memory: '64Mi' }),
});
const ANNOTATION = 'social.usernode.io/resource-profile';
const { HOSTED_APP_ID } = require('../../worker/shots-hosted-app-contract');

function assignments(raw = {}) {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new Error('KUBERNETES_APP_RESOURCE_PROFILES must be a JSON object'); }
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('KUBERNETES_APP_RESOURCE_PROFILES must be an app-ID to profile object');
  }
  for (const [id, profile] of Object.entries(value)) {
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)) || !Object.hasOwn(PROFILES, profile)) {
      throw new Error(`Invalid app resource profile assignment: ${id}`);
    }
  }
  return value;
}

function forApp(config, app, environment, { cpus = null, internalOnly = false } = {}) {
  const configured = assignments(config?.kubernetes?.appResourceProfiles ?? {});
  const ordinary = environment === 'production' && !internalOnly && !app.self_hosted
    && app.slug !== config?.selfAppSlug && Number(app.id) !== HOSTED_APP_ID;
  const profile = ordinary ? configured[String(app.id)] || 'standard' : 'standard';
  return {
    profile,
    resources: {
      requests: { ...PROFILES[profile] },
      limits: { cpu: String(cpus || '1'), memory: '1Gi' },
    },
  };
}

async function reconcile(config, pool, { deps = {} } = {}) {
  if (config?.appRuntime !== 'kubernetes' || process.env.USERNODE_ENV === 'staging'
    || process.env.STAGING_SESSION_ID) return { off: true };
  assignments(config?.kubernetes?.appResourceProfiles ?? {});
  const { rows } = await pool.query(
    `SELECT id, slug, self_hosted FROM apps WHERE status = 'running' AND self_hosted IS NOT TRUE
      AND runtime_kind = 'kubernetes'`);
  return (deps.kubernetes || require('./kubernetes')).reconcileAppResourceProfiles(config, rows, { maxChanges: 1 });
}

module.exports = { PROFILES, ANNOTATION, assignments, forApp, reconcile };
