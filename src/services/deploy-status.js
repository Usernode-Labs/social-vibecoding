const fs = require('fs');
const path = require('path');

// Where the deploy workflow drops `deploy-status.json` (bind-mounted from
// the host into the container — see docker-compose.yml). Unset in local
// dev → no banner / no pill state, which is correct.
const RUNTIME_PATH = process.env.USERNODE_RUNTIME_PATH;

// If the file claims a deploy started more than this long ago, treat it
// as abandoned. Covers the case where the VPS rebooted mid-deploy and
// the workflow's `if: always()` cleanup step never got to run, which
// would otherwise leave the banner stuck on indefinitely.
const DEPLOY_STALE_AFTER_MS = 30 * 60 * 1000;

function read() {
  if (!RUNTIME_PATH) return null;
  try {
    const raw = fs.readFileSync(path.join(RUNTIME_PATH, 'deploy-status.json'), 'utf8');
    const data = JSON.parse(raw);
    if (data.deploying && data.startedAt) {
      const age = Date.now() - new Date(data.startedAt).getTime();
      if (age > DEPLOY_STALE_AFTER_MS) {
        return { deploying: false, stale: true, ...data };
      }
    }
    return data;
  } catch {
    // File doesn't exist (no deploys yet) or is malformed — both look
    // like "no deploy happening" from a consumer's perspective.
    return null;
  }
}

module.exports = { read };
