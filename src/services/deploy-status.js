const fs = require('fs');
const path = require('path');
const kubernetes = require('./kubernetes');

// Where the deploy workflow drops `deploy-status.json` (bind-mounted from
// the host into the container — see docker-compose.yml). Unset in local
// dev → no banner / no pill state, which is correct.
const RUNTIME_PATH = process.env.USERNODE_RUNTIME_PATH;

// If the file claims a deploy started more than this long ago, treat it
// as abandoned. Covers the case where the VPS rebooted mid-deploy and
// the workflow's `if: always()` cleanup step never got to run, which
// would otherwise leave the banner stuck on indefinitely.
const DEPLOY_STALE_AFTER_MS = 30 * 60 * 1000;

function readDocker() {
  if (!RUNTIME_PATH) return null;
  try {
    const raw = fs.readFileSync(path.join(RUNTIME_PATH, 'deploy-status.json'), 'utf8');
    const data = JSON.parse(raw);
    if (data.deploying && data.startedAt) {
      const age = Date.now() - new Date(data.startedAt).getTime();
      if (age > DEPLOY_STALE_AFTER_MS) {
        return { ...data, deploying: false, stale: true };
      }
    }
    return data;
  } catch {
    // File doesn't exist (no deploys yet) or is malformed — both look
    // like "no deploy happening" from a consumer's perspective.
    return null;
  }
}

let cached = null;
let pending = null;
async function read(config = {}) {
  if ((config.appRuntime || process.env.APP_RUNTIME || 'docker') !== 'kubernetes') return readDocker();
  // A self-app preview has no authority over the platform's release rollout.
  if (process.env.USERNODE_ENV === 'staging') return null;
  const cfg = config.kubernetes || {};
  const key = `${cfg.platformNamespace}/${cfg.platformDeployment}`;
  if (cached?.key === key && Date.now() - cached.at < 5000) return cached.value;
  if (pending?.key === key) return pending.promise;
  const promise = kubernetes.getPlatformDeployStatus(config).catch(() => ({
    deploying: false, unavailable: true, runtimeKind: 'kubernetes', phase: 'unknown',
  })).then(value => { cached = { key, at: Date.now(), value }; return value; });
  pending = { key, promise };
  try { return await promise; } finally { if (pending?.promise === promise) pending = null; }
}

module.exports = { read };
