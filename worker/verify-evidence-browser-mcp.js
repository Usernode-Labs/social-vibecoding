#!/usr/bin/env node
'use strict';

// Image-build smoke test for the exact browser MCP command and flags used by
// evidence turns. A Chromium launch alone cannot catch a missing MCP binary:
// Claude and Codex would start without browser tools and fail much later.

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REQUIRED_TOOLS = [
  'browser_navigate', 'browser_navigate_back', 'browser_snapshot',
  'browser_take_screenshot', 'browser_click', 'browser_type',
  'browser_fill_form', 'browser_press_key', 'browser_select_option',
  'browser_hover', 'browser_drag', 'browser_resize', 'browser_wait_for',
  'browser_console_messages', 'browser_network_requests', 'browser_tabs',
  'browser_close',
];

function listTools(server) {
  return new Promise((resolve, reject) => {
    const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    let settled = false;
    const finish = (error, tools) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      if (error) reject(error);
      else resolve(tools);
    };
    const timeout = setTimeout(() => finish(new Error('Browser MCP did not list tools within 15 seconds.')), 15_000);
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => finish(new Error(`Browser MCP exited before listing tools (${code}): ${errors.slice(0, 500)}`)));
    child.stdin.on('error', (error) => finish(error));
    child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-2000); });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 1_000_000) return finish(new Error('Browser MCP output exceeded the smoke-test limit.'));
      let end;
      while ((end = output.indexOf('\n')) !== -1) {
        const line = output.slice(0, end);
        output = output.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== 2) continue;
        if (message.error) return finish(new Error(`Browser MCP tools/list failed: ${JSON.stringify(message.error).slice(0, 500)}`));
        return finish(null, message.result?.tools || []);
      }
    });
    for (const message of [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'evidence-image-smoke', version: '1' },
      } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]) child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-mcp-smoke-'));
  try {
    const stateDir = path.join(dir, 'state');
    fs.mkdirSync(stateDir);
    for (const persona of ['member', 'read_only_admin']) {
      fs.writeFileSync(path.join(stateDir, `${persona}.json`), '{"cookies":[],"origins":[]}');
    }
    const output = path.join(dir, 'mcp.json');
    execFileSync(process.execPath, [path.join(__dirname, 'write-evidence-mcp-config.js'), output], {
      env: {
        ...process.env,
        EVIDENCE_BROWSER_STATE_DIR: stateDir,
        EVIDENCE_PROXY_SERVER: 'http://127.0.0.1:17891',
        EVIDENCE_BASE_ORIGIN: 'http://base.example.invalid',
        EVIDENCE_HEAD_ORIGIN: 'http://head.example.invalid',
      },
    });
    const config = JSON.parse(fs.readFileSync(output, 'utf8'));
    for (const persona of ['browser_member', 'browser_admin']) {
      const tools = await listTools(config.mcpServers[persona]);
      const names = new Set(tools.map((tool) => tool.name));
      const missing = REQUIRED_TOOLS.filter((name) => !names.has(name));
      if (missing.length) throw new Error(`${persona} is missing browser tools: ${missing.join(', ')}`);
      process.stdout.write(`${persona}: ${tools.length} MCP tools available\n`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
