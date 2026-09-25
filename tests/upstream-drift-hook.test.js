'use strict';

// The session-start checkout freshness check (.agents/hooks/upstream-drift.js)
// and its wiring into Claude Code, Codex and OpenCode. See AGENTS.md, "Check
// that this checkout is current before you read or write code".
//
// The failure it exists for: a session started on a fork whose `main` sat
// 1044 commits behind the canonical main answered a question from the stale
// code, because nothing in the checkout said so and the AGENTS.md rule was
// scoped to editing.
//
// Run with: node --test tests/upstream-drift-hook.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const drift = require('../.agents/hooks/upstream-drift');
const main = require('../src/cli/main');

const root = path.resolve(__dirname, '..');
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

// A scripted git: each entry answers one subcommand, and anything unlisted
// fails the test, so a check that reaches for the network when it should not
// is caught rather than silently answered.
function fakeGit(answers) {
  const calls = [];
  const git = async (args) => {
    calls.push(args[0]);
    const answer = answers[args[0]];
    assert.ok(answer, `unexpected git ${args.join(' ')}`);
    return typeof answer === 'function' ? answer(args) : answer;
  };
  return { git, calls };
}

const head = (sha) => ({ status: 0, stdout: `${sha}\n` });
const lsRemote = (sha) => ({ status: 0, stdout: `${sha}\trefs/heads/main\n` });
const behindGit = () => fakeGit({
  'rev-parse': head(OLD), 'ls-remote': lsRemote(NEW), 'merge-base': { status: 1, stdout: '' },
});

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── the check ───────────────────────────────────────────────────────────

test('a HEAD that contains the canonical main is current', async () => {
  const same = fakeGit({ 'rev-parse': head(NEW), 'ls-remote': lsRemote(NEW) });
  assert.equal((await drift.checkDrift({ cwd: '/x', git: same.git })).state, 'current');
  assert.deepEqual(same.calls, ['rev-parse', 'ls-remote'], 'equal SHAs need no ancestry walk');

  const ahead = fakeGit({
    'rev-parse': head(OLD), 'ls-remote': lsRemote(NEW), 'merge-base': { status: 0, stdout: '' },
  });
  assert.equal((await drift.checkDrift({ cwd: '/x', git: ahead.git })).state, 'current');
});

test('a HEAD without the canonical main is behind, whether or not the clone has seen it', async () => {
  for (const status of [1, 128]) {
    const { git } = fakeGit({
      'rev-parse': head(OLD), 'ls-remote': lsRemote(NEW), 'merge-base': { status, stdout: '' },
    });
    assert.deepEqual(await drift.checkDrift({ cwd: '/x', git }),
      { state: 'behind', headSha: OLD, upstreamSha: NEW }, `merge-base exit ${status}`);
  }
});

test('anything it cannot establish is unknown, never behind', async () => {
  const cases = {
    'not a repository': { 'rev-parse': { status: 128, stdout: '' } },
    'offline or timed out': { 'rev-parse': head(OLD), 'ls-remote': { status: null, stdout: '' } },
    'no main on the remote': { 'rev-parse': head(OLD), 'ls-remote': { status: 0, stdout: '' } },
    'a garbled answer': { 'rev-parse': head(OLD), 'ls-remote': { status: 0, stdout: 'nope\trefs/heads/main\n' } },
    'ancestry timed out': {
      'rev-parse': head(OLD), 'ls-remote': lsRemote(NEW), 'merge-base': { status: null, stdout: '' },
    },
  };
  for (const [name, answers] of Object.entries(cases)) {
    const { git } = fakeGit(answers);
    assert.equal((await drift.checkDrift({ cwd: '/x', git })).state, 'unknown', name);
  }
});

test('real git: behind until the clone fast-forwards to the canonical main', async (t) => {
  const dir = tempDir(t, 'upstream-drift-');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull };
  const run = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  const commit = (cwd, message) => run(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', message);
  const upstream = path.join(dir, 'upstream');
  const fork = path.join(dir, 'fork');
  fs.mkdirSync(upstream);
  run(upstream, 'init', '-q', '-b', 'main');
  commit(upstream, 'one');
  run(dir, 'clone', '-q', upstream, fork);
  commit(upstream, 'two');
  const check = () => drift.checkDrift({ cwd: fork, repo: upstream });

  assert.equal((await check()).state, 'behind', 'the fork has never seen the new commit');
  run(fork, 'fetch', '-q', 'origin');
  assert.equal((await check()).state, 'behind', 'seen but not contained');
  run(fork, 'merge', '-q', '--ff-only', 'origin/main');
  assert.equal((await check()).state, 'current');
  commit(fork, 'local work');
  assert.equal((await check()).state, 'current', 'a branch ahead of main is current');
});

// ── the hook ────────────────────────────────────────────────────────────

test('SessionStart puts the notice in front of the agent only when HEAD is behind', async () => {
  const result = await drift.processHook(
    { hook_event_name: 'SessionStart', cwd: '/checkout' }, { env: {}, git: behindGit().git }
  );
  assert.equal(result.hookSpecificOutput.hookEventName, 'SessionStart');
  const text = result.hookSpecificOutput.additionalContext;
  assert.ok(text.includes(NEW), 'names the canonical main it compared against');
  assert.ok(text.includes('git fetch https://github.com/Usernode-Labs/social-vibecoding main'));
  assert.match(text, /FETCH_HEAD/);
  assert.match(text, /prepare_work/);
  assert.match(text, /proposal_start/);
  assert.match(text, /never merge or rebase onto upstream main yourself/);
  assert.ok(text.length <= 1200, 'fits the Codex additionalContextLimit');

  const current = fakeGit({ 'rev-parse': head(NEW), 'ls-remote': lsRemote(NEW) });
  assert.equal(await drift.processHook(
    { hook_event_name: 'SessionStart', cwd: '/checkout' }, { env: {}, git: current.git }
  ), null);
});

test('the opt-out, other events and bad input are silent without running git', async () => {
  const { git, calls } = fakeGit({});
  const optedOut = { [drift.OPT_OUT_ENV]: 'off' };
  assert.equal(await drift.processHook({ hook_event_name: 'SessionStart' }, { env: optedOut, git }), null);
  assert.equal(await drift.processHook({ hook_event_name: 'PreToolUse' }, { env: {}, git }), null);
  assert.equal(await drift.processHook(null, { env: {}, git }), null);
  assert.equal(await drift.noticeFor({ cwd: '/x', env: optedOut, git }), null);
  assert.deepEqual(calls, []);
});

test('Codex UserPromptSubmit runs the check on the first prompt of a session only', async (t) => {
  const markerDir = tempDir(t, 'upstream-drift-markers-');
  const prompt = (sessionId, git) => drift.processHook(
    { hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd: '/checkout' },
    { env: {}, git, markerDir }
  );

  const first = behindGit();
  const result = await prompt('s1', first.git);
  assert.equal(result.hookSpecificOutput.hookEventName, 'UserPromptSubmit');

  const second = behindGit();
  assert.equal(await prompt('s1', second.git), null);
  assert.deepEqual(second.calls, ['rev-parse'], 'no network call after the first prompt');

  assert.ok(await prompt('s2', behindGit().git), 'a new session checks again');
  const moved = fakeGit({
    'rev-parse': head('c'.repeat(40)), 'ls-remote': lsRemote(NEW), 'merge-base': { status: 1, stdout: '' },
  });
  assert.ok(await prompt('s1', moved.git), 'so does the same session once HEAD moves');

  const anonymous = fakeGit({});
  assert.equal(await drift.processHook(
    { hook_event_name: 'UserPromptSubmit', cwd: '/checkout' }, { env: {}, git: anonymous.git, markerDir }
  ), null);
});

test('the OpenCode plugin appends the notice to the system prompt once', async () => {
  const plugin = drift.createOpenCodeUpstreamDrift({ worktree: '/checkout' }, { env: {}, git: behindGit().git });
  const output = { system: ['base prompt'] };
  await plugin['experimental.chat.system.transform']({ sessionID: 's' }, output);
  assert.match(output.system[0], /^base prompt\n\nCheckout freshness: /);
  const once = output.system[0];
  await plugin['experimental.chat.system.transform']({ sessionID: 's' }, output);
  assert.equal(output.system[0], once);

  const empty = { system: [] };
  await plugin['experimental.chat.system.transform']({ sessionID: 's' }, empty);
  assert.equal(empty.system.length, 1);

  const current = drift.createOpenCodeUpstreamDrift({ worktree: '/checkout' }, {
    env: {}, git: fakeGit({ 'rev-parse': head(NEW), 'ls-remote': lsRemote(NEW) }).git,
  });
  const untouched = { system: ['base prompt'] };
  await current['experimental.chat.system.transform']({ sessionID: 's' }, untouched);
  assert.deepEqual(untouched.system, ['base prompt']);

  assert.deepEqual(drift.createOpenCodeUpstreamDrift({ worktree: 'relative' }), {});
});

// ── the wiring ──────────────────────────────────────────────────────────

test('Claude Code runs the check at session start from the committed project settings', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  const [group] = settings.hooks.SessionStart;
  assert.equal(group.matcher, undefined, 'every source: startup, resume, clear and compact');
  const [hook] = group.hooks;
  assert.equal(hook.type, 'command');
  assert.equal(hook.command, 'node "$CLAUDE_PROJECT_DIR/.agents/hooks/upstream-drift.js"');
  assert.ok(hook.timeout > 4 && hook.timeout <= 10, 'outlasts the ls-remote timeout, never stalls a start');
});

test('OpenCode loads the check through a plugin link to the canonical adapter', () => {
  const link = path.join(root, '.opencode', 'plugins', 'upstream-drift.js');
  assert.equal(fs.readlinkSync(link), '../../.agents/hooks/opencode-upstream-drift.js');
  const shim = fs.readFileSync(path.join(root, '.agents', 'hooks', 'opencode-upstream-drift.js'), 'utf8');
  assert.match(shim, /export const UsernodeUpstreamDrift = async/);
  assert.match(shim, /createOpenCodeUpstreamDrift/);
  assert.doesNotMatch(shim, /\bthrow\b/, 'advisory: never fails the plugin load');
});

test('Codex setup pins the check as a second UserPromptSubmit hook that fails open', () => {
  const options = {
    nodePath: '/usr/bin/node',
    scriptPath: '/checkout/tools/social-vibecoding',
    checkoutRoot: '/checkout',
    profile: 'production',
    forwardEnv: false,
    hookSha256: 'a'.repeat(64),
    driftHookSha256: 'c'.repeat(64),
  };
  const document = main.setupToml(options);
  assert.equal(document.match(/^\[\[hooks\.UserPromptSubmit\.hooks\]\]$/gm).length, 2);
  const commands = document.split('\n').filter((line) => line.startsWith('command = '));
  const driftCommand = commands.find((line) => line.includes('upstream-drift.js'));
  assert.ok(driftCommand, 'the drift hook is wired');
  assert.ok(driftCommand.includes('/checkout/.agents/hooks/upstream-drift.js'));
  assert.ok(driftCommand.includes('c'.repeat(64)), 'pinned to the reviewed file');
  assert.ok(driftCommand.includes('Checkout freshness check skipped'));
  assert.ok(!driftCommand.includes('exit(2)'), 'a changed or broken check never blocks the prompt');
  const promotionCommand = commands.find((line) => line.includes('promotion-approval.js'));
  assert.ok(promotionCommand.includes('exit(2)'), 'the promotion guard still fails closed');
  assert.match(document, /additionalContextLimit = 1200/);

  assert.throws(() => main.setupToml({ ...options, driftHookSha256: undefined }), /Freshness check hook SHA-256/);
});

test('hosted workers opt out: the harness fixes their base commit', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'worker', 'Dockerfile'), 'utf8');
  const optOut = dockerfile.search(/^ENV SOCIAL_VIBECODING_DRIFT_CHECK=off$/m);
  assert.ok(optOut > 0);
  assert.ok(optOut > dockerfile.lastIndexOf('\nFROM '), 'set in the final image stage');
});
