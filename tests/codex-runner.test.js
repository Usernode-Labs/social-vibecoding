'use strict';
// Runtime smoke test for worker/run-codex-agent.sh (review P5). Stubs a
// fake `codex` binary on PATH that emits authentic-shaped JSONL, runs the
// actual runner script, and asserts: prompt is read from the file (not a
// dead stdin), the thread id is extracted from thread.started and persists
// to the terminal result, and a fresh vs resume invocation are both correct.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const RUNNER = path.join(__dirname, '..', 'worker', 'run-codex-agent.sh');

function makeEnv(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runner-'));
  // fake codex on PATH
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const fake = path.join(bin, 'codex');
  fs.writeFileSync(fake, run);
  fs.chmodSync(fake, 0o755);
  // workspace + prompt
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const prompt = path.join(dir, 'prompt.txt');
  fs.writeFileSync(prompt, 'scout prompt');
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    PROMPT_FILE: prompt,
    BRANCH: 'smoke',
    MODE: 'scout',
    WORKER_JWT: 'jwt', SESSION_ID: '1', PLATFORM_URL: 'http://p',
    USERNODE_AGENT_TOKEN: 'tok', USERNODE_AGENT_RELAY: 'http://relay/v1',
    AGENT_MODEL: 'openai/gpt-5.3-codex',
    WORKSPACE_DIR: ws, CODEX_HOME: path.join(dir, 'codex-home'),
  };
  return { dir, env };
}

test('runner: fresh scout turn reads prompt, extracts thread id, completes', () => {
  const fakeCodex = `#!/bin/sh
# read stdin (the prompt) to prove it was delivered
while IFS= read -r _line; do :; done
echo '{"type":"thread.started","thread_id":"smoke-123"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","message":"DONE"}}'
exit 0
`;
  const { env } = makeEnv(fakeCodex);
  const r = spawnSync('sh', [RUNNER], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /codex \(mode scout\)/, 'invokes fresh codex exec');
  assert.match(r.stdout, /"thread_id":"smoke-123"/, 'streams codex JSONL');
  assert.match(r.stdout, /agent_thread_id=smoke-123/, 'persists extracted thread id in result');
  assert.match(r.stdout, /mode=scout agent_backend=codex_openrouter/, 'terminal scout result');
});

test('runner: resume that fails NOT thread-missing does NOT retry fresh', () => {
  const fakeCodex = `#!/bin/sh
while IFS= read -r _line; do :; done
echo '{"type":"error","message":"401 Unauthorized"}'
exit 1
`;
  const { env } = makeEnv(fakeCodex);
  env.AGENT_THREAD_ID = 'existing-thread';
  const r = spawnSync('sh', [RUNNER], { env, encoding: 'utf8' });
  // Should NOT retry fresh, and should emit a terminal result.
  assert.match(r.stdout, /codex \(resume existing-thread/, 'invokes codex resume');
  assert.match(r.stdout, /NOT retrying fresh/, 'does NOT retry fresh on non-thread-missing failure');
  assert.match(r.stdout, /mode=scout agent_backend=codex_openrouter .* agent_thread_id=/, 'terminal result emitted');
});

test('runner: resume that IS thread-missing retries fresh once', () => {
  const fakeCodex = `#!/bin/sh
while IFS= read -r _line; do :; done
echo '{"type":"error","message":"thread not found"}'
exit 1
`;
  const { env } = makeEnv(fakeCodex);
  env.AGENT_THREAD_ID = 'missing-thread';
  const r = spawnSync('sh', [RUNNER], { env, encoding: 'utf8' });
  assert.match(r.stdout, /retrying fresh/, 'retries fresh when thread missing');
  assert.match(r.stdout, /mode scout/, 'runs the fresh turn');
});
