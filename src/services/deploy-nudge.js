// Nudge the host-side deployer after a self-app merge.
//
// The deployer (scripts/usernode-deployer.sh, systemd on the VPS) polls
// github.com for a new main head. Its full poll is deliberately slow
// (~2 min — a courtesy to GitHub), but on-platform merges shouldn't wait
// for it: the platform KNOWS the moment a self-app PR lands on main. It
// can't tell the poller directly — /var/lib/usernode/runtime is mounted
// read-only precisely so the container can't forge deploy state — so
// compose adds one narrow WRITABLE mount for this file alone
// (/opt/usernode/runtime/deploy-nudge on the host). The poller stats it
// every couple of seconds and runs its git poll immediately on a change.
//
// The nudge is a HINT, never an authority: the poller still fetches from
// github.com and deploys only what main actually points at, so the worst
// a spurious/forged nudge can cause is one extra no-op git fetch. And
// it's strictly best-effort: local dev has no mount, an old host has no
// dir, and in every such case the deployer's 2-minute baseline poll
// still picks the merge up — so failures here log and return false, and
// must never fail the merge that triggered them.

const fs = require('fs');
const path = require('path');
const log = require('./logger');

const NUDGE_DIR = process.env.USERNODE_DEPLOY_NUDGE_PATH || '/var/lib/usernode/deploy-nudge';

/**
 * Signal the host deployer that main just moved. Returns true when the
 * nudge file was written, false when it couldn't be (no mount, no dir,
 * permissions) — callers should not care which.
 */
function nudgeHostDeployer({ sha = null, prNumber = null } = {}) {
  try {
    if (!fs.existsSync(NUDGE_DIR)) return false;
    // Write-then-rename so the poller can never read a half-written
    // file. Content is informational only — the poller keys on mtime.
    const payload = JSON.stringify({
      sha, prNumber, at: new Date().toISOString(),
    });
    const tmp = path.join(NUDGE_DIR, '.nudge.tmp');
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, path.join(NUDGE_DIR, 'nudge'));
    log.info('deploy-nudge', 'Host deployer nudged', { sha, prNumber });
    return true;
  } catch (err) {
    log.warn('deploy-nudge', 'Could not nudge host deployer (baseline poll will catch it)', {
      err: err.message,
    });
    return false;
  }
}

module.exports = { nudgeHostDeployer, NUDGE_DIR };
