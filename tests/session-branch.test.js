// worker/session-branch.sh: the session-branch integrity helpers the worker's
// bootstrap and both runners share, and the push proxy's script that settles
// the branch the same way (worker.buildPushScript).
//
// Every case is from Sheep countrr (usernode-bot/sheep-countrr-a08857#48):
//   - #34: an agent found another member's unmerged branch with
//     `git branch -a` and copied its commit into its own proposal.
//   - #38 (session 5030): a build committed on a local `wolf-mechanic`
//     branch; the runner only warned, the push heal reported that commit as
//     pushed while GitHub had nothing, and recovery replayed it ~1,357 times.
//   - #38 again: a stopped turn's screenshots, left untracked, were swept into
//     a later turn's commit.
//
// These run the real shell against real git repositories in a temp dir (a
// bare "origin" and a working clone); nothing reaches a network.
//
// Run with: node --test tests/session-branch.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'worker', 'session-branch.sh');
const worker = require('../src/services/worker');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_TERMINAL_PROMPT: '0',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function commitFile(cwd, file, content, message) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

// origin (bare) with main, this session's dev/me (one commit ahead of main)
// and another member's dev/other; `ws` is a full clone, as every worker's
// was before this change, checked out on dev/me.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-branch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const origin = path.join(dir, 'origin.git');
  const seed = path.join(dir, 'seed');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, seed);
  git(seed, 'checkout', '-q', '-b', 'main');
  commitFile(seed, 'app.js', 'v1\n', 'main');
  git(seed, 'push', '-q', 'origin', 'main');
  git(seed, 'checkout', '-q', '-b', 'dev/me');
  const mine = commitFile(seed, 'mine.js', 'mine\n', 'my earlier turn');
  git(seed, 'push', '-q', 'origin', 'dev/me');
  git(seed, 'checkout', '-q', '-b', 'dev/other', 'main');
  const theirs = commitFile(seed, 'round.js', 'Round X of 9\n', "another member's feature");
  git(seed, 'push', '-q', 'origin', 'dev/other');
  const ws = path.join(dir, 'ws');
  git(dir, 'clone', '-q', origin, ws);
  git(ws, 'checkout', '-q', 'dev/me');
  return { dir, origin, ws, mine, theirs };
}

// Run a snippet with the library sourced, BRANCH set, in the workspace.
function sh(cwd, snippet, { branch = 'dev/me' } = {}) {
  const r = spawnSync('sh', ['-c', `set -u; BRANCH='${branch}'; . '${LIB}'\n${snippet}`], {
    cwd, env: GIT_ENV, encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const remoteRefs = (ws) => git(ws, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/')
  .split('\n').filter(Boolean).sort();

test('the checkout knows main and its own branch, never another member\'s (#34)', (t) => {
  const { ws } = fixture(t);
  assert.ok(remoteRefs(ws).includes('refs/remotes/origin/dev/other'), 'a full clone sees every branch');

  const r = sh(ws, 'usernode_fetch_session_refs');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(remoteRefs(ws).filter((ref) => ref !== 'refs/remotes/origin/HEAD'),
    ['refs/remotes/origin/dev/me', 'refs/remotes/origin/main']);
  assert.equal(git(ws, 'config', '--get-all', 'remote.origin.fetch'), '+refs/heads/main:refs/remotes/origin/main');
  // A plain `git fetch` (what an agent runs) no longer brings the others back.
  git(ws, 'fetch', '-q', 'origin');
  assert.ok(!remoteRefs(ws).includes('refs/remotes/origin/dev/other'));
  assert.doesNotMatch(git(ws, 'branch', '-a'), /dev\/other/);
});

test('a fresh session, before its branch exists on GitHub, still fetches main', (t) => {
  const { ws, dir } = fixture(t);
  const seed = path.join(dir, 'seed');
  git(seed, 'checkout', '-q', 'main');
  const newMain = commitFile(seed, 'app.js', 'v2\n', 'main moves');
  git(seed, 'push', '-q', 'origin', 'main');
  const r = sh(ws, 'usernode_fetch_session_refs', { branch: 'dev/brand-new' });
  assert.equal(r.code, 0, r.out);
  assert.equal(git(ws, 'rev-parse', 'refs/remotes/origin/main'), newMain);
});

test('a single-branch clone plus the session fetch is what the bootstrap leaves', (t) => {
  const { dir, origin, mine } = fixture(t);
  const fresh = path.join(dir, 'fresh');
  git(dir, 'clone', '-q', '--single-branch', origin, fresh);
  // git's `checkout dev/me` shorthand cannot see origin's copy once the
  // refspec names main alone, which is why the bootstrap spells it out.
  assert.notEqual(spawnSync('git', ['rev-parse', '--verify', '-q', 'refs/heads/dev/me'], { cwd: fresh }).status, 0);
  const r = sh(fresh, 'usernode_fetch_session_refs && usernode_checkout_session_branch');
  assert.equal(r.code, 0, r.out);
  assert.equal(git(fresh, 'symbolic-ref', '--short', 'HEAD'), 'dev/me');
  assert.equal(git(fresh, 'rev-parse', 'HEAD'), mine, "the session branch is GitHub's copy, not a new branch from main");
  // A session whose branch does not exist on GitHub yet starts from main.
  const fresh2 = path.join(dir, 'fresh2');
  git(dir, 'clone', '-q', '--single-branch', origin, fresh2);
  const n = sh(fresh2, 'usernode_fetch_session_refs && usernode_checkout_session_branch', { branch: 'dev/brand-new' });
  assert.equal(n.code, 0, n.out);
  assert.equal(git(fresh2, 'rev-parse', 'HEAD'), git(fresh2, 'rev-parse', 'refs/remotes/origin/main'));
  assert.deepEqual(remoteRefs(fresh).filter((ref) => ref !== 'refs/remotes/origin/HEAD'),
    ['refs/remotes/origin/dev/me', 'refs/remotes/origin/main']);
});

test('a turn starts on the session branch whatever an earlier turn left checked out, without its leftovers', (t) => {
  const { ws } = fixture(t);
  fs.writeFileSync(path.join(ws, '.gitignore'), 'node_modules/\n');
  git(ws, 'add', '.gitignore');
  git(ws, 'commit', '-q', '-m', 'ignore deps');
  git(ws, 'push', '-q', 'origin', 'dev/me');
  const tip = git(ws, 'rev-parse', 'HEAD');
  // An earlier turn switched to a branch of its own, committed, and was
  // stopped with a screenshot and an edit lying around.
  git(ws, 'checkout', '-q', '-b', 'wolf-mechanic');
  const stray = commitFile(ws, 'wolf.js', 'wolf\n', 'wolf');
  fs.writeFileSync(path.join(ws, 'page-1.png'), 'png');
  fs.writeFileSync(path.join(ws, 'app.js'), 'half-edited\n');
  fs.mkdirSync(path.join(ws, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'node_modules', 'x', 'index.js'), '1');

  const r = sh(ws, 'usernode_fetch_session_refs; usernode_start_turn_on_session_branch clean_untracked');
  assert.equal(r.code, 0, r.out);
  assert.equal(git(ws, 'symbolic-ref', '--short', 'HEAD'), 'dev/me', 'back on the session branch');
  assert.equal(git(ws, 'rev-parse', 'HEAD'), tip, "at GitHub's copy of it");
  assert.equal(git(ws, 'status', '--porcelain'), '', 'no leftovers for the commit step to sweep');
  assert.ok(!fs.existsSync(path.join(ws, 'page-1.png')));
  assert.ok(fs.existsSync(path.join(ws, 'node_modules', 'x', 'index.js')), 'ignored files stay');
  assert.equal(git(ws, 'rev-parse', 'wolf-mechanic'), stray, "the earlier branch is kept, so its commit can be found");

  // A scout (no clean_untracked) keeps untracked files it did not make.
  fs.writeFileSync(path.join(ws, 'notes.md'), 'kept');
  assert.equal(sh(ws, 'usernode_start_turn_on_session_branch').code, 0);
  assert.ok(fs.existsSync(path.join(ws, 'notes.md')));
});

test('work committed on a branch of the agent\'s own is moved onto the session branch (session 5030)', (t) => {
  const { ws, mine } = fixture(t);
  git(ws, 'checkout', '-q', '-b', 'wolf-mechanic');
  const wolf = commitFile(ws, 'wolf.js', 'wolf\n', 'Add the wolf');
  fs.writeFileSync(path.join(ws, 'wolf.js'), 'wolf, uncommitted tweak\n');

  const r = sh(ws, 'usernode_settle_session_branch; echo "rc=$? mismatch=[$USERNODE_BRANCH_MISMATCH]"');
  assert.match(r.out, /rc=0 mismatch=\[\]/);
  assert.match(r.out, /__USERNODE_WARN__ The agent committed on wolf-mechanic instead of the session branch dev\/me; its commits were moved onto dev\/me\./);
  assert.equal(git(ws, 'symbolic-ref', '--short', 'HEAD'), 'dev/me');
  assert.equal(git(ws, 'rev-parse', 'dev/me'), wolf);
  assert.equal(git(ws, 'merge-base', '--is-ancestor', mine, 'dev/me'), '');
  assert.match(git(ws, 'status', '--porcelain'), /wolf\.js/, 'the uncommitted tweak comes along');

  // A detached HEAD that grew from the session branch is the same case.
  git(ws, 'checkout', '-q', '--detach');
  const detached = commitFile(ws, 'more.js', 'more\n', 'detached work');
  const d = sh(ws, 'usernode_settle_session_branch; echo "rc=$?"');
  assert.match(d.out, /rc=0/);
  assert.match(d.out, /committed on a detached HEAD at [0-9a-f]+ instead of the session branch/);
  assert.equal(git(ws, 'rev-parse', 'dev/me'), detached);
});

test('work on a line that does not build on the session branch is neither committed nor pushed', (t) => {
  const { ws, mine, theirs } = fixture(t);
  // An agent that fetched another member's branch explicitly and worked there.
  git(ws, 'fetch', '-q', 'origin', 'dev/other');
  git(ws, 'checkout', '-q', '-b', 'borrowed', theirs);
  commitFile(ws, 'calm.js', 'calm\n', 'Calm mode');

  const r = sh(ws, 'usernode_settle_session_branch; echo "rc=$? mismatch=[$USERNODE_BRANCH_MISMATCH]"');
  assert.match(r.out, /rc=1 mismatch=\[1\]/);
  assert.match(r.out, /__USERNODE_WARN__ The agent ended on borrowed, which does not build on the session branch dev\/me; nothing from this turn was committed or pushed\./);
  assert.equal(git(ws, 'rev-parse', 'dev/me'), mine, 'the session branch is untouched');
  assert.equal(git(ws, 'symbolic-ref', '--short', 'HEAD'), 'borrowed', 'the work is left where it is');
});

test('an agent that committed its own work keeps its choice: new files it left out stay out', (t) => {
  const { ws } = fixture(t);
  const start = git(ws, 'rev-parse', 'HEAD');
  commitFile(ws, 'feature.js', 'feature\n', 'Agent commit');
  fs.writeFileSync(path.join(ws, 'feature.js'), 'feature, forgot to commit this line\n');
  fs.writeFileSync(path.join(ws, 'screenshot.png'), 'png');

  const r = sh(ws, `usernode_commit_leftovers '${start}' 'Changes via Homeroom'`);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /__USERNODE_WARN__ Left out of the commit \(new files the agent did not commit\): screenshot\.png/);
  assert.deepEqual(git(ws, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['feature.js'],
    'the forgotten edit to a tracked file is committed');
  assert.equal(git(ws, 'status', '--porcelain'), '?? screenshot.png');
});

test('an agent that committed nothing has its working tree committed, as the Homeroom bot relies on', (t) => {
  const { ws } = fixture(t);
  const start = git(ws, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(ws, 'new-file.js'), 'new\n');
  fs.writeFileSync(path.join(ws, 'app.js'), 'v1 edited\n');
  const r = sh(ws, `usernode_commit_leftovers '${start}' 'Homeroom bot: #12'`);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(git(ws, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['app.js', 'new-file.js']);
  assert.equal(git(ws, 'log', '-1', '--format=%s'), 'Homeroom bot: #12');
  assert.equal(sh(ws, `usernode_commit_leftovers '${start}' 'x'`).code, 0, 'a clean tree commits nothing');
  assert.equal(git(ws, 'log', '-1', '--format=%s'), 'Homeroom bot: #12');
});

// ── The push proxy's script (worker.buildPushScript) ──────────────────────

function runPushScript(ws, branch) {
  const r = spawnSync('bash', ['-c', worker.buildPushScript({ workspace: ws })], {
    env: { ...GIT_ENV, BRANCH: branch, PAT: 'unused-for-a-local-origin' }, encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}

test('the push heal pushes the stray branch\'s work and reports the commit it pushed (session 5030)', (t) => {
  const { ws, origin } = fixture(t);
  git(ws, 'checkout', '-q', '-b', 'wolf-mechanic');
  const wolf = commitFile(ws, 'wolf.js', 'wolf\n', 'Add the wolf');
  const r = runPushScript(ws, 'dev/me');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.split('\n').pop(), wolf);
  assert.equal(git(origin, 'rev-parse', 'refs/heads/dev/me'), wolf, 'GitHub has the wolf now');
});

test('the push heal never reports a commit it did not push', (t) => {
  const { ws, origin, mine, theirs } = fixture(t);
  git(ws, 'fetch', '-q', 'origin', 'dev/other');
  git(ws, 'checkout', '-q', '-b', 'borrowed', theirs);
  const stray = commitFile(ws, 'calm.js', 'calm\n', 'Calm mode');
  const r = runPushScript(ws, 'dev/me');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.split('\n').pop(), mine, 'the session branch, not HEAD');
  assert.notEqual(r.stdout.split('\n').pop(), stray);
  assert.equal(git(origin, 'rev-parse', 'refs/heads/dev/me'), mine);
});

// ── The runners, end to end ────────────────────────────────────────────────

function runnerEnv(t, ws, agentScript, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-branch-runner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\ncat > /dev/null\n${agentScript}\necho '{"type":"result","result":"done"}'\n`);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  const prompt = path.join(dir, 'prompt.txt');
  const system = path.join(dir, 'system.txt');
  fs.writeFileSync(prompt, 'build it');
  fs.writeFileSync(system, 'handbook');
  return {
    ...GIT_ENV,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    PROMPT_FILE: prompt, SYSTEM_PROMPT_FILE: system,
    SESSION_ID: '1', PLATFORM_URL: 'http://127.0.0.1:9', WORKER_JWT: 'jwt',
    MODE: 'build', BRANCH: 'dev/me', WORKSPACE_DIR: ws,
    BROWSER_MCP_CONFIG: path.join(dir, 'no-mcp.json'),
    INLOOP_PGDATA: path.join(dir, 'no-pgdata'),
    ...extra,
  };
}

function result(out) {
  const line = out.split('\n').find((l) => l.startsWith('__USERNODE_RESULT__')) || '';
  return Object.fromEntries(line.replace('__USERNODE_RESULT__ ', '').split(' ').map((kv) => kv.split('=')));
}

test('run-cc.sh: a build that committed on its own branch reports that commit, on the session branch', (t) => {
  const { ws } = fixture(t);
  const env = runnerEnv(t, ws, [
    'git checkout -q -b wolf-mechanic',
    'echo wolf > wolf.js && git add wolf.js && git commit -q -m "Add the wolf"',
    'echo png > page-1.png',
  ].join('\n'));
  const r = spawnSync('sh', [path.join(ROOT, 'worker', 'run-cc.sh')], { env, encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  const res = result(out);
  assert.match(out, /its commits were moved onto dev\/me/);
  assert.equal(git(ws, 'symbolic-ref', '--short', 'HEAD'), 'dev/me');
  assert.equal(res.sha, git(ws, 'rev-parse', 'dev/me'));
  assert.equal(git(ws, 'log', '-1', '--format=%s', 'dev/me'), 'Add the wolf');
  assert.equal(res.ahead, '2');
  assert.equal(res.branch_mismatch, undefined);
  assert.match(out, /Left out of the commit \(new files the agent did not commit\): page-1\.png/);
  // No push helper exists outside the image, so the push fails here; the
  // host's heal is what pushes it (buildPushScript above).
  assert.equal(res.push_ok, '0');
});

test('run-cc.sh: a build that ended on another line reports no changes and branch_mismatch=1', (t) => {
  const { ws } = fixture(t);
  const env = runnerEnv(t, ws, [
    'git checkout -q -b borrowed origin/main',
    'echo calm > calm.js && git add calm.js && git commit -q -m "Calm mode"',
  ].join('\n'));
  const r = spawnSync('sh', [path.join(ROOT, 'worker', 'run-cc.sh')], { env, encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  const res = result(out);
  assert.equal(res.branch_mismatch, '1');
  assert.equal(res.ahead, '0');
  assert.equal(res.sha, '');
  assert.equal(res.push_ok, '0');
  assert.match(out, /__USERNODE_WARN__ skipping push/);

  const state = worker.newWatchState();
  worker.parseLine(out.split('\n').find((l) => l.startsWith('__USERNODE_RESULT__')), () => {}, state);
  assert.equal(state.branchMismatch, true);
  assert.equal(state.ahead, 0);
});

test('run-codex-agent.sh settles the branch the same way', (t) => {
  const { ws } = fixture(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-branch-codex-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh
cat > /dev/null
git checkout -q -b wolf-mechanic
echo wolf > wolf.js && git add wolf.js && git commit -q -m "Add the wolf"
echo '{"type":"thread.started","thread_id":"t-1"}'
exit 0
`);
  fs.chmodSync(path.join(bin, 'codex'), 0o755);
  const prompt = path.join(dir, 'prompt.txt');
  fs.writeFileSync(prompt, 'build it');
  const env = {
    ...GIT_ENV,
    PATH: `${bin}:${process.env.PATH}`, HOME: dir,
    PROMPT_FILE: prompt, BRANCH: 'dev/me', MODE: 'build',
    WORKER_JWT: 'jwt', SESSION_ID: '1', PLATFORM_URL: 'http://127.0.0.1:9',
    OPENROUTER_API_KEY: 'sk-or-v1-test', OPENROUTER_API_BASE: 'https://openrouter.ai/api/v1',
    AGENT_MODEL: 'z-ai/glm-5.3-flash',
    WORKSPACE_DIR: ws, CODEX_HOME: path.join(dir, 'codex-home'),
    INLOOP_PGDATA: path.join(dir, 'no-pgdata'),
  };
  const r = spawnSync('sh', [path.join(ROOT, 'worker', 'run-codex-agent.sh')], { env, encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  assert.match(out, /its commits were moved onto dev\/me/, out);
  const res = result(out);
  assert.equal(res.sha, git(ws, 'rev-parse', 'dev/me'));
  assert.equal(git(ws, 'log', '-1', '--format=%s', 'dev/me'), 'Add the wolf');
});

// ── Wiring ─────────────────────────────────────────────────────────────────

test('the bootstrap and both runners use the library, and the image ships it', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const bootstrap = read('worker/worker-run.sh');
  assert.match(bootstrap, /git clone --single-branch --recurse-submodules --shallow-submodules "\$CLONE_URL" \./);
  assert.ok(bootstrap.indexOf('. "$(dirname "$0")/session-branch.sh"') > bootstrap.indexOf(': "${CLONE_URL'),
    'sourced below the prelude tests/worker-run-clone-error.test.js runs on its own');
  assert.equal((bootstrap.match(/FETCH_OUT="\$\(usernode_fetch_session_refs\)"/g) || []).length, 2,
    'both the cold clone and the existing checkout fetch the narrow set');
  assert.equal((bootstrap.match(/CHECKOUT_OUT="\$\(usernode_checkout_session_branch\)"/g) || []).length, 2,
    'and both check out the session branch explicitly');
  assert.doesNotMatch(bootstrap, /git fetch origin --quiet/);
  for (const runner of ['worker/run-cc.sh', 'worker/run-codex-agent.sh']) {
    const src = read(runner);
    assert.match(src, /\. "\$\(dirname "\$0"\)\/session-branch\.sh"/, runner);
    assert.match(src, /if ! usernode_fetch_session_refs; then/, runner);
    assert.match(src, /usernode_start_turn_on_session_branch clean_untracked/, runner);
    assert.match(src, /if usernode_settle_session_branch; then\n\s+usernode_commit_leftovers "\$TURN_START_SHA" "\$COMMIT_MSG"\nfi/, runner);
    assert.doesNotMatch(src, /git reset --hard "origin\/\$BRANCH"/, `${runner}: the old reset moved whatever branch HEAD was on`);
    assert.doesNotMatch(src, /^if \[ -n "\$\(git status --porcelain\)" \]; then\n\s+git add -A/m, runner);
    assert.match(src, /branch_mismatch=1/, runner);
  }
  assert.match(read('worker/Dockerfile'), /COPY session-branch\.sh \/usr\/local\/bin\/session-branch\.sh/);
});

test('a branch mismatch reaches chat as its own message, live and after a restart', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const sessions = read('src/routes/sessions.js');
  assert.match(sessions, /\} else if \(result\.branchMismatch\) \{[\s\S]{0,400}ended up working on a different branch that doesn't build on this change, `\n\s+\+ 'so nothing from this turn was saved\. Send your request again to redo it here\.';/);
  const server = read('server.js');
  assert.match(server, /\} else if \(result\.branchMismatch\) \{\n\s+summaryParts\.push\('The coding agent ended up working on a different branch/);
  const host = read('src/services/worker.js');
  assert.match(host, /else if \(k === 'branch_mismatch'\) state\.branchMismatch = v === '1';/);
  assert.match(host, /const inlineScript = buildPushScript\(\);/);
  assert.doesNotMatch(host, /'git rev-parse HEAD';/, 'the push never reports HEAD as the pushed commit');
});
