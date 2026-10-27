'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Codex build turns receive the same pinned Playwright MCP surface as Claude builds', () => {
  const codex = fs.readFileSync(path.join(__dirname, '..', 'worker/run-codex-agent.sh'), 'utf8');
  const claude = fs.readFileSync(path.join(__dirname, '..', 'worker/run-cc.sh'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(__dirname, '..', 'worker/worker-run.sh'), 'utf8');
  assert.match(codex, /\[mcp_servers\.playwright\]/);
  assert.match(codex, /^command = "\/usr\/local\/bin\/mcp-server-playwright"$/m);
  assert.match(codex, /if \[ "\$MODE" = "build" \]/);
  assert.match(claude, /--strict-mcp-config/);
  assert.match(bootstrap, /"command": "\/usr\/local\/bin\/mcp-server-playwright"/);
  assert.doesNotMatch(codex, /if \[ "\$MODE" = "scout" \][\s\S]{0,300}\[mcp_servers\.playwright\]/);
});

test('worker image pins the browser server and installs its matching Chromium', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'worker/Dockerfile'), 'utf8');
  assert.match(dockerfile, /ARG PLAYWRIGHT_MCP_VERSION=0\.0\.41/);
  assert.match(dockerfile, /@playwright\/mcp@\$\{PLAYWRIGHT_MCP_VERSION\}/);
  assert.match(dockerfile, /npx playwright install --with-deps chromium/);
});

// App bench run 193: a Claude Code build's browser_evaluate waited 1,800 s
// (Claude Code's own limit on one MCP call) on a dialog nobody clicked. A
// build's MCP calls now stop at two minutes; scout keeps the default, and
// a limit already in the environment is kept.
function claudeEnvFor(mode, extra = {}) {
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-mcp-timeout-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const envLog = path.join(dir, 'env.log');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
printf '%s' "\${MCP_TOOL_TIMEOUT:-unset}" > "${envLog}"
cat >/dev/null
echo '{"type":"result","result":"ok","session_id":"cc-1"}'
exit 0
`);
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const prompt = path.join(dir, 'prompt.txt');
  fs.writeFileSync(prompt, 'task');
  const systemPrompt = path.join(dir, 'system.txt');
  fs.writeFileSync(systemPrompt, 'conventions');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    PROMPT_FILE: prompt, BRANCH: 'smoke', SESSION_ID: '1', PLATFORM_URL: 'http://platform',
    MODE: mode, WORKSPACE_DIR: ws, WORKER_JWT: 'jwt',
    ...(mode === 'build' ? { SYSTEM_PROMPT_FILE: systemPrompt } : {}),
    BROWSER_MCP_CONFIG: path.join(dir, 'none.json'), BROWSER_ONLY_MCP_CONFIG: path.join(dir, 'none.json'),
    HOMEROOM_MCP_CONFIG: path.join(dir, 'none.json'),
  };
  delete env.MCP_TOOL_TIMEOUT;
  delete env.HOMEROOM_MCP_TOKEN;
  Object.assign(env, extra);
  spawnSync('sh', [path.join(__dirname, '..', 'worker/run-cc.sh')], { env, encoding: 'utf8' });
  return fs.existsSync(envLog) ? fs.readFileSync(envLog, 'utf8') : null;
}

test('a Claude build\'s MCP calls stop after two minutes, as a Codex build\'s browser does after one', () => {
  assert.equal(claudeEnvFor('build'), '120000');
  assert.equal(claudeEnvFor('build', { MCP_TOOL_TIMEOUT: '45000' }), '45000', 'a limit already set is kept');
  assert.equal(claudeEnvFor('scout'), 'unset', 'scout keeps Claude Code\'s own limit');
  const codex = fs.readFileSync(path.join(__dirname, '..', 'worker/run-codex-agent.sh'), 'utf8');
  assert.match(codex, /\[mcp_servers\.playwright\][\s\S]{0,600}tool_timeout_sec = 60/);
});
