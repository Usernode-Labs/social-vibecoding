// Tests for the deploy half of in-platform env management: the
// dump-platform-env materializer, its wiring into scripts/deploy.sh
// (the deploy logic shared by the host deployer and the Deploy
// workflow) and .github/workflows/deploy.yml (the runner-side steps),
// and the post-deploy health gate.
//
// Both are guardrailed files that no test can execute, so these are
// text pins in the style of tests/caddy-deploy-grace.test.js. Each
// one guards a property whose failure mode is silent and expensive:
//
//  - ORDER. Console values are appended to .env LAST. Put them anywhere
//    else and the committed default silently wins, which looks exactly
//    like "the admin console doesn't work".
//  - THE CACHE SURVIVES rsync --delete. Without the exclude, the
//    fallback has nothing to fall back to.
//  - THE MATERIALIZER RUNS OFF THE NEW IMAGE. Built before it runs, so
//    a variable introduced by a proposal is resolvable on the deploy
//    that introduces it rather than one deploy later.
//  - THE HEALTH GATE ROLLS BACK. A deploy that comes up dead and stays
//    up is worse than a deploy that fails.
//
// Run with: node --test tests/platform-env-deploy.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const deployYml = fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8');
const deploySh = fs.readFileSync(path.join(root, 'scripts/deploy.sh'), 'utf8');
const dumpJs = fs.readFileSync(path.join(root, 'scripts/dump-platform-env.js'), 'utf8');

const at = (needle, label) => {
  const i = deployYml.indexOf(needle);
  assert.notStrictEqual(i, -1, `${label}: not found in deploy.yml (${needle})`);
  return i;
};

// The remote deploy logic moved out of deploy.yml's ssh step into
// scripts/deploy.sh so the host deployer can run the identical code
// without an Actions runner. The ordering pins below therefore index
// into deploy.sh.
const atSh = (needle, label) => {
  const i = deploySh.indexOf(needle);
  assert.notStrictEqual(i, -1, `${label}: not found in scripts/deploy.sh (${needle})`);
  return i;
};

// ── The materializer script ───────────────────────────────────────────

test('the script parses and only writes the block to stdout', () => {
  assert.doesNotThrow(() => new (require('node:vm').Script)(dumpJs, { filename: 'dump-platform-env.js' }));
  // config.load() and the logger both write to stdout, so the block has
  // to be delimited rather than assumed to be the whole stream.
  assert.match(dumpJs, /#__PLATFORM_ENV_BEGIN__/);
  assert.match(dumpJs, /#__PLATFORM_ENV_END__/);
  const stdoutWrites = [...dumpJs.matchAll(/process\.stdout\.write\([^\n]*/g)].map((m) => m[0]);
  assert.ok(stdoutWrites.length >= 1);
  for (const w of stdoutWrites) {
    assert.ok(/BEGIN/.test(w) || /lines\.join/.test(w),
      `stdout must only ever carry the delimited block, got: ${w}`);
  }
});

test('diagnostics go to stderr so they cannot corrupt the block', () => {
  assert.ok(!/console\.log\(/.test(dumpJs),
    'console.log would land inside the captured stream');
  assert.match(dumpJs, /console\.error\(/);
});

test('the script resolves through the DAO, which filters unwritable keys', () => {
  assert.match(dumpJs, /platformEnv\.getRawValues\(pool, rows\[0\]\.id, config\.dataEncryptionKey\)/);
  assert.match(dumpJs, /self_hosted = TRUE/,
    'only the platform\'s own row — a child app\'s env comes from app_secrets');
});

test('the script re-checks representability with the same function the console uses', () => {
  assert.match(dumpJs, /platformEnv\.validateValue\(values\[key\]\)/);
  assert.match(dumpJs, /\$\{key\}='\$\{value\}'/, 'values are single-quoted, like GITHUB_PRIVATE_KEY');
});

test('a missing self-app row emits an empty block rather than failing', () => {
  const branch = dumpJs.slice(dumpJs.indexOf('if (!rows.length)'));
  assert.match(branch.slice(0, 400), /\$\{BEGIN\}\\n\$\{END\}/,
    'a fresh database should deploy with the committed defaults, not reuse a stale cache');
});

test('the script never prints a value in an error path', () => {
  const errs = [...dumpJs.matchAll(/console\.error\([^\n]*/g)].map((m) => m[0]).join('\n');
  assert.ok(!/values\[key\]/.test(errs), 'the reason, never the value');
});

// ── Runner-side resolution of GitHub-named variables ──────────────────

test('declared variables are resolved from toJSON(secrets)/toJSON(vars)', () => {
  assert.match(deployYml, /ALL_SECRETS: \$\{\{ toJSON\(secrets\) \}\}/,
    'the only way to read a secret whose name is not literal in this file');
  assert.match(deployYml, /ALL_VARS: \$\{\{ toJSON\(vars\) \}\}/);
});

test('the manifest is the allow-list, and unwritable keys are skipped', () => {
  const step = deployYml.slice(at('Resolve GitHub-sourced platform variables', 'runner step'),
    at('- name: Sync repo to VPS', 'sync step'));
  assert.match(step, /readPlatformEnv/,
    'the same reader the platform uses — the derivation cannot drift');
  assert.match(step, /if \(entry\.unwritable\) continue;/);
  assert.match(step, /::add-mask::/,
    'a forwarded value must be masked before it can appear in any later log line');
});

test('the forwarded block reaches the remote through the ssh-action envs list', () => {
  assert.match(deployYml, /GH_PLATFORM_ENV_B64=\$\(base64 -w0/,
    'single-line base64 survives $GITHUB_ENV and envs: without quoting games');
  assert.match(deployYml, /envs: [^\n]*GH_PLATFORM_ENV_B64/);
});

// ── Remote script ordering ────────────────────────────────────────────

test('the previous sha is captured BEFORE .env is overwritten', () => {
  assert.ok(atSh("PREV_SHA=$(grep -m1 '^GIT_SHA=' .env", 'PREV_SHA capture')
    < atSh('base64 -d > .env', 'base .env write'),
    'reading GIT_SHA after the overwrite would roll back to the sha being deployed');
});

test('without the workflow blob, .env is patched in place, never invented', () => {
  // The host-deployer path has no access to GitHub secrets, so it must
  // keep the .env from the last secret-bearing deploy and only update
  // GIT_SHA. Rewriting (or refusing) here would take production down on
  // the first poll-triggered deploy.
  const patch = deploySh.slice(atSh('No BASE_ENV_B64: keeping the existing .env', 'patch mode'));
  assert.match(patch.slice(0, 400), /awk -v sha="\$DEPLOY_SHA"/,
    'GIT_SHA is patched with the same awk approach rollback.sh uses');
  assert.match(deploySh, /No BASE_ENV_B64 and no existing \.env/,
    'a green-field install without secrets must fail loudly, not boot unconfigured');
});

test('console values are appended to .env last, after the GitHub-sourced ones', () => {
  // The base layer is composed on the runner and decoded here with a
  // single `> .env` (see deploy-workflow-expression-limit.test.js for why
  // it is not a heredoc inside the workflow); the two override blocks
  // then append with `>> .env`.
  const baseWrite = atSh('base64 -d > .env', 'base .env write');
  const ghAppend = atSh('base64 -d >> .env', 'GitHub block append');
  const consoleAppend = atSh('cat .platform-env >> .env', 'console block append');
  assert.ok(baseWrite < ghAppend, 'GitHub-sourced values override committed defaults');
  assert.ok(ghAppend < consoleAppend,
    'the admin console is the primary path — its values must win over both');
});

test('the console block does not accumulate across patch-mode deploys', () => {
  // Patch mode keeps the previous .env, which already ends in a console
  // block; the strip-then-append keeps the file from growing one
  // duplicate block per poll-triggered deploy.
  const strip = atSh('#__CONSOLE_ENV_BEGIN__$/{skip=1}', 'console block strip');
  const append = atSh("echo '#__CONSOLE_ENV_BEGIN__' >> .env", 'console block append marker');
  assert.ok(strip < append, 'the old block is stripped before the fresh one is appended');
});

test('the console values are resolved before the platform starts with that .env', () => {
  assert.ok(atSh('cat .platform-env >> .env', 'append') < atSh('docker compose up -d usernode', 'up'),
    'appending after the container is up would take a whole extra deploy to apply');
});

test('the materializer runs off the freshly built image', () => {
  const build = atSh('docker compose build usernode', 'build');
  const run = atSh('docker compose run --rm --no-deps -T usernode', 'materializer run');
  const up = atSh('docker compose up -d usernode', 'up');
  assert.ok(build < run && run < up,
    'build → materialize → up, so a variable added by this very commit is resolvable now');
  assert.ok(!/docker compose up -d --build usernode/.test(deploySh),
    'the combined form would start the container before the values were resolved');
});

test('a failed materialization reuses the cache instead of truncating .env', () => {
  assert.match(deploySh, /node scripts\/dump-platform-env\.js 2>\/dev\/null \|\| true/,
    'non-fatal by design');
  assert.match(deploySh, /grep -q '\^#__PLATFORM_ENV_END__\$'/,
    'only a COMPLETE block replaces the cache — a half-written one is discarded');
  assert.match(deploySh, /reusing cache/);
  assert.match(deploySh, /chmod 600 \.platform-env/, 'the cache holds decrypted values');
});

test('the cache survives the rsync --delete', () => {
  const args = deployYml.slice(at('ARGS: "-avz --delete', 'rsync args'));
  assert.match(args.slice(0, 400), /--exclude=\.platform-env\*/,
    'without this, --delete wipes the cache every deploy and the fallback is empty');
});

// ── Post-deploy health gate ───────────────────────────────────────────

test('the health probe requires two consecutive successes', () => {
  assert.match(deploySh, /"\$HEALTH_STREAK" -ge 2/,
    'a container mid-boot can answer once and then exit; one 200 is not health');
  assert.match(deploySh, /HEALTH_STREAK=0/, 'the streak resets on any failure');
});

test('the probe hits /health from inside the container, on an interval, with a cap', () => {
  assert.match(deploySh, /docker compose exec -T usernode wget -qO- http:\/\/localhost:3000\/health/);
  assert.match(deploySh, /sleep 5/);
  assert.match(deploySh, /HEALTH_WAITED" -lt 120/);
});

test('failure dumps logs, rolls back to PREV_SHA, and fails the job', () => {
  const gate = deploySh.slice(atSh('if [ "$HEALTH_OK" -ne 1 ]', 'health gate'));
  assert.match(gate.slice(0, 1400), /docker compose logs --tail 200 usernode/,
    'the logs are the only artifact left after a rollback');
  assert.match(gate.slice(0, 1400), /\/opt\/usernode-tools\/rollback\.sh "\$PREV_SHA"/);
  assert.match(gate.slice(0, 1400), /::error::/, 'the job must go red, not just log');
  assert.match(gate.slice(0, 1400), /exit 1/);
});

test('an empty PREV_SHA does not roll back to nothing', () => {
  const gate = deploySh.slice(atSh('if [ "$HEALTH_OK" -ne 1 ]', 'health gate'));
  assert.match(gate.slice(0, 1400), /if \[ -n "\$PREV_SHA" \]/);
  assert.match(gate.slice(0, 1400), /-x \/opt\/usernode-tools\/rollback\.sh/,
    'a green-field deploy has no rollback target and must say so rather than erroring obscurely');
});

test('the deploy-finished signal still runs after a failed health gate', () => {
  const finish = deployYml.slice(at('- name: Signal deploy finished', 'finish step'));
  assert.match(finish.slice(0, 200), /if: always\(\)/,
    'the health gate exits 1 — the /status banner must still clear');
});
