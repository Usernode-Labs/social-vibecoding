'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { supported } = require('../scripts/check-node-runtime');
const { excepted, npmFindings, imageFindings } = require('../scripts/security-findings');
const ownership = require('../worker/process-ownership');

test('image runtime policy rejects vulnerable patches and unreviewed major migrations', () => {
  for (const version of ['v22.23.4', '22.23.5', '22.24.0']) assert.equal(supported(version), true);
  for (const version of ['22.23.3', '22.17.1', '20.19.5', '24.22.1', '22.23.4-rc.1', 'bad']) assert.equal(supported(version), false);
  for (const file of ['Dockerfile', 'Dockerfile.kubernetes', 'worker/Dockerfile', 'capture/Dockerfile', 'src/services/template.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const stages = source.match(/^FROM node:.+$/gm);
    assert.ok(stages.length, file);
    for (const stage of stages) assert.match(stage, /^FROM node:22\.23\.4-(?:alpine|bookworm-slim)(?: AS \S+)?$/, file);
    assert.equal((source.match(/RUN npm install --global npm@11\.21\.1/g) || []).length, stages.length, file);
  }
});

test('security exceptions are exact, scoped to one advisory, and expire', () => {
  const now = Date.parse('2026-10-23');
  assert.equal(excepted('zod', '3.25.76', ['GHSA-mrhx-c7xc-m3w5'], now), true);
  assert.equal(excepted('zod', '3.25.75', ['GHSA-mrhx-c7xc-m3w5'], now), false);
  assert.equal(excepted('zod', '3.25.76', ['new-advisory'], now), false);
  assert.equal(excepted('zod', '3.25.76', ['CVE-2023-54404'], Date.parse('2026-11-22')), false);
  assert.equal(excepted('golang.org/x/net', 'v0.59.0', ['CVE-2026-78669'], now, undefined, 'worker'), false);
  assert.equal(excepted('golang.org/x/net', 'v0.59.0', ['CVE-2026-78669'], now, undefined, 'standalone'), true);
  assert.equal(excepted('golang.org/x/net', 'v0.59.0', ['CVE-2026-78669'], Date.parse('2026-10-30'), undefined, 'standalone'), false);
  const audit = { metadata: { vulnerabilities: {} }, vulnerabilities: { pkg: {
    nodes: ['node_modules/pkg'], via: [{ severity: 'critical', url: 'https://github.com/advisories/GHSA-new' }],
  } } };
  assert.deepEqual(npmFindings(audit, { packages: { 'node_modules/pkg': { version: '1.0.0' } } }, now), ['pkg@1.0.0: GHSA-new']);
  assert.throws(() => npmFindings({ error: 'offline' }, {}), /Invalid/);
  assert.throws(() => imageFindings({ SchemaVersion: 2, Results: [] }), /Empty/);
  const scan = { SchemaVersion: 2, Results: [{ Target: 'node', Vulnerabilities: [
    { Severity: 'HIGH', PkgName: 'pkg', InstalledVersion: '1', VulnerabilityID: 'CVE-new', FixedVersion: '2' },
  ] }] };
  assert.equal(imageFindings(scan, now).length, 1);
});

test('portable process metadata includes start time, user and command, including unusual Linux comm names', () => {
  const uid = process.getuid();
  const fields = Array(25).fill('0');
  fields[0] = 'S'; fields[1] = '2'; fields[2] = '42'; fields[19] = '123456';
  const fsImpl = { statSync: () => ({ uid }), readFileSync: (file) => file.endsWith('/stat')
    ? `42 (node (fixture)) ${fields.join(' ')}` : 'node\0server.js\0' };
  assert.deepEqual(ownership.readProcess(42, { platform: 'linux', fsImpl }), {
    pid: 42, ppid: 2, pgid: 42, uid, start: '123456', state: 'S', cmd: 'node server.js',
  });
  const command = 'node /a directory/server.js';
  const exec = (_file, _args, opts) => { assert.equal(opts.timeout, 1500); return `42 2 ${uid} 42 Fri Oct 23 20:00:00 2026 S ${command}\n`; };
  assert.deepEqual(ownership.readProcess(42, { platform: 'darwin', exec }), {
    pid: 42, ppid: 2, pgid: 42, uid, start: 'Fri Oct 23 20:00:00 2026', state: 'S', cmd: command,
  });
  assert.equal(ownership.readProcess(42, { platform: 'darwin', exec: () => { throw new Error('denied'); } }), null);
});

test('shutdown rechecks PID lifetime before escalation and refuses unreadable or foreign ownership', async () => {
  const record = { pid: 4242, uid: process.getuid(), start: 'original', cmd: 'node server.js', state: 'S' };
  const sent = [];
  let actual = record;
  const kill = (pid, signal) => { sent.push([pid, signal]); actual = { ...record, start: 'reused' }; };
  assert.equal(ownership.stopOwnedSync([record], { waitMs: 0, read: () => actual, kill }), 1);
  assert.deepEqual(sent, [[4242, 'SIGTERM']], 'never SIGKILL a PID that was reused during shutdown');
  assert.equal(await ownership.stopOwned([record], { waitMs: 0, read: () => null, kill }), 0);
  assert.equal(await ownership.stopOwned([{ ...record, uid: record.uid + 1 }], { waitMs: 0, read: () => record, kill }), 0);
  const stubborn = [];
  assert.equal(await ownership.stopOwned([record], { waitMs: 0, read: () => record, kill: (_p, sig) => stubborn.push(sig) }), 1);
  assert.deepEqual(stubborn, ['SIGTERM', 'SIGKILL']);
});

test('the real MCP SDK rejects oversized tool collections before schema validation and still accepts normal calls', async () => {
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { z } = require('zod');
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/mcp-remote.js'), 'utf8');
  assert.match(source, /maxToolInputElements: 10_000/);
  assert.match(source, /router\.post\(MCP_PATH, jsonBody\('512kb'\)/);
  let validated = 0;
  const server = new McpServer({ name: 'bounded-test', version: '1' }, { maxToolInputElements: 10_000 });
  server.tool('bounded', { values: z.array(z.string().superRefine(() => { validated += 1; })) }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const refused = await client.callTool({ name: 'bounded', arguments: { values: Array(10_001).fill('x') } });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /maximum of 10000 elements/);
    assert.equal(validated, 0, 'the bound applies before Zod expands validation issues');
    const accepted = await client.callTool({ name: 'bounded', arguments: { values: ['x', 'y'] } });
    assert.equal(accepted.isError, undefined);
    assert.equal(validated, 2);
  } finally { await client.close(); await server.close(); }
});

test('Express survives compressed frames with trailing data and ignores forged forwarding headers', async () => {
  const express = require('express');
  const http = require('node:http');
  const zlib = require('node:zlib');
  const app = express();
  app.set('trust proxy', false);
  app.use(express.json());
  app.post('/', (req, res) => res.json({ body: req.body, ip: req.ip }));
  app.use((err, _req, res, _next) => res.sendStatus(err.status || 400));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const send = (body, encoding) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', agent: false,
      headers: { 'content-type': 'application/json', 'content-encoding': encoding, 'x-forwarded-for': '203.0.113.9' } }, (res) => {
      let data = ''; res.on('data', (d) => { data += d; }); res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject); req.end(body);
  });
  try {
    for (const [encoding, compress] of [['gzip', zlib.gzipSync], ['deflate', zlib.deflateSync]]) {
      await send(Buffer.concat([compress(Buffer.from('{"ok":true}')), Buffer.from('invalid-trailing-frame')]), encoding);
    }
    const good = await send(Buffer.from('{"ok":true}'), 'identity');
    assert.equal(good.status, 200);
    assert.equal(JSON.parse(good.data).ip, '127.0.0.1');
    assert.match(fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8'), /app\.set\('trust proxy', false\)/);
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});

test('macOS listener inventory spares ancestors and foreign users and reads actual working directories', () => {
  const uid = process.getuid();
  const exec = (file, args) => {
    if (file === '/bin/ps') return [
      `10 1 ${uid} 10 Fri Oct 23 20:00:00 2026 S node hook.js`,
      `20 1 ${uid} 20 Fri Oct 23 20:00:00 2026 S node server.js`,
      `30 1 ${uid + 1} 30 Fri Oct 23 20:00:00 2026 S node server.js`,
    ].join('\n');
    if (args.includes('-iTCP')) return 'p10\np20\np30\n';
    assert.deepEqual(args.slice(0, 3), ['-a', '-p', '20']);
    return 'p20\nn/private/tmp/fixture with spaces\n';
  };
  const found = ownership.listeningProcesses({ platform: 'darwin', selfPid: 10, exec });
  assert.equal(found.spare.has(10), true);
  assert.deepEqual(found.procs.map((p) => [p.pid, p.cwd]), [[20, '/private/tmp/fixture with spaces']]);
});
