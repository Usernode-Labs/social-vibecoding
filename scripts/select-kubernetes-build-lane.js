'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

// Older revisions keep verifying in lane 0. A confirmed tip uses lane 1
// unless another tip is already building there and lane 0 is entirely idle.
// This snapshot only selects a queue. Actions enforces both concurrency limits.
async function selectLane(env, readTip, readGroups) {
  if (await readTip() !== env.GITHUB_SHA) return 0;
  const page = await readGroups();
  if (!Array.isArray(page?.concurrency_groups) || page.total_count !== page.concurrency_groups.length) return 1;
  const names = new Set(page.concurrency_groups.map(group => group.group_name));
  const busy = lane => ['platform', 'postgres', 'worker', 'capture'].some(component =>
    names.has(`kubernetes-build-${env.GITHUB_REF}-${component}-${lane}`));
  return busy(1) && !busy(0) ? 0 : 1;
}

async function main(env) {
  const lane = await selectLane(env, () => {
    try {
      return execFileSync('git', ['ls-remote', '--exit-code', 'origin', env.GITHUB_REF],
        { encoding: 'utf8', timeout: 5000 }).split(/\s+/)[0];
    } catch {
      return null;
    }
  }, async () => {
    try {
      const response = await fetch(
        `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/concurrency_groups?per_page=100`, {
          headers: { Authorization: `Bearer ${env.GH_TOKEN}`, 'X-GitHub-Api-Version': '2026-03-10' },
          signal: AbortSignal.timeout(3000), redirect: 'error',
        });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  });
  fs.appendFileSync(env.GITHUB_OUTPUT, `build_lane=${lane}\n`);
}

if (require.main === module) main(process.env).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = { selectLane };
