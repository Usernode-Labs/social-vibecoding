// Unit-suite check: run the proposal repo's own `npm test` as ONE synthetic
// row in the proposal checks run.
//
// Why this exists. The dapp.json checks are browser acceptance tests driven
// against the staged deployment; a repo's node unit suite was invisible to
// the merge gate. Born-failing unit tests merged freely and rotted until
// someone ran `npm test` locally — 12 accumulated failures were dug out in
// Aug 2026 (three stale card suites, a moved-file router test, and five
// failures masked as TAP "cancelled"). One aggregate check closes that hole
// without spending any of the MAX_DECLARED_TESTS ceiling.
//
// How it runs. Its own one-shot container (the worker image: node + git),
// which clones the proposal's pinned ref, `npm ci`, `npm test`, judged by
// EXIT CODE — never by parsing `# fail` counts. TAP counts cancelled tests
// separately from failed ones: a suite whose event loop dies mid-file
// reports `# fail 0` while whole files never finished (exactly the masking
// that hid five failures for weeks). The process exit code covers both.
//
// Wall-clock. captureForSession launches this BEFORE the capture container
// and awaits it after, so the two run concurrently: the unit suite adds
// ~zero latency to the checks run unless it outlasts the entire
// browser-check pass.
//
// Gating. The row participates in #1019 earned gating through
// check-history under its own checkKey: ADVISORY until this app has been
// observed passing it once, merge-BLOCKING from then on (no demotion).
// Turning the feature on fleet-wide therefore never blocks an app on a
// suite that was already broken before the feature existed.
//
// Failure phases. A clone/install failure is reported with a "suite setup
// failed" prefix but still fails the row — a PR that breaks `npm ci` (bad
// package.json, broken lockfile) must not merge just because the suite
// never got to run. Operators can re-run checks from the proposal card if
// the cause was a transient registry hiccup.

'use strict';

const docker = require('./docker');
const github = require('./github');
const checkHistory = require('./check-history');
const appManifest = require('./app-manifest');
const log = require('./logger');

const UNIT_CHECK_NAME = 'Repo unit suite (npm test) passes';
const UNIT_CHECK_PATH = 'package.json';
// Synthetic-row index namespace: -1 is the missing-advisory rollup, -2 the
// over-ceiling guard (visuals.js). This row is -3.
const UNIT_CHECK_INDEX = -3;

// The worker image ships node 22 + git (+ a local postgres it won't use
// here) and is rebuilt daily, so reusing it means no new image to build or
// deploy. Override for self-hosters whose worker image is named differently.
const UNIT_SUITE_IMAGE = process.env.UNIT_SUITE_IMAGE || 'usernode-worker:latest';
const UNIT_SUITE_TIMEOUT_MS = parseInt(process.env.UNIT_SUITE_TIMEOUT_MS, 10) || 600 * 1000;
const UNIT_SUITE_CPUS = process.env.UNIT_SUITE_CPUS || '4';
const UNIT_SUITE_MEMORY = process.env.UNIT_SUITE_MEMORY || '2g';
const UNIT_SUITE_MAX_BUFFER = 32 * 1024 * 1024;

// failureReason rides in test_results inside every proposal payload — keep
// it a diagnostic pointer, not a log dump.
const FAILURE_DETAIL_MAX = 1600;
const MAX_NOT_OK_LINES = 8;
const MAX_TAIL_LINES = 8;

// Printed by the container script between dependency install and `npm
// test`. Output that never reached it failed in setup, not in the suite.
const SETUP_DONE_SENTINEL = '__UNIT_SUITE_SETUP_DONE__';

function isEnabled() {
  const v = String(process.env.UNIT_SUITE_CHECK_ENABLED ?? '1').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

// Does this package.json declare a test script worth running? The npm
// scaffold's placeholder (`echo "Error: no test specified" && exit 1`)
// would fail every app that never wrote tests — that is "no suite", not
// "failing suite".
function hasRunnableTestScript(rawPackageJson) {
  if (!rawPackageJson || typeof rawPackageJson !== 'string') return false;
  let parsed;
  try { parsed = JSON.parse(rawPackageJson); } catch { return false; }
  const script = parsed && parsed.scripts && parsed.scripts.test;
  if (typeof script !== 'string' || !script.trim()) return false;
  if (/no test specified/i.test(script)) return false;
  return true;
}

// Distill a failed run's output into a bounded failureReason. TAP `not ok`
// lines plus the summary counters when present (node:test, tap); otherwise
// the last few non-empty lines of output (jest & friends, npm/git errors).
function failureDetail(stdout, stderr, { timedOut = false } = {}) {
  const out = `${String(stdout || '')}\n${String(stderr || '')}`;
  const lines = out.split('\n');
  const parts = [];
  if (timedOut) {
    parts.push(`Suite run exceeded ${Math.round(UNIT_SUITE_TIMEOUT_MS / 1000)}s and was killed.`);
  }
  if (!out.includes(SETUP_DONE_SENTINEL) && !timedOut) {
    parts.push('Suite setup failed (clone / npm ci) — the tests never ran.');
  }
  const notOk = lines.filter((l) => l.startsWith('not ok '));
  if (notOk.length) {
    parts.push(...notOk.slice(0, MAX_NOT_OK_LINES).map((l) => l.trim()));
    if (notOk.length > MAX_NOT_OK_LINES) parts.push(`(+${notOk.length - MAX_NOT_OK_LINES} more failing tests)`);
    const summary = lines.filter((l) => /^# (tests|pass|fail|cancelled) /.test(l));
    parts.push(...summary.map((l) => l.trim()));
  } else {
    const tail = lines.map((l) => l.trim())
      .filter((l) => l && l !== SETUP_DONE_SENTINEL)
      .slice(-MAX_TAIL_LINES);
    parts.push(...tail);
  }
  return parts.join(' | ').slice(0, FAILURE_DETAIL_MAX);
}

// The container script. Fetches the exact ref the rest of the checks run
// judges (branch name for native proposals, head SHA for imported /
// cli-handoff ones — see visuals.sessionGitRef). A fork-headed SHA that the
// base repo can't serve directly is reachable through GitHub's pull/N/head
// mirror, same fallback staging's clone uses.
const RUN_SCRIPT = `
set -eu
# The worker image runs as USER node — work somewhere it can write.
WS="$(mktemp -d)"
cd "$WS"
git init -q .
git remote add origin "$REPO_URL"
if git fetch -q --depth 1 origin "$GIT_REF"; then
  git checkout -q --detach FETCH_HEAD
elif [ -n "\${PR_NUMBER:-}" ] && git fetch -q --depth 1 origin "pull/\${PR_NUMBER}/head"; then
  git checkout -q --detach "$GIT_REF" 2>/dev/null || git checkout -q --detach FETCH_HEAD
else
  echo "unit-suite: could not fetch $GIT_REF" >&2
  exit 90
fi
git submodule update --init --recursive --depth 1 >/dev/null 2>&1 || true
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund --loglevel=error
else
  npm install --no-audit --no-fund --loglevel=error
fi
echo "${SETUP_DONE_SENTINEL}"
npm test
`;

// Run the proposal repo's unit suite and shape the outcome as one
// extraRows entry plus its check-history record. Returns null when there
// is nothing to run (feature off, GitHub off, no runnable test script) —
// the checks run then proceeds exactly as before this feature existed.
// Never throws.
async function maybeRunUnitSuite({ pool, appId, sessionId, repoOwner, repoName, ref, prNumber }) {
  if (!isEnabled() || !github.isEnabled() || !repoOwner || !repoName || !ref) return null;

  let rawPkg = null;
  try {
    rawPkg = await github.getFileContent(repoOwner, repoName, UNIT_CHECK_PATH, ref);
  } catch (err) {
    log.warn('unit-suite', 'package.json fetch failed — skipping unit suite', {
      sessionId, repo: `${repoOwner}/${repoName}`, ref, err: err.message,
    });
    return null;
  }
  if (!hasRunnableTestScript(rawPkg)) return null;

  const checkKey = appManifest.checkKey(UNIT_CHECK_NAME, UNIT_CHECK_PATH);
  // Ungraduated on any doubt: the safe default is advisory, so a history
  // hiccup can only under-block, never wrongly block.
  let graduated = false;
  try {
    graduated = (await checkHistory.loadGraduated(pool, appId)).has(checkKey);
  } catch (err) {
    log.warn('unit-suite', 'Graduation lookup failed — treating as advisory', {
      sessionId, appId, err: err.message,
    });
  }

  const startedAt = Date.now();
  let passed = false;
  let reason = '';
  try {
    const cloneUrl = await github.getCloneUrl(repoOwner, repoName);
    await docker.runOneShot(`usernode-unit-suite-${sessionId}`, {
      image: UNIT_SUITE_IMAGE,
      cmd: ['bash', '-c', RUN_SCRIPT],
      env: {
        REPO_URL: cloneUrl,
        GIT_REF: ref,
        PR_NUMBER: prNumber ? String(prNumber) : '',
        CI: 'true',
        NODE_ENV: 'test',
        npm_config_update_notifier: 'false',
      },
      memory: UNIT_SUITE_MEMORY,
      cpus: UNIT_SUITE_CPUS,
      timeoutMs: UNIT_SUITE_TIMEOUT_MS,
      maxBuffer: UNIT_SUITE_MAX_BUFFER,
    });
    passed = true;
  } catch (err) {
    const timedOut = err.killed === true || err.signal === 'SIGTERM' || err.signal === 'SIGKILL';
    reason = failureDetail(err.stdout, err.stderr, { timedOut });
    if (!reason) reason = String(err.message || 'npm test failed').slice(0, FAILURE_DETAIL_MAX);
  }
  log.info('unit-suite', 'Unit suite finished', {
    sessionId, repo: `${repoOwner}/${repoName}`, ref, passed, graduated,
    durationMs: Date.now() - startedAt,
  });

  return {
    row: {
      index: UNIT_CHECK_INDEX,
      name: UNIT_CHECK_NAME,
      path: UNIT_CHECK_PATH,
      status: passed ? 'pass' : 'fail',
      advisory: passed ? false : !graduated,
      consoleErrors: [],
      failureReason: passed ? '' : reason,
    },
    history: { checkKey, name: UNIT_CHECK_NAME, path: UNIT_CHECK_PATH, passed },
  };
}

module.exports = {
  maybeRunUnitSuite,
  // Exported for tests.
  hasRunnableTestScript,
  failureDetail,
  isEnabled,
  UNIT_CHECK_NAME,
  UNIT_CHECK_PATH,
  UNIT_CHECK_INDEX,
  SETUP_DONE_SENTINEL,
};
