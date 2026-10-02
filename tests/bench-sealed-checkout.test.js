'use strict';

// A benchmark trial's worker checkout is SEALED at the trial's base commit
// (worker/session-branch.sh, "Benchmark trials"; services/bench/runner.js
// sealedWorker). Before this, a trial's worker cloned today's main beside the
// trial's `bench/` branch: a DM triage plan said "canonical main already
// ships this as PR #3534 (commit 7c2d3ed7)", and two build candidates named
// their new files exactly as the later reference pull request did.
//
// The shell cases run the real library against real repositories in a temp
// dir: a bare "origin" whose main has moved past the base (the later fix, a
// tag on it, another member's branch) and a trial branch cut at the base.
// Nothing reaches a network. The control at the top reproduces the leak on
// the ordinary (unsealed) bootstrap, so the sealed cases are known to be
// testing something.
//
// Run with: node --test tests/bench-sealed-checkout.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'worker', 'session-branch.sh');
const worker = require('../src/services/worker');
const runner = require('../src/services/bench/runner');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_TERMINAL_PROMPT: '0',
};
const BRANCH = 'bench/r3-t44';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}
function gitOk(cwd, ...args) {
  return spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).status === 0;
}
function commitFile(cwd, file, content, message) {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

// origin: main = base -> later -> fix (tagged v2), dev/other off `later`,
// and the trial's branch cut at the base (as runner.pinBranch does on GitHub).
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-sealed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const origin = path.join(dir, 'origin.git');
  const seed = path.join(dir, 'seed');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, seed);
  git(seed, 'checkout', '-q', '-b', 'main');
  const base = commitFile(seed, 'app.js', 'v1\n', 'the base');
  const later = commitFile(seed, 'app.js', 'v2\n', 'someone else, merged later');
  const fix = commitFile(seed, 'mayor-rail.js', 'the answer\n', 'The fix the trial is asked for (#3534)');
  git(seed, 'tag', 'v2');
  git(seed, 'push', '-q', 'origin', 'main', '--tags');
  git(seed, 'checkout', '-q', '-b', 'dev/other', later);
  const other = commitFile(seed, 'other.js', 'x\n', 'another member');
  git(seed, 'push', '-q', 'origin', 'dev/other');
  git(seed, 'push', '-q', 'origin', `${base}:refs/heads/${BRANCH}`);
  return { dir, origin, base, later, fix, other };
}

function sh(cwd, snippet, env = {}) {
  const r = spawnSync('sh', ['-c', `set -u; BRANCH='${env.BRANCH || BRANCH}'; . '${LIB}'\n${snippet}`], {
    cwd, env: { ...GIT_ENV, ...env }, encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function sealedClone(t, fx, { base = fx.base, branch = BRANCH } = {}) {
  const ws = path.join(fx.dir, `ws-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(ws);
  const r = sh(ws, `usernode_clone_sealed '${fx.origin}'`, { USERNODE_PINNED_BASE: base, BRANCH: branch });
  return { ws, ...r };
}

const allRefs = (ws) => git(ws, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n').filter(Boolean).sort();
const hasObject = (ws, sha) => gitOk(ws, 'cat-file', '-e', `${sha}^{commit}`);

test('control: the ordinary bootstrap gives a trial today\'s main (the leak)', (t) => {
  const fx = fixture(t);
  const ws = path.join(fx.dir, 'plain');
  git(fx.dir, 'clone', '-q', '--single-branch', fx.origin, ws);
  const r = sh(ws, 'usernode_fetch_session_refs && usernode_checkout_session_branch');
  assert.equal(r.code, 0, r.out);
  assert.equal(git(ws, 'rev-parse', 'HEAD'), fx.base, 'the trial branch is at the base');
  assert.equal(git(ws, 'rev-parse', 'refs/remotes/origin/main'), fx.fix, 'but origin/main is today\'s main');
  assert.match(git(ws, 'log', '--oneline', 'origin/main'), /The fix the trial is asked for \(#3534\)/);
  assert.ok(hasObject(ws, fx.fix));
});

test('a sealed checkout holds the base, its ancestors and nothing later', (t) => {
  const fx = fixture(t);
  const { ws, code, out } = sealedClone(t, fx);
  assert.equal(code, 0, out);
  assert.equal(git(ws, 'symbolic-ref', '--short', 'HEAD'), BRANCH);
  assert.equal(git(ws, 'rev-parse', 'HEAD'), fx.base);
  assert.deepEqual(allRefs(ws), [
    `refs/heads/${BRANCH} ${fx.base}`,
    `refs/heads/main ${fx.base}`,
    `refs/remotes/origin/${BRANCH} ${fx.base}`,
    `refs/remotes/origin/main ${fx.base}`,
  ], 'no tag, no other branch, origin/main at the base');
  for (const sha of [fx.later, fx.fix, fx.other]) {
    assert.equal(hasObject(ws, sha), false, `${sha} is not even in the object store`);
  }
  const everything = git(ws, 'log', '--all', '--reflog', '--format=%H %s');
  assert.doesNotMatch(everything, /#3534|merged later|another member/);
  assert.equal(git(ws, 'rev-list', '--count', 'origin/main..HEAD'), '0');
  assert.equal(git(ws, 'rev-list', '--count', 'HEAD..origin/main'), '0', 'nothing even counts how far main moved');
});

test('nothing fetches later history from inside a turn', (t) => {
  const fx = fixture(t);
  const { ws, code, out } = sealedClone(t, fx);
  assert.equal(code, 0, out);
  for (const args of [['fetch', 'origin'], ['fetch'], ['fetch', 'origin', 'main'], ['fetch', '--tags'], ['pull'],
    ['fetch', 'origin', `+refs/heads/main:refs/remotes/origin/main`], ['remote', 'update']]) {
    assert.equal(gitOk(ws, ...args), false, `git ${args.join(' ')} must fail`);
  }
  assert.equal(git(ws, 'rev-parse', 'refs/remotes/origin/main'), fx.base);
  assert.equal(hasObject(ws, fx.fix), false);
  assert.equal(git(ws, 'remote', 'get-url', 'origin'), '/dev/null/no-upstream-in-a-benchmark-trial');

  // The per-turn refresh fetches nothing and puts back anything a turn added.
  git(ws, 'tag', 'stray', fx.base);
  git(ws, 'update-ref', 'refs/remotes/upstream/main', fx.base);
  git(ws, 'update-ref', 'refs/remotes/origin/main', git(ws, 'commit-tree', '-m', 'x', `${fx.base}^{tree}`));
  const turn = sh(ws, 'usernode_fetch_session_refs; echo "rc=$?"', { USERNODE_PINNED_BASE: fx.base });
  assert.match(turn.out, /rc=0/);
  assert.deepEqual(allRefs(ws), [
    `refs/heads/${BRANCH} ${fx.base}`,
    `refs/heads/main ${fx.base}`,
    `refs/remotes/origin/${BRANCH} ${fx.base}`,
    `refs/remotes/origin/main ${fx.base}`,
  ]);
  assert.equal(git(ws, 'config', '--get-all', 'remote.origin.fetch'), `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`);
});

test('the build still lands: the platform\'s push reaches GitHub\'s copy of the trial branch', (t) => {
  const fx = fixture(t);
  const { ws, code, out } = sealedClone(t, fx);
  assert.equal(code, 0, out);
  const built = commitFile(ws, 'pins.js', 'pinned\n', 'Homeroom benchmark: trial 44');
  const r = spawnSync('bash', ['-c', worker.buildPushScript({ workspace: ws })], {
    env: { ...GIT_ENV, BRANCH, PAT: 'unused-for-a-local-origin' }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split('\n').pop(), built);
  assert.equal(git(fx.origin, 'rev-parse', `refs/heads/${BRANCH}`), built, 'GitHub has the trial\'s commit (branchDiff reads it there)');
  assert.equal(git(ws, 'rev-parse', `refs/remotes/origin/${BRANCH}`), built, 'and the next turn starts from it');
  assert.equal(git(ws, 'rev-list', '--count', 'origin/main..HEAD'), '1', 'the trial\'s own commits, as `ahead`');
  // A second turn starts on the pushed commit, not back at the base.
  const next = sh(ws, 'usernode_fetch_session_refs; usernode_start_turn_on_session_branch clean_untracked; echo "rc=$?"', { USERNODE_PINNED_BASE: fx.base });
  assert.match(next.out, /rc=0/);
  assert.equal(git(ws, 'rev-parse', 'HEAD'), built);
});

test('run-codex-agent.sh on a sealed checkout: commits, counts the trial\'s own commits, fetches nothing', (t) => {
  const fx = fixture(t);
  const { ws, code, out: cloned } = sealedClone(t, fx);
  assert.equal(code, 0, cloned);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-sealed-codex-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  // The model looks for the answer the way the leaking one did, then builds.
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh
cat > /dev/null
git fetch origin main > /dev/null 2>&1 && echo "FETCHED" >&2
git log --all --reflog --format=%s > "$HOME/seen.txt"
echo pins > pins.js
echo '{"type":"thread.started","thread_id":"t-1"}'
exit 0
`);
  fs.chmodSync(path.join(bin, 'codex'), 0o755);
  const prompt = path.join(dir, 'prompt.txt');
  fs.writeFileSync(prompt, 'build it');
  const env = {
    ...GIT_ENV,
    PATH: `${bin}:${process.env.PATH}`, HOME: dir,
    PROMPT_FILE: prompt, BRANCH, MODE: 'build', USERNODE_PINNED_BASE: fx.base,
    WORKER_JWT: 'jwt', SESSION_ID: '1', PLATFORM_URL: 'http://127.0.0.1:9',
    OPENROUTER_API_KEY: 'sk-or-v1-test', OPENROUTER_API_BASE: 'https://openrouter.ai/api/v1',
    AGENT_MODEL: 'z-ai/glm-5.3-flash',
    WORKSPACE_DIR: ws, CODEX_HOME: path.join(dir, 'codex-home'),
    INLOOP_PGDATA: path.join(dir, 'no-pgdata'),
  };
  const r = spawnSync('sh', [path.join(ROOT, 'worker', 'run-codex-agent.sh')], { env, encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  assert.doesNotMatch(out, /FETCHED/);
  const line = out.split('\n').find((l) => l.startsWith('__USERNODE_RESULT__')) || '';
  const res = Object.fromEntries(line.replace('__USERNODE_RESULT__ ', '').split(' ').map((kv) => kv.split('=')));
  assert.equal(res.ahead, '1', out);
  assert.equal(res.behind, '0');
  assert.equal(res.sha, git(ws, 'rev-parse', BRANCH));
  assert.equal(git(ws, 'show', '--name-only', '--format=', 'HEAD'), 'pins.js');
  const seen = fs.readFileSync(path.join(dir, 'seen.txt'), 'utf8');
  assert.match(seen, /the base/);
  assert.doesNotMatch(seen, /#3534|merged later|another member/, 'the model\'s own `git log --all` reaches nothing later');
  assert.equal(hasObject(ws, fx.fix), false);
});

test('a sealed checkout refuses a base it cannot vouch for', (t) => {
  const fx = fixture(t);
  const notOnBranch = sealedClone(t, fx, { base: fx.fix });
  assert.notEqual(notOnBranch.code, 0);
  assert.match(notOnBranch.out, /does not contain the pinned base/);
  const bad = sealedClone(t, fx, { base: 'main' });
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /not a commit id/);
  const short = sealedClone(t, fx, { base: fx.base.slice(0, 12) });
  assert.notEqual(short.code, 0);
  assert.match(short.out, /not a full commit id/);
});

test('every other session keeps the ordinary checkout', (t) => {
  const fx = fixture(t);
  const ws = path.join(fx.dir, 'dev');
  git(fx.dir, 'clone', '-q', '--single-branch', fx.origin, ws);
  // USERNODE_PINNED_BASE unset or empty: main is fetched as before.
  const r = sh(ws, 'usernode_fetch_session_refs && usernode_checkout_session_branch', { BRANCH: 'dev/me', USERNODE_PINNED_BASE: '' });
  assert.equal(r.code, 0, r.out);
  assert.equal(git(ws, 'config', '--get-all', 'remote.origin.fetch'), '+refs/heads/main:refs/remotes/origin/main');
  assert.equal(git(ws, 'rev-parse', 'refs/remotes/origin/main'), fx.fix);
  assert.notEqual(git(ws, 'remote', 'get-url', 'origin'), '/dev/null/no-upstream-in-a-benchmark-trial');
});

// ── The wiring ──────────────────────────────────────────────────────────

test('the bootstrap seals a pinned checkout, and only the platform\'s pinned base sets it', async () => {
  const bootstrap = fs.readFileSync(path.join(ROOT, 'worker', 'worker-run.sh'), 'utf8');
  assert.match(bootstrap, /if usernode_pinned; then\n\s+if ! CLONE_OUT="\$\(usernode_clone_sealed "\$CLONE_URL"\)"; then\n\s+die "clone failed: \$\(clip "\$CLONE_OUT"\)"/);
  const host = fs.readFileSync(path.join(ROOT, 'src', 'services', 'worker.js'), 'utf8');
  assert.match(host, /\.\.\.\(pinnedBase \? \{ USERNODE_PINNED_BASE: pinnedBase \} : \{\}\)/,
    'the variable is set only for a pinned worker');
  assert.match(host, /repoOwner, repoName, branchName, onProgress, temporary, pinnedBase,\n\s+\}\);/);
  await assert.rejects(worker.ensureWorker(1, { repoOwner: 'o', repoName: 'r', branchName: BRANCH, pinnedBase: 'main' }),
    /pinned base must be a full commit id/);
});

test('every worker a trial starts is sealed at the base the stage recorded, or refused', async () => {
  const seen = [];
  const real = {
    async ensureWorker(id, opts) { seen.push(opts); return 'w-1'; },
    async stopTurn() { return this === real; },
  };
  let base = null;
  const w = runner.sealedWorker(real, () => base);
  await assert.rejects(w.ensureWorker(1, { branchName: BRANCH }), /benchmark trials may not start a worker before its base commit is pinned/);
  assert.equal(seen.length, 0, 'never started unsealed');
  base = 'b'.repeat(40);
  assert.equal(await w.ensureWorker(1, { branchName: BRANCH, temporary: true }), 'w-1');
  assert.deepEqual(seen, [{ branchName: BRANCH, temporary: true, pinnedBase: base }]);
  assert.equal(await w.stopTurn(1), true, 'everything else is the real worker');
});
