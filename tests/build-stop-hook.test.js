'use strict';

// The stop guard: a Claude Code Stop hook (worker/build-stop-hook.js) that
// run-cc.sh installs for the Homeroom bot's build turns (STOP_GUARD=1), so an
// agent that tries to end a turn having changed nothing is sent back to work,
// twice at most.
//
// In production about half of the bot's "the build produced no change to
// propose" failures were GLM 5.3 Flash answering in text after a command or
// two (runs 138, 435, 533, 673 and 1166, each 10 to 34 seconds), which in
// Claude Code ends the turn. These pin:
//
//   - the hook's decision, as a function: nothing changed blocks; a commit or
//     an uncommitted edit allows; the third stop allows; anything unknown
//     (no start commit, no counter, git failing) allows;
//   - the hook as Claude Code runs it, against real git repositories;
//   - run-cc.sh: the hook only for a build that asked for it, the count read
//     back onto the result line, and the platform's parse of that line into
//     the turn's telemetry_metrics.
//
// Which turns ask for it (only the bot's build and review-fix turns) is
// pinned with the bot's own dispatch in tests/homeroom-bot-claude-harness.test.js.
//
// Run with: node --test tests/build-stop-hook.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const hook = require('../worker/build-stop-hook');
const worker = require('../src/services/worker');
const llmTelemetry = require('../src/services/llm-telemetry');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'worker', 'build-stop-hook.js');
const RUN_CC = path.join(ROOT, 'worker', 'run-cc.sh');
const START = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_TERMINAL_PROMPT: '0',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── The decision ────────────────────────────────────────────────────────

test('a turn that has changed nothing is sent back to work, with a plain reason', () => {
  const verdict = hook.decide({ startSha: START, blocks: 0, head: START, dirty: false });
  assert.equal(verdict.block, true);
  assert.equal(verdict.reason, hook.REASON);
  assert.match(hook.REASON, /^You have not changed anything in this repository yet/);
  assert.match(hook.REASON, /The plan is approved: make the change here now and check that it works/);
  assert.match(hook.REASON, /Do not stop to summarize, plan or ask/);
  // The bot is told not to commit (build-contract.js harnessCommits); the
  // reason does not contradict that.
  assert.match(hook.REASON, /You do not need to commit: your working tree is committed\s+and pushed for you/);
  assert.doesNotMatch(hook.REASON, /\u2014/, 'no em dashes');
  assert.deepEqual(JSON.parse(hook.hookOutput(verdict)), { decision: 'block', reason: hook.REASON });
});

test('a commit, or an edit the harness will commit, lets the turn end', () => {
  assert.deepEqual(hook.decide({ startSha: START, blocks: 0, head: OTHER, dirty: false }), { block: false, why: 'committed' });
  assert.deepEqual(hook.decide({ startSha: START, blocks: 0, head: START, dirty: true }), { block: false, why: 'uncommitted' });
  assert.equal(hook.hookOutput(hook.decide({ startSha: START, blocks: 0, head: OTHER })), '', 'an allowed stop prints nothing');
});

test('it blocks twice in a turn at most', () => {
  assert.equal(hook.MAX_BLOCKS, 2);
  assert.equal(hook.decide({ startSha: START, blocks: 1, head: START, dirty: false }).block, true);
  assert.deepEqual(hook.decide({ startSha: START, blocks: 2, head: START, dirty: false }), { block: false, why: 'cap' });
  assert.deepEqual(hook.decide({ startSha: START, blocks: 7, head: START, dirty: false }), { block: false, why: 'cap' });
});

test('anything it does not know lets the turn end', () => {
  const cases = [
    [{}, 'no_start'],
    [{ startSha: '', blocks: 0, head: START, dirty: false }, 'no_start'],
    [{ startSha: 'not-a-sha', blocks: 0, head: START, dirty: false }, 'no_start'],
    [{ startSha: START, blocks: null, head: START, dirty: false }, 'no_count'],
    [{ startSha: START, blocks: -1, head: START, dirty: false }, 'no_count'],
    [{ startSha: START, blocks: 0, head: null, dirty: false }, 'no_head'],
    [{ startSha: START, blocks: 0, head: START, dirty: null }, 'no_status'],
  ];
  for (const [facts, why] of cases) assert.deepEqual(hook.decide(facts), { block: false, why }, JSON.stringify(facts));
  assert.deepEqual(hook.decide(), { block: false, why: 'no_start' });
});

// runGuard with its git and file system faked: what it reads, in what
// order, and that a block is counted before it is made.
function fakeFs(initial) {
  const files = new Map(Object.entries(initial || {}));
  return {
    files,
    writeFileSync(file, text) { files.set(file, String(text)); },
  };
}

test('runGuard counts a block before making it, and never makes one it could not count', () => {
  const dir = tmp('stop-guard-unit-');
  const count = path.join(dir, 'blocks');
  const env = { USERNODE_STOP_GUARD_START: START, USERNODE_STOP_GUARD_COUNT: count, USERNODE_STOP_GUARD_REPO: dir };
  const asked = [];
  const git = (args) => { asked.push(args[0]); return args[0] === 'rev-parse' ? `${START}\n` : ''; };

  const first = hook.runGuard({ env, git });
  assert.equal(first.block, true);
  assert.equal(first.blocks, 1);
  assert.equal(fs.readFileSync(count, 'utf8'), '1');
  assert.deepEqual(asked, ['rev-parse', 'status']);
  assert.equal(hook.runGuard({ env, git }).block, true);
  assert.equal(fs.readFileSync(count, 'utf8'), '2');
  asked.length = 0;
  assert.deepEqual(hook.runGuard({ env, git }), { block: false, why: 'cap' });
  assert.deepEqual(asked, [], 'once capped, git is not asked');

  // A counter it cannot write: no block.
  fs.rmSync(count);
  const unwritable = { writeFileSync() { throw Object.assign(new Error('EROFS'), { code: 'EROFS' }); } };
  assert.deepEqual(hook.runGuard({ env, git, fsImpl: unwritable }), { block: false, why: 'no_count' });
  // A counter it cannot read: no block.
  fs.writeFileSync(count, 'garbage');
  assert.deepEqual(hook.runGuard({ env, git }), { block: false, why: 'no_count' });
});

test('runGuard reads the status only when HEAD has not moved, and fails open on git', () => {
  const dir = tmp('stop-guard-unit-');
  const env = { USERNODE_STOP_GUARD_START: START, USERNODE_STOP_GUARD_COUNT: path.join(dir, 'blocks'), USERNODE_STOP_GUARD_REPO: dir };
  const asked = [];
  const moved = hook.runGuard({ env, git: (args) => { asked.push(args[0]); return `${OTHER}\n`; } });
  assert.deepEqual(moved, { block: false, why: 'committed' });
  assert.deepEqual(asked, ['rev-parse']);

  assert.deepEqual(hook.runGuard({ env, git: () => null }), { block: false, why: 'no_head' }, 'git failed');
  assert.deepEqual(hook.runGuard({ env, git: (args) => (args[0] === 'rev-parse' ? START : null) }), { block: false, why: 'no_status' });
  assert.deepEqual(hook.runGuard({ env, git: () => { throw new Error('boom'); } }), { block: false, why: 'error' });
  assert.deepEqual(hook.runGuard({ env, git: (args) => (args[0] === 'rev-parse' ? START : ' M app.js\n') }), { block: false, why: 'uncommitted' });
  assert.equal(fs.existsSync(path.join(dir, 'blocks')), false, 'nothing counted when nothing was blocked');
});

test('without the turn\'s start commit or counter (any turn run-cc.sh did not set it up for), it allows', () => {
  const git = () => { throw new Error('git must not be needed'); };
  assert.deepEqual(hook.runGuard({ env: {}, git }), { block: false, why: 'no_count' });
  assert.deepEqual(hook.runGuard({ env: { USERNODE_STOP_GUARD_COUNT: '/nonexistent/blocks' }, git }), { block: false, why: 'no_start' });
});

test('the settings run-cc.sh passes to `claude --settings` install it as a Stop hook', () => {
  const settings = hook.settingsFor('/usr/local/bin/build-stop-hook.js');
  assert.deepEqual(settings, {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'node "/usr/local/bin/build-stop-hook.js"', timeout: 10 }] }],
    },
  });
  const printed = spawnSync(process.execPath, [HOOK, '--settings'], { encoding: 'utf8' });
  assert.equal(printed.status, 0);
  assert.deepEqual(JSON.parse(printed.stdout), hook.settingsFor(HOOK));
});

// ── The hook as Claude Code runs it ─────────────────────────────────────

// A repository on one commit, and the env run-cc.sh gives the hook.
function hookRepo() {
  const dir = tmp('stop-guard-repo-');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'app.js'), 'console.log(1);\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const env = {
    ...process.env,
    USERNODE_STOP_GUARD_START: git(repo, 'rev-parse', 'HEAD'),
    USERNODE_STOP_GUARD_COUNT: path.join(dir, 'blocks'),
    USERNODE_STOP_GUARD_REPO: repo,
  };
  return { dir, repo, env };
}

// Claude Code's call: the Stop input on stdin, the verdict on stdout.
function callHook(env, input = { hook_event_name: 'Stop', stop_hook_active: false }) {
  const started = Date.now();
  const out = spawnSync(process.execPath, [HOOK], {
    env, input: JSON.stringify({ session_id: 's', transcript_path: '/dev/null', cwd: env.USERNODE_STOP_GUARD_REPO, ...input }),
    encoding: 'utf8', timeout: 10_000,
  });
  return { status: out.status, stdout: out.stdout.trim(), ms: Date.now() - started };
}

test('the hook blocks a turn with nothing changed twice, then lets it end, quickly', () => {
  const { dir, env } = hookRepo();
  const first = callHook(env);
  assert.equal(first.status, 0);
  assert.deepEqual(JSON.parse(first.stdout), { decision: 'block', reason: hook.REASON });
  const second = callHook(env, { hook_event_name: 'Stop', stop_hook_active: true });
  assert.equal(second.status, 0);
  assert.equal(JSON.parse(second.stdout).decision, 'block');
  const third = callHook(env, { hook_event_name: 'Stop', stop_hook_active: true });
  assert.deepEqual([third.status, third.stdout], [0, ''], 'the cap lets it end');
  assert.equal(fs.readFileSync(path.join(dir, 'blocks'), 'utf8'), '2');
  for (const call of [first, second, third]) assert.ok(call.ms < 3000, `the hook took ${call.ms} ms`);
});

test('the hook lets a turn end once it has edited a file, or committed', () => {
  const edited = hookRepo();
  fs.appendFileSync(path.join(edited.repo, 'app.js'), 'console.log(2);\n');
  assert.deepEqual([callHook(edited.env).status, callHook(edited.env).stdout], [0, '']);

  const added = hookRepo();
  fs.writeFileSync(path.join(added.repo, 'new.js'), 'x\n');
  assert.equal(callHook(added.env).stdout, '', 'a new file counts');

  const committed = hookRepo();
  fs.writeFileSync(path.join(committed.repo, 'new.js'), 'x\n');
  git(committed.repo, 'add', '-A');
  git(committed.repo, 'commit', '-q', '-m', 'work');
  assert.equal(callHook(committed.env).stdout, '');
  for (const r of [edited, added, committed]) assert.equal(fs.existsSync(path.join(r.dir, 'blocks')), false);
});

test('an ignored file is not a change: the harness would commit nothing', () => {
  const { repo, env } = hookRepo();
  fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), 'node_modules/\n');
  fs.mkdirSync(path.join(repo, 'node_modules'));
  fs.writeFileSync(path.join(repo, 'node_modules', 'x.js'), 'x\n');
  assert.equal(JSON.parse(callHook(env).stdout).decision, 'block');
});

test('the hook fails open: no setup, no repository, or an input that never ends', async () => {
  const { dir, env } = hookRepo();
  // Not a bot build: run-cc.sh set nothing up.
  const bare = { ...process.env };
  delete bare.USERNODE_STOP_GUARD_START;
  delete bare.USERNODE_STOP_GUARD_COUNT;
  delete bare.USERNODE_STOP_GUARD_REPO;
  assert.deepEqual([callHook(bare).status, callHook(bare).stdout], [0, '']);
  // The workspace is not a repository (or git is gone).
  const notRepo = tmp('stop-guard-norepo-');
  assert.deepEqual([callHook({ ...env, USERNODE_STOP_GUARD_REPO: notRepo }).status, callHook({ ...env, USERNODE_STOP_GUARD_REPO: notRepo }).stdout], [0, '']);
  assert.deepEqual([callHook({ ...env, PATH: '/nonexistent' }).status, callHook({ ...env, PATH: '/nonexistent' }).stdout], [0, '']);
  // A counter that is not a number.
  fs.writeFileSync(path.join(dir, 'blocks'), 'x');
  assert.equal(callHook(env).stdout, '');
  fs.rmSync(path.join(dir, 'blocks'));
  // Claude Code never closes stdin: the hook still answers, within a second.
  const started = Date.now();
  const child = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.on('data', (c) => { stdout += c; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).decision, 'block');
  assert.ok(Date.now() - started < 3000, `answered in ${Date.now() - started} ms`);
});

// ── run-cc.sh ───────────────────────────────────────────────────────────

// A stand-in for the claude CLI that runs the Stop hook its --settings name
// the way Claude Code does: on each attempt to end the turn, the hook's
// command with the Stop input on stdin; a "block" continues the turn (up to
// Claude Code's own eight in a row), anything else ends it. STUB_WORK says
// what the "agent" does: nothing, commit at once, or edit a file once it
// has been sent back.
const STUB_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
const { execSync, spawnSync } = require('child_process');
const args = process.argv.slice(2);
fs.readFileSync(0, 'utf8');
const work = process.env.STUB_WORK || '';
const record = { args, env: {
  start: process.env.USERNODE_STOP_GUARD_START || null,
  count: process.env.USERNODE_STOP_GUARD_COUNT || null,
  repo: process.env.USERNODE_STOP_GUARD_REPO || null,
}, hooks: [] };
if (work === 'commit') {
  fs.writeFileSync('feature.js', 'x\\n');
  execSync('git add -A && git commit -q -m feature');
}
const at = args.indexOf('--settings');
if (at >= 0) {
  record.settings = args[at + 1];
  const settings = JSON.parse(fs.readFileSync(args[at + 1], 'utf8'));
  const command = settings.hooks.Stop[0].hooks[0].command;
  let active = false;
  for (let n = 0; n < 8; n += 1) {
    const ran = spawnSync('sh', ['-c', command], {
      input: JSON.stringify({ session_id: 'cc-1', hook_event_name: 'Stop', stop_hook_active: active, cwd: process.cwd() }),
      encoding: 'utf8',
    });
    const out = (ran.stdout || '').trim();
    const verdict = out ? JSON.parse(out) : null;
    record.hooks.push(verdict ? verdict.decision : null);
    if (!verdict || verdict.decision !== 'block') break;
    active = true;
    if (work === 'after_first_block') fs.writeFileSync('made.js', 'made\\n');
  }
}
fs.writeFileSync(process.env.STUB_LOG, JSON.stringify(record));
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cc-1' }));
console.log(JSON.stringify({ type: 'result', is_error: false, result: 'done', session_id: 'cc-1', usage: { input_tokens: 1, output_tokens: 1 } }));
`;

const BRANCH = 'dev/homeroom_bot-5001';

// A bare origin with main and the session branch, a workspace cloned from
// it, and the claude stand-in on PATH.
function runnerFixture() {
  const dir = tmp('stop-guard-runcc-');
  const origin = path.join(dir, 'origin.git');
  const seed = path.join(dir, 'seed');
  const ws = path.join(dir, 'ws');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, seed);
  fs.writeFileSync(path.join(seed, 'app.js'), 'console.log(1);\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main', `HEAD:refs/heads/${BRANCH}`);
  git(dir, 'clone', '-q', '-b', BRANCH, origin, ws);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), STUB_CLAUDE);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  const prompt = path.join(dir, 'prompt.txt');
  fs.writeFileSync(prompt, 'Build issue #12');
  return { dir, ws, bin, prompt, log: path.join(dir, 'claude.json'), start: git(ws, 'rev-parse', 'HEAD') };
}

// run-cc.sh as worker.js dispatches a bot build on GLM (AGENT_PROVIDER=
// openrouter, so through the request adapter, which starts the stand-in
// with this env), its output written to the turn's journal.
function runRunCc(fx, extra = {}) {
  const journal = path.join(fx.dir, 'turn.log');
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', 'sh "$RUNNER" > "$TURN_JOURNAL" 2>&1'], {
      env: {
        ...GIT_ENV,
        PATH: `${fx.bin}:${process.env.PATH}`,
        HOME: fx.dir,
        RUNNER: RUN_CC,
        TURN_JOURNAL: journal,
        PROMPT_FILE: fx.prompt,
        WORKSPACE_DIR: fx.ws,
        MODE: 'build',
        BRANCH,
        SESSION_ID: '5001',
        PLATFORM_URL: 'http://127.0.0.1:1',
        WORKER_JWT: 'test-worker-jwt',
        AGENT_PROVIDER: 'openrouter',
        OPENROUTER_API_KEY: 'sk-or-v1-stop-guard-test-key',
        OPENROUTER_API_BASE: 'http://127.0.0.1:1/api/v1',
        AGENT_MODEL: 'z-ai/glm-5.3-flash',
        MODEL: 'z-ai/glm-5.3-flash',
        DISCARD_FAILED_TURN: '1',
        STOP_GUARD: '1',
        BROWSER_MCP_CONFIG: path.join(fx.dir, 'absent-browser-mcp.json'),
        HOMEROOM_MCP_CONFIG: path.join(fx.dir, 'absent-homeroom-mcp.json'),
        INLOOP_PGDATA: path.join(fx.dir, 'absent-pgdata'),
        STUB_LOG: fx.log,
        ...extra,
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('close', (code) => resolve({
      code,
      out: fs.readFileSync(journal, 'utf8'),
      claude: fs.existsSync(fx.log) ? JSON.parse(fs.readFileSync(fx.log, 'utf8')) : null,
    }));
  });
}

const resultLine = (out) => out.split('\n').find((l) => l.startsWith('__USERNODE_RESULT__')) || '';

test('run-cc.sh: an agent that quits at once is sent back twice, and the count reaches the turn\'s telemetry', async () => {
  const fx = runnerFixture();
  const ran = await runRunCc(fx);
  assert.equal(ran.code, 0, ran.out);
  const { args, env, hooks, settings } = ran.claude;
  assert.ok(args.includes('--settings'), 'claude is handed the hook');
  assert.deepEqual(hooks, ['block', 'block', null], 'blocked twice, then allowed');
  // The hook reached through the request adapter's child environment.
  assert.equal(env.start, fx.start);
  assert.equal(fs.realpathSync(env.repo), fs.realpathSync(fx.ws));
  assert.match(resultLine(ran.out), / ahead=0 .*mode=build stop_hook_blocks=2$/);
  assert.match(ran.out, /__USERNODE_WARN__ The agent tried to end its turn having changed nothing; the stop guard sent it back to work \(stop_hook_blocks=2\)/);
  assert.equal(fs.existsSync(settings), false, 'the turn\'s settings and counter are removed');

  // The platform reads the field off the result line into the turn's metrics.
  const state = worker.newWatchState();
  assert.equal(state.stopHookBlocks, null);
  for (const line of ran.out.split('\n')) worker.parseLine(line, () => {}, state);
  assert.equal(state.stopHookBlocks, 2);
  assert.equal(llmTelemetry.normalizeDiagnostics(state).stop_hook_blocks, 2);
  assert.equal('stop_hook_blocks' in llmTelemetry.normalizeDiagnostics(worker.newWatchState()), false,
    'a turn without the guard records nothing, not a zero');
});

test('run-cc.sh: an agent sent back that then edits a file is let go, and its edit is committed', async () => {
  const fx = runnerFixture();
  const ran = await runRunCc(fx, { STUB_WORK: 'after_first_block' });
  assert.equal(ran.code, 0, ran.out);
  assert.deepEqual(ran.claude.hooks, ['block', null]);
  assert.match(resultLine(ran.out), / ahead=1 .*stop_hook_blocks=1$/);
  assert.equal(git(fx.ws, 'show', '--name-only', '--format=', 'HEAD'), 'made.js');
});

test('run-cc.sh: an agent that commits is never blocked', async () => {
  const fx = runnerFixture();
  const ran = await runRunCc(fx, { STUB_WORK: 'commit' });
  assert.equal(ran.code, 0, ran.out);
  assert.deepEqual(ran.claude.hooks, [null]);
  assert.match(resultLine(ran.out), / ahead=1 .*stop_hook_blocks=0$/);
  assert.doesNotMatch(ran.out, /stop guard sent it back/);
});

test('run-cc.sh: no hook for a build that did not ask, or for a scout', async () => {
  const unasked = runnerFixture();
  const plain = await runRunCc(unasked, { STOP_GUARD: '' });
  assert.equal(plain.code, 0, plain.out);
  assert.equal(plain.claude.args.includes('--settings'), false);
  assert.deepEqual(plain.claude.env, { start: null, count: null, repo: null });
  assert.doesNotMatch(resultLine(plain.out), /stop_hook_blocks/);

  const scout = runnerFixture();
  const read = await runRunCc(scout, { MODE: 'scout', WORKER_JWT: '' });
  assert.equal(read.code, 0, read.out);
  assert.equal(read.claude.args.includes('--settings'), false);
  assert.doesNotMatch(resultLine(read.out), /stop_hook_blocks/);
});

test('run-cc.sh: a guard that cannot be set up leaves the build running without it', async () => {
  const fx = runnerFixture();
  // The hook script missing beside the runner: copy the runner somewhere
  // that has session-branch.sh and the adapter but not the hook.
  const alone = path.join(fx.dir, 'runner');
  fs.mkdirSync(alone);
  for (const f of ['run-cc.sh', 'session-branch.sh', 'claude-openrouter-request.js', 'agent-api-failure.js', 'start-inloop-db.sh']) {
    fs.copyFileSync(path.join(ROOT, 'worker', f), path.join(alone, f));
  }
  const ran = await runRunCc(fx, { RUNNER: path.join(alone, 'run-cc.sh') });
  assert.equal(ran.code, 0, ran.out);
  assert.match(ran.out, /__USERNODE_WARN__ the stop guard could not be set up; this build runs without it/);
  assert.equal(ran.claude.args.includes('--settings'), false);
  assert.match(resultLine(ran.out), /mode=build$/);
});

test('every claude invocation of a build carries the guard\'s flags, and the image ships the hook', () => {
  const cc = fs.readFileSync(RUN_CC, 'utf8');
  const invocations = cc.match(/run_claude --print \$PERMISSION_FLAGS \$BROWSER_MCP_FLAGS \$SYSTEM_PROMPT_FLAGS --verbose \$STOP_GUARD_FLAGS \\/g) || [];
  assert.equal(invocations.length, 3, 'resume, its fresh retry, and a fresh run');
  // Sync stays as it was.
  const sync = cc.slice(cc.indexOf('if [ "$MODE" = "sync" ]; then'), cc.indexOf('# ── end MODE=sync'));
  assert.doesNotMatch(sync, /STOP_GUARD/);
  assert.match(cc, /if \[ "\$MODE" = "build" \] && \[ "\$\{STOP_GUARD:-\}" = "1" \]; then/);
  const dockerfile = fs.readFileSync(path.join(ROOT, 'worker', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY build-stop-hook\.js \/usr\/local\/bin\/build-stop-hook\.js/);
});
