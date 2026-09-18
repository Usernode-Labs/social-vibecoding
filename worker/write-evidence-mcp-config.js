#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const output = process.argv[2];
const stateDir = process.env.EVIDENCE_BROWSER_STATE_DIR;
const proxy = process.env.EVIDENCE_PROXY_SERVER;
const origins = [process.env.EVIDENCE_BASE_ORIGIN, process.env.EVIDENCE_HEAD_ORIGIN]
  .map((value) => new URL(value).origin);
if (!output || !stateDir || !proxy || new Set(origins).size !== 2) {
  throw new Error('Evidence MCP config inputs are incomplete.');
}
const browserArgs = (persona) => [
  '--browser', 'chromium', '--headless', '--isolated',
  '--storage-state', path.join(stateDir, `${persona}.json`),
  '--allowed-origins', origins.join(';'),
  '--block-service-workers', '--image-responses', 'allow',
  '--proxy-server', proxy,
  '--timeout-action', '10000', '--timeout-navigation', '30000',
];
const config = {
  mcpServers: {
    evidence: { command: 'node', args: ['/usr/local/bin/evidence-mcp.js'] },
    browser_member: { command: 'playwright-mcp', args: browserArgs('member') },
    browser_admin: { command: 'playwright-mcp', args: browserArgs('read_only_admin') },
  },
};
fs.writeFileSync(output, `${JSON.stringify(config)}\n`, { mode: 0o600 });
