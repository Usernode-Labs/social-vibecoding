// `social-vibecoding agent run|status|detach` (#907) — the local half.
//
// The two properties worth a test that will fail loudly if someone
// "simplifies" this file later:
//
//   1. No credential crosses in either direction. This process never reads a
//      Claude Code credential and never forwards one; the platform never
//      sends one.
//   2. No push access is needed or used. Commits go up as a file-by-file
//      upload the platform reconstructs through its own GitHub App, so the
//      CLI must never run `git push`.
//
// Everything else here is protocol mechanics: the stop signal arrives as a
// 409 on a progress post, commits upload oldest-first, and the process always
// detaches on the way out.
//
// Run with: node --test tests/cli-agent-run.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const agent = require('../src/cli/agent-command');
const claudeCode = require('../src/cli/agent-runtimes/claude-code');

const root = path.join(__dirname, '..');
const agentSource = fs.readFileSync(path.join(root, 'src/cli/agent-command.js'), 'utf8');
const runtimeSource = fs.readFileSync(
  path.join(root, 'src/cli/agent-runtimes/claude-code.js'), 'utf8'
);

function fakeIo() {
  const out = [];
  const err = [];
  return { out: (s) => out.push(s), err: (s) => err.push(s), stdout: out, stderr: err };
}

// Records every call and answers from a queue keyed by path fragment.
function fakeApi(routes = {}) {
  const calls = [];
  return {
    calls,
    async call(method, pathname, body, opts) {
      calls.push({ method, pathname, body, opts });
      for (const [fragment, answer] of Object.entries(routes)) {
        if (pathname.includes(fragment)) {
          const value = typeof answer === 'function' ? answer(calls.length, body) : answer;
          return { ok: value.status < 400, status: value.status, data: value.data || null };
        }
      }
      return { ok: true, status: 200, data: {} };
    },
  };
}

// ── The two invariants ─────────────────────────────────────────────────────

test('the CLI never reads a Claude Code credential, from anywhere', () => {
  for (const [name, source] of [['agent-command', agentSource], ['runtime', runtimeSource]]) {
    for (const forbidden of [
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      '.credentials.json',
      'security find-generic-password',
      'keychain',
    ]) {
      // The runtime adapter's header names these deliberately, as the list of
      // things it must not do. Only actual code may not mention them.
      const code = source.split('\n')
        .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
        .join('\n');
      assert.equal(code.includes(forbidden), false,
        `${name} must not reference ${forbidden} outside its comments`);
    }
  }
});

test('the CLI never pushes — commits reach the branch through the GitHub App', () => {
  assert.equal(/'push'/.test(agentSource), false, 'no git push argv');
  assert.equal(/git push/.test(agentSource.replace(/^\s*\/\/.*$/gm, '')), false);
  assert.match(agentSource, /collectCommitUpload/);
  assert.match(agentSource, /\/commit`/);
});

test('the runtime spawns the local binary and passes the prompt on stdin', () => {
  // A dispatch prompt (conventions + spec doc) routinely exceeds the 128 KiB
  // single-argument limit, which is why it cannot be an argv string.
  assert.match(runtimeSource, /child\.stdin\.end\(prompt/);
  assert.equal(runtimeSource.includes('shell: true'), false, 'never spawn through a shell');
  assert.match(runtimeSource, /'--print', '--verbose', '--output-format', 'stream-json'/);
});

test('the local runtime is safe-by-default, with the worker\'s posture opt-in', () => {
  assert.equal(claudeCode.DEFAULT_PERMISSION_MODE, 'acceptEdits');
  // This is someone's own laptop with their own files on it, not a disposable
  // container — --dangerously-skip-permissions must be asked for by name.
  assert.match(agentSource, /'--dangerously-skip-permissions'/);
  assert.match(agentSource, /skipPermissions = options\.dangerously_skip_permissions === true/);
});

// ── Protocol mechanics ─────────────────────────────────────────────────────

test('a 409 on a progress post is the stop signal, and it aborts the child', async () => {
  const api = fakeApi({ '/progress': { status: 409, data: { error: 'turn_not_running' } } });
  const reporter = agent.progressReporter(api, { turnId: '11', leaseId: '7' });
  assert.equal(reporter.signal.aborted, false);
  for (let i = 0; i < agent.PROGRESS_FLUSH_LINES; i += 1) reporter.add(`line ${i}`);
  await reporter.done();
  assert.equal(reporter.state.stopped, true);
  assert.equal(reporter.signal.aborted, true, 'the runtime adapter watches this signal');
});

test('a dropped progress post never fails the turn', async () => {
  const api = {
    calls: 0,
    async call() { this.calls += 1; throw new Error('network down'); },
  };
  const reporter = agent.progressReporter(api, { turnId: '11', leaseId: '7' });
  reporter.add('still working');
  await reporter.done(); // must not reject
  assert.equal(reporter.state.stopped, false, 'a network blip is not a stop');
});

test('progress is batched rather than one request per line', async () => {
  const api = fakeApi({ '/progress': { status: 204 } });
  const reporter = agent.progressReporter(api, { turnId: '11', leaseId: '7' });
  for (let i = 0; i < 5; i += 1) reporter.add(`line ${i}`);
  await reporter.done();
  assert.equal(api.calls.length, 1);
  assert.deepEqual(api.calls[0].body.lines.length, 5);
  assert.equal(api.calls[0].body.leaseId, '7');
});

test('a stopped turn posts no result — the platform already owns that row', async () => {
  const api = fakeApi({
    '/accept': { status: 200, data: {} },
    '/progress': { status: 409, data: { error: 'turn_not_running' } },
  });
  const io = fakeIo();
  const runtime = {
    RUNTIME_ID: 'claude-code',
    async run({ onProgress }) {
      for (let i = 0; i < agent.PROGRESS_FLUSH_LINES; i += 1) onProgress(`l${i}`);
      // Let the flush land, the way a real child does when it is killed.
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      return { exitCode: 143, isError: true, summary: '', stderr: '' };
    },
  };
  await agent.runOneTurn(api, { turnId: '11', prompt: 'go' }, {
    repo: root, leaseId: '7', runtime, binary: 'claude',
  }, io);
  assert.equal(api.calls.some((c) => c.pathname.includes('/result')), false);
  assert.equal(api.calls.some((c) => c.pathname.includes('/commit')), false);
  assert.match(io.stdout.join(''), /stopped from the web page/i);
});

test('a turn the machine can no longer claim is skipped, not crashed on', async () => {
  const api = fakeApi({ '/accept': { status: 409, data: { error: 'turn_not_offered' } } });
  const io = fakeIo();
  let ran = false;
  await agent.runOneTurn(api, { turnId: '11', prompt: 'go' }, {
    repo: root, leaseId: '7', binary: 'claude',
    runtime: { RUNTIME_ID: 'claude-code', async run() { ran = true; return {}; } },
  }, io);
  assert.equal(ran, false, 'never spend the user\'s subscription on a turn we do not hold');
  assert.match(io.stderr.join(''), /no longer waiting/i);
});

test('error codes are translated into something a person can act on', () => {
  const cases = {
    lease_held: /Detach it from Settings/,
    insufficient_scope: /social-vibecoding login/,
    tree_mismatch: /nothing was pushed/,
    lease_lost: /re-attach/i,
    session_not_attachable: /no longer taking coding turns/,
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.match(agent.describeError({ status: 409, data: { error: code } }), expected, code);
  }
  // An unknown code still says something, rather than "undefined".
  assert.equal(agent.describeError({ status: 500, data: {} }), 'HTTP 500');
  assert.equal(agent.describeError({ status: 503, data: { error: 'weird' } }), 'weird');
});

test('the label defaults to a bounded, single-segment hostname', () => {
  const label = agent.defaultLabel();
  assert.ok(label.length >= 1 && label.length <= 64);
  assert.equal(label.includes('.'), false, 'a FQDN is noise in a chat status line');
  // The server-side validator has to accept whatever this produces.
  assert.equal(require('../src/services/local-agent').isValidLabel(label), true);
});

test('run always detaches, even when the poll loop throws', () => {
  // A machine that exits without releasing its lease blocks the session for
  // the full TTL. The detach lives in a finally for exactly that reason.
  const runBlock = agentSource.slice(
    agentSource.indexOf('async function agentRun'),
    agentSource.indexOf('async function agentStatus')
  );
  const finallyBlock = runBlock.slice(runBlock.lastIndexOf('} finally {'));
  assert.match(finallyBlock, /\/api\/cli\/agent\/detach/);
  assert.match(finallyBlock, /clearInterval\(heartbeat\)/);
  assert.match(finallyBlock, /removeListener\('SIGINT'/);
});

test('the poll deadline is longer than the server\'s own long-poll window', () => {
  const localAgent = require('../src/services/local-agent');
  assert.ok(agent.POLL_DEADLINE_MS > localAgent.LONG_POLL_MS,
    'the server should answer its own poll, not have the client time it out');
  assert.equal(agent.HEARTBEAT_MS, localAgent.HEARTBEAT_MS);
});

test('agent run validates its session id before touching the network', async () => {
  const io = fakeIo();
  const deps = {
    parseOptions: () => ({ options: { session: '0' }, positional: [] }),
    state: { async selectedProfile() { throw new Error('should not be reached'); } },
    async authorizedToken() { throw new Error('should not be reached'); },
  };
  await assert.rejects(
    () => agent.agentCommand(['run'], io, deps),
    /canonical positive session ID/
  );
});

test('an unknown runtime is refused by name', async () => {
  const io = fakeIo();
  const deps = {
    parseOptions: () => ({ options: { session: '42', runtime: 'codex' }, positional: [] }),
    state: { async selectedProfile() { throw new Error('unreachable'); } },
    async authorizedToken() { throw new Error('unreachable'); },
  };
  await assert.rejects(() => agent.agentCommand(['run'], io, deps), /Unknown runtime 'codex'/);
});

test('agent detach insists on a canonical lease id', async () => {
  const io = fakeIo();
  const deps = {
    parseOptions: (args, allowed) => {
      assert.ok(allowed.has('--lease'));
      return { options: { lease: '007' }, positional: [] };
    },
    state: { async selectedProfile() { throw new Error('unreachable'); } },
    async authorizedToken() { throw new Error('unreachable'); },
  };
  await assert.rejects(() => agent.agentCommand(['detach'], io, deps), /canonical positive lease ID/);
});

test('an unknown subcommand shows the group usage', async () => {
  await assert.rejects(() => agent.agentCommand(['frobnicate'], fakeIo(), {}),
    /agent run\|status\|detach/);
});

// ── main.js wiring ─────────────────────────────────────────────────────────

test('the boolean flags parse as flags, not as options missing a value', () => {
  const main = require('../src/cli/main');
  assert.ok(main.VALUELESS_OPTIONS.has('--once'));
  assert.ok(main.VALUELESS_OPTIONS.has('--dangerously-skip-permissions'));
  const { options } = main.parseOptions(
    ['--session', '42', '--once'],
    new Set(['--session', '--once'])
  );
  assert.equal(options.session, '42');
  assert.equal(options.once, true);
});

test('a pre-#907 credential fails up front, not forty minutes into a poll', () => {
  const mainSource = fs.readFileSync(path.join(root, 'src/cli/main.js'), 'utf8');
  const fn = mainSource.slice(
    mainSource.indexOf('async function authorizedToken'),
    mainSource.indexOf('async function authorizedToken') + 2000
  );
  assert.match(fn, /REQUIRED_SCOPES/);
  assert.match(agentSource, /authorizedToken/);
  // agent run calls it before attach, so an old grant re-prompts for consent
  // immediately instead of after the first turn arrives.
  const runBlock = agentSource.slice(
    agentSource.indexOf('async function agentRun'),
    agentSource.indexOf('async function agentStatus')
  );
  assert.ok(
    runBlock.indexOf('authorizedToken(profile') < runBlock.indexOf('/api/cli/agent/attach'),
    'authorize before attaching'
  );
});

test('the agent commands are documented in the CLI usage text', () => {
  const mainSource = fs.readFileSync(path.join(root, 'src/cli/main.js'), 'utf8');
  for (const line of ['agent run', 'agent status', 'agent detach']) {
    assert.ok(mainSource.includes(line), `usage must mention \`${line}\``);
  }
});
