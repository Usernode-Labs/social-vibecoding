'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const workerDir = path.join(__dirname, '..', 'worker');
const read = (name) => fs.readFileSync(path.join(workerDir, name), 'utf8');

test('both evidence backends launch Playwright through the content-free timing observer', () => {
  const dockerfile = read('Dockerfile');
  const claudeRunner = read('run-cc.sh');
  const codexRunner = read('run-codex-agent.sh');
  const command = 'node';

  assert.match(dockerfile, /npm install -g @playwright\/mcp@\$\{PLAYWRIGHT_MCP_VERSION\}/);
  assert.match(dockerfile, /command -v mcp-server-playwright/);
  assert.match(dockerfile, /RUN node \/usr\/local\/bin\/verify-evidence-browser-mcp\.js/);
  assert.match(claudeRunner, /command -v mcp-server-playwright[^\n]*\n\s*\|\| die/);
  assert.match(codexRunner, /command -v mcp-server-playwright[^\n]*\n\s*\|\| die/);
  assert.match(dockerfile, /COPY evidence-browser-observer\.js \/usr\/local\/bin\/evidence-browser-observer\.js/);
  assert.ok((codexRunner.match(/command = "node"/g) || []).length >= 2);
  assert.equal((codexRunner.match(/evidence-browser-observer\.js/g) || []).length, 2);
  assert.match(claudeRunner, /EVIDENCE_BROWSER_DIAGNOSTIC_FILE/);
  assert.match(codexRunner, /EVIDENCE_BROWSER_DIAGNOSTIC_FILE/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-config-test-'));
  try {
    const output = path.join(dir, 'mcp.json');
    execFileSync(process.execPath, [path.join(workerDir, 'write-evidence-mcp-config.js'), output], {
      env: {
        ...process.env,
        EVIDENCE_BROWSER_STATE_DIR: path.join(dir, 'state'),
        EVIDENCE_PROXY_SERVER: 'http://127.0.0.1:17891',
        EVIDENCE_BASE_ORIGIN: 'http://base.example.invalid',
        EVIDENCE_HEAD_ORIGIN: 'http://head.example.invalid',
      },
    });
    const config = JSON.parse(fs.readFileSync(output, 'utf8'));
    for (const [server, state] of [
      ['browser_member', 'member.json'],
      ['browser_admin', 'read_only_admin.json'],
    ]) {
      assert.equal(config.mcpServers[server].command, command);
      assert.equal(config.mcpServers[server].args[0], '/usr/local/bin/evidence-browser-observer.js');
      assert.ok(config.mcpServers[server].args.includes(path.join(dir, 'state', state)));
      assert.ok(config.mcpServers[server].args.includes('http://base.example.invalid;http://head.example.invalid'));
      assert.ok(config.mcpServers[server].args.includes('--no-sandbox'));
    }
    assert.equal((codexRunner.match(/"--no-sandbox"/g) || []).length, 3);
    assert.match(read('worker-run.sh'), /"--browser", "chromium", "--headless", "--isolated", "--no-sandbox"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
