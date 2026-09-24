#!/usr/bin/env node
'use strict';

// Image-build regression: a production-mode self-app issues a Secure session
// cookie even though its private evidence origin is HTTP. Exercise the same
// bootstrap, saved storage state, proxy and MCP browser that the planner uses.
const { execFile, execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { verifyBrowser } = require('./verify-evidence-browser-mcp');

const execFileAsync = promisify(execFile);

function fixtureServer(side) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    const persona = url.searchParams.get('token') === 'member.jwt' ? 'member'
      : url.searchParams.get('token') === 'admin.jwt' ? 'admin' : null;
    if (persona) {
      response.setHeader('Set-Cookie', `session=${side}-${persona}; Path=/; HttpOnly; Secure; SameSite=Lax`);
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><h1>Token accepted</h1>');
      return;
    }
    const stored = /(?:^|;\s*)session=([^;]+)/.exec(request.headers.cookie || '')?.[1];
    const matched = stored === `${side}-member` ? 'member'
      : stored === `${side}-admin` ? 'admin' : null;
    response.statusCode = matched ? 200 : 401;
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><h1>${matched ? `Signed in as ${matched} on ${side}` : 'Sign in'}</h1>`);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve(server));
  });
}

async function waitForFile(file, child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fs.existsSync(file)) return;
    if (child.exitCode !== null) throw new Error('Evidence proxy exited before it became ready.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Evidence proxy did not become ready.');
}

async function main() {
  const address = Object.values(os.networkInterfaces()).flat()
    .find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address;
  if (!address) throw new Error('The browser-auth smoke needs a non-loopback container address.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-auth-smoke-'));
  const servers = [];
  let proxy = null;
  try {
    servers.push(await fixtureServer('base'), await fixtureServer('head'));
    const origins = [
      `http://${os.hostname()}:${servers[0].address().port}`,
      `http://${address}:${servers[1].address().port}`,
    ];
    const ready = path.join(dir, 'proxy.ready');
    proxy = spawn(process.execPath, [path.join(__dirname, 'evidence-origin-proxy.js')], {
      env: { ...process.env, EVIDENCE_ALLOWED_ORIGINS: JSON.stringify(origins),
        EVIDENCE_PROXY_PORT: '17891', EVIDENCE_PROXY_READY: ready },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let proxyError = '';
    proxy.stderr.on('data', (chunk) => { proxyError = (proxyError + chunk).slice(-1000); });
    await waitForFile(ready, proxy);
    const env = {
      ...process.env,
      EVIDENCE_ALLOWED_ORIGINS: JSON.stringify(origins),
      EVIDENCE_BASE_ORIGIN: origins[0], EVIDENCE_HEAD_ORIGIN: origins[1],
      EVIDENCE_PROXY_SERVER: `http://127.0.0.1:${fs.readFileSync(ready, 'utf8').trim()}`,
      EVIDENCE_BROWSER_STATE_DIR: path.join(dir, 'state'),
      EVIDENCE_MEMBER_TOKEN: 'member.jwt', EVIDENCE_ADMIN_TOKEN: 'admin.jwt',
    };
    await execFileAsync(process.execPath, [path.join(__dirname, 'evidence-browser-bootstrap.js')], {
      env, timeout: 90_000,
    });
    const configPath = path.join(dir, 'mcp.json');
    execFileSync(process.execPath, [path.join(__dirname, 'write-evidence-mcp-config.js'), configPath], { env });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    for (const [persona, serverName] of [
      ['member', 'browser_member'], ['admin', 'browser_admin'],
    ]) {
      const checks = origins.map((origin, index) => ({
        url: `${origin}/status`,
        expectedText: `Signed in as ${persona} on ${index === 0 ? 'base' : 'head'}`,
      }));
      try { await verifyBrowser(config.mcpServers[serverName], checks); }
      catch (error) {
        throw new Error(`${persona} browser failed (${error.message}); proxy exit=${proxy.exitCode}; ${proxyError}`);
      }
    }
    process.stdout.write('Both planner personas retained authenticated sessions on both private HTTP revisions.\n');
  } finally {
    if (proxy && proxy.exitCode === null) {
      proxy.kill('SIGTERM');
      await new Promise((resolve) => {
        proxy.once('exit', resolve);
        setTimeout(resolve, 1500).unref();
      });
    }
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
