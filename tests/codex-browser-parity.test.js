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
