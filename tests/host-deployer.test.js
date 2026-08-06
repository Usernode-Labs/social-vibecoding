// Tests for the host-side deploy pipeline: scripts/deploy.sh (the
// single copy of the deploy logic), scripts/usernode-deployer.sh (the
// systemd poller that replaces the GitHub Actions runner as the primary
// deploy trigger), and the workflow's slimmed-down delegation.
//
// Motivation: the 2026-08-06 GitHub Actions outage left merged commits
// sitting undeployed for hours because the only deploy path was a
// runner picking up the push. The poller needs nothing but github.com's
// git data plane — the same dependency rollback.sh already has.
//
// Shell scripts can't be unit-executed here (they drive docker on the
// VPS), so this suite is `bash -n` syntax gates plus text pins on the
// properties whose failure modes are silent:
//
//  - DIVERGENT COPIES. The rsync exclude list and the node/caddy path
//    filters exist in multiple places (workflow, deployer, rollback);
//    if they drift, a deploy path starts wiping .env or skipping the
//    archive refresh only when triggered one way.
//  - DOUBLE DEPLOYS. Both paths can fire for one push; the flock plus
//    SKIP_IF_CURRENT is what turns the loser into a no-op.
//  - THRASH. A bad commit health-gates and rolls back; without the
//    failure backoff the poller would rebuild → rollback in a loop
//    forever.
//
// Run with: node --test tests/host-deployer.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const deploySh = read('scripts/deploy.sh');
const deployerSh = read('scripts/usernode-deployer.sh');
const rollbackSh = read('scripts/rollback.sh');
const unit = read('scripts/usernode-deployer.service');
const deployYml = read('.github/workflows/deploy.yml');

// ── Syntax gates ──────────────────────────────────────────────────────

for (const script of ['scripts/deploy.sh', 'scripts/usernode-deployer.sh', 'scripts/rollback.sh']) {
  test(`${script} parses (bash -n)`, () => {
    const res = spawnSync('bash', ['-n', path.join(root, script)], { encoding: 'utf8' });
    assert.equal(res.status, 0, `bash -n failed:\n${res.stderr}`);
  });
}

// ── One exclude list, three copies ────────────────────────────────────

// Extract `--exclude=X` values from a blob of shell/yaml text.
function excludes(src, from, label) {
  const i = src.indexOf(from);
  assert.notStrictEqual(i, -1, `${label}: anchor not found (${from})`);
  // Scan the ~500 chars after the anchor — every list is contiguous.
  // Shell copies escape the glob (`.platform-env\*`); normalize the
  // backslash away so the three lists compare on meaning, not quoting.
  const window = src.slice(i, i + 500);
  const found = [...window.matchAll(/--exclude=([^\s"]+)/g)]
    .map((m) => m[1].replace(/\\/g, ''));
  assert.ok(found.length >= 5, `${label}: expected an exclude list near the anchor`);
  return found.sort();
}

test('workflow rsync, rollback, and deployer agree on what survives a deploy', () => {
  const workflow = excludes(deployYml, 'ARGS: "-avz --delete', 'workflow rsync');
  const rollback = excludes(rollbackSh, 'rsync -av --delete', 'rollback rsync');
  const deployer = excludes(deployerSh, 'rsync -a --delete', 'deployer rsync');
  assert.deepEqual(rollback, workflow,
    'rollback.sh must preserve exactly what the workflow preserves (.env, runtime, .platform-env…)');
  assert.deepEqual(deployer, workflow,
    'usernode-deployer.sh must preserve exactly what the workflow preserves');
});

test('the deployer’s node/caddy filters mirror the workflow’s paths-filter', () => {
  const filterBlock = deployYml.slice(deployYml.indexOf('filters: |'), deployYml.indexOf('# ---'));
  const nodePaths = [...filterBlock.matchAll(/^\s+- '([^']+)'/gm)].map((m) => m[1]);
  assert.ok(nodePaths.includes('scripts/deploy.sh'),
    'the deploy logic moved to scripts/deploy.sh; changing IT is what warrants an archive refresh now');
  for (const p of nodePaths.filter((x) => x !== 'caddy.Dockerfile')) {
    assert.ok(deployerSh.includes(`'${p}'`),
      `${p} is in the workflow node filter but missing from NODE_FILTER in usernode-deployer.sh`);
  }
  assert.match(deployerSh, /CADDY_FILTER=\(\n\s+'caddy\.Dockerfile'/,
    'the deployer must gate caddy rebuilds on the same file the workflow does');
});

// ── deploy.sh safety properties ───────────────────────────────────────

test('deploy.sh is single-flight and signals /status on every exit path', () => {
  assert.match(deploySh, /exec 9> runtime\/deploy\.lock/, 'both callers must serialize on one lock');
  assert.match(deploySh, /flock -w 1800 9/);
  assert.match(deploySh, /"deploying":true/, 'the /status banner arms at start');
  assert.match(deploySh, /trap 'echo "\{\\"deploying\\":false\}" > runtime\/deploy-status\.json' EXIT/,
    'the flag must clear on failure and ctrl-C too, not only on success');
});

test('deploy.sh skips an already-deployed healthy sha only when asked to', () => {
  const skip = deploySh.slice(deploySh.indexOf('SKIP_IF_CURRENT:-0'));
  assert.match(skip.slice(0, 500), /\[ "\$PREV_SHA" = "\$DEPLOY_SHA" \]/);
  assert.match(skip.slice(0, 500), /wget -qO- http:\/\/localhost:3000\/health/,
    'sha equality alone is not enough — a recorded sha with a dead container must redeploy');
  assert.match(deploySh, /exit 0/, 'the skip is a success, not a failure');
});

test('deploy.sh still waits out platform-DB pg_dumps before cutover', () => {
  // Ported from the workflow (2026-07-30 incident): an in-flight
  // staging-clone dump holds ACCESS SHARE locks that block boot
  // migrations and eat the whole health gate.
  assert.match(deploySh, /application_name = 'pg_dump'/);
  assert.match(deploySh, /DUMP_WAITED" -lt 600/);
});

test('deploy.sh installs the deployer alongside rollback.sh and never restarts it from within', () => {
  assert.match(deploySh, /install -m 755 scripts\/rollback\.sh \/opt\/usernode-tools\/rollback\.sh/);
  assert.match(deploySh, /install -m 755 scripts\/usernode-deployer\.sh \/opt\/usernode-tools\/usernode-deployer\.sh/,
    'the self-update handoff: deploy.sh installs, the poller re-execs');
  assert.match(deploySh, /systemctl daemon-reload/, 'unit refresh is picked up');
  assert.doesNotMatch(deploySh, /systemctl restart usernode-deployer/,
    'restarting the service from inside deploy.sh would kill the poller that invoked it, mid-deploy');
});

// ── The poller ────────────────────────────────────────────────────────

test('the poller runs deploy.sh in patch mode with the race guard on', () => {
  assert.match(deployerSh, /SKIP_IF_CURRENT=1/,
    'when the workflow won the race, the poller must not rebuild the same sha');
  const invocation = deployerSh.slice(
    deployerSh.indexOf('if DEPLOY_SHA="$target"'),
    deployerSh.indexOf('bash "$DEPLOY_DIR/scripts/deploy.sh"')
  );
  assert.ok(invocation.length > 0, 'the deploy.sh invocation must be findable');
  assert.doesNotMatch(invocation, /BASE_ENV_B64=/,
    'the poller has no secrets and must never pass a base env — patch mode only');
  assert.match(deployerSh, /set -uo pipefail/,
    'pipefail is load-bearing: deploy.sh pipes through tee, and without it a failed deploy reads as success');
  assert.match(deployerSh, /\| tee "\$DEPLOY_DIR\/runtime\/deploy-last\.log"/);
});

test('a failed sha backs off instead of thrashing build → rollback', () => {
  assert.match(deployerSh, /RETRY_FAILED_SECONDS/);
  assert.match(deployerSh, /LAST_FAILED_SHA/);
  assert.match(deployerSh, /\[ "\$target" = "\$LAST_FAILED_SHA" \]/,
    'the backoff is per-sha: any new commit on main deploys immediately');
});

test('the poller self-updates by re-exec after a successful deploy', () => {
  assert.match(deployerSh, /exec "\$0"/,
    'deploy.sh installs the fresh copy; re-exec is how the running loop adopts it');
});

test('an unreachable github.com degrades to a retry, never an exit', () => {
  assert.match(deployerSh, /git fetch failed; will retry/,
    'a git outage must leave the poller alive to catch the recovery');
  assert.match(deployerSh, /while true; do\n  tick \|\|/,
    'a tick failure must not break the loop');
});

// ── systemd unit ──────────────────────────────────────────────────────

test('the unit runs the mirrored copy as deploy and always restarts', () => {
  assert.match(unit, /ExecStart=\/opt\/usernode-tools\/usernode-deployer\.sh/,
    'must exec the rsync-proof mirror, not the tree that --delete rewrites mid-deploy');
  assert.match(unit, /User=deploy/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /After=network-online\.target docker\.service/);
});

// ── Workflow wiring ───────────────────────────────────────────────────

test('the workflow’s push trigger defers to the poller; dispatch forces', () => {
  assert.match(deployYml, /SKIP_IF_CURRENT: \$\{\{ github\.event_name == 'push' && '1' \|\| '0' \}\}/,
    'push runs are the redundant path now and must no-op when the poller already deployed');
  const envs = deployYml.match(/envs: ([^\n]+)/);
  assert.ok(envs && envs[1].includes('SKIP_IF_CURRENT'),
    'SKIP_IF_CURRENT must be forwarded or the remote shell never sees it');
});

test('workflow_dispatch remains the secret-rotation path', () => {
  // The skip check runs before deploy.sh touches .env, so a skipped
  // push run changes nothing on disk. Rotating a secret therefore goes
  // through workflow_dispatch (SKIP_IF_CURRENT=0), which always
  // forwards the freshly composed blob and rewrites .env.
  assert.match(deployYml, /BASE_ENV_B64: \$\{\{ env\.BASE_ENV_B64 \}\}/);
  assert.match(deploySh, /if \[ -n "\$\{BASE_ENV_B64:-\}" \]/);
  const skip = deploySh.indexOf('SKIP_IF_CURRENT:-0');
  const envWrite = deploySh.indexOf('base64 -d > .env');
  assert.ok(skip !== -1 && skip < envWrite,
    'the skip must come before the .env rewrite so a skipped run is a true no-op');
});
