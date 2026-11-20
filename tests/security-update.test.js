'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const YAML = require('yaml');
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
    for (const stage of stages) assert.match(stage, /^FROM node:22\.23\.4-(?:alpine|trixie-slim)(?: AS \S+)?$/, file);
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
  assert.equal(excepted('golang.org/x/net', 'v0.59.0', ['CVE-2026-78669'], Date.parse('2026-11-12'), undefined, 'standalone'), true);
  assert.equal(excepted('golang.org/x/net', 'v0.59.0', ['CVE-2026-78669'], Date.parse('2026-11-13'), undefined, 'standalone'), false);
  assert.equal(excepted('decode-uri-component', '0.2.2', ['GHSA-qr28-fpjm-wq7f'], now), false);
  assert.equal(excepted('decode-uri-component', '0.2.3', ['GHSA-qr28-fpjm-wq7f'], now), false);
  assert.equal(excepted('decode-uri-component', '0.2.2', ['GHSA-qr28-fpjm-wq7f'], Date.parse('2026-11-28')), false);
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


test('the required security merge gate rejects incomplete or unsuccessful checks', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(__dirname, '../.github/workflows/kubernetes-pr-checks.yml'), 'utf8'));
  const required = require('../security/required-merge-checks.json');
  const lockfiles = workflow.jobs['security-lockfiles'];
  const images = workflow.jobs['security-images'];
  const gate = workflow.jobs['security-merge-gate'];
  assert.deepEqual(workflow.on, { pull_request: { branches: ['main'] } });
  assert.deepEqual(required, [gate.name, lockfiles.name,
    ...images.strategy.matrix.include.map(({ component }) => images.name.replace('${{ matrix.component }}', component))]);
  assert.deepEqual(gate.needs, ['security-lockfiles', 'security-images', 'security-regressions', 'preview-schema-compatibility']);
  assert.deepEqual(gate.permissions, {});
  assert.equal(gate.if, '${{ always() }}');
  for (const job of [lockfiles, images, gate]) {
    assert.equal(job['continue-on-error'], undefined);
    for (const step of job.steps) assert.equal(step['continue-on-error'], undefined);
  }
  const check = gate.steps[0];
  assert.deepEqual(check.env, {
    LOCKFILES_RESULT: '${{ needs.security-lockfiles.result }}',
    IMAGES_RESULT: '${{ needs.security-images.result }}',
    REGRESSIONS_RESULT: '${{ needs.security-regressions.result }}',
    DATABASE_RESULT: '${{ needs.preview-schema-compatibility.result }}',
  });
  const success = Object.fromEntries(Object.keys(check.env).map(key => [key, 'success']));
  const run = (results) => spawnSync('sh', ['-c', check.run], {
    encoding: 'utf8', env: { ...process.env, ...results },
  });
  assert.equal(run(success).status, 0);
  for (const key of Object.keys(success)) {
    for (const status of ['', 'pending', 'failure', 'cancelled', 'skipped', 'neutral', 'timed_out']) {
      const result = run({ ...success, [key]: status });
      assert.equal(result.status, 1, `${key}: ${status}`);
      assert.match(result.stdout, /All checks must succeed before merging/);
    }
  }
});

test('independent daily audits cover every image and publish data without issue-write permission', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(__dirname, '../.github/workflows/security-audit.yml'), 'utf8'));
  assert.equal(workflow.on.pull_request, undefined);
  assert.ok(workflow.on.schedule.length);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.jobs.scan.strategy.matrix.include.map((item) => item.component), ['platform', 'standalone', 'worker', 'capture', 'starter']);
  for (const job of Object.values(workflow.jobs)) assert.match(job.if, /github.ref == 'refs\/heads\/main'/);
  assert.equal(workflow.jobs.scan.permissions.issues, undefined);
  assert.deepEqual(workflow.jobs.report.permissions, { contents: 'read' });
  assert.deepEqual(workflow.jobs.report.needs, ['plan', 'scan']);
  assert.match(workflow.jobs.report.if, /always\(\).*!cancelled\(\)/, 'partial scans still publish discoveries, without resolving existing findings');
  for (const job of Object.values(workflow.jobs)) assert.equal(job.permissions?.issues, undefined);
  assert.doesNotMatch(JSON.stringify(workflow), /GH_TOKEN|SECURITY_ALERT_ASSIGNEE|security-alerts/);
  assert.equal(workflow.jobs.report.steps.find((s) => s.uses === 'actions/upload-artifact@v4').with.name,
    'homeroom-security-audit-${{ github.run_attempt }}');
  const scan = workflow.jobs.scan.steps.find((s) => s.name === 'Scan the complete image');
  assert.equal(scan.env.SECURITY_AUDIT_ONLY, '1');
  assert.equal(scan.env.LIVE_DIGEST, '${{ needs.plan.outputs[matrix.component] }}', 'all jobs share one release snapshot');
  assert.match(scan.run, /sh scripts\/check-published-image\.sh/);
  assert.match(scan.run, /sh scripts\/check-image-security\.sh/);
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  const upload = workflow.jobs.scan.steps.find((s) => s.uses === 'actions/upload-artifact@v4');
  const download = workflow.jobs.report.steps.find((s) => s.uses === 'actions/download-artifact@v4');
  assert.match(upload.with.name, /github\.run_attempt/);
  assert.match(download.with.pattern, /github\.run_attempt/, 'a retry cannot consume older clean artifacts');
});

test('release requires both the images and live database checks, with the full suite on pull requests', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(__dirname, '../.github/workflows/build-kubernetes-images.yml'), 'utf8'));
  const pr = YAML.parse(fs.readFileSync(path.join(__dirname, '../.github/workflows/kubernetes-pr-checks.yml'), 'utf8'));
  const database = YAML.parse(fs.readFileSync(path.join(__dirname, '../.github/workflows/kubernetes-database-checks.yml'), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['push', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.equal(workflow.jobs.plan.if, "github.ref == 'refs/heads/main'");
  assert.deepEqual(workflow.jobs.release.needs, ['build', 'preview-schema-compatibility']);
  assert.equal(workflow.jobs.release.if, undefined, 'GitHub requires all dependencies to succeed');
  assert.deepEqual(workflow.jobs.build.needs, ['plan']);
  const gate = workflow.jobs['preview-schema-compatibility'];
  assert.equal(gate.needs, 'plan');
  assert.equal(gate.if, "needs.plan.outputs.should_release == 'true'");
  assert.equal(gate.uses, './.github/workflows/kubernetes-database-checks.yml');
  assert.equal(gate.with, undefined);
  assert.equal(pr.jobs['preview-schema-compatibility'].uses, gate.uses);
  assert.deepEqual(pr.jobs['preview-schema-compatibility'].with, { full_suite: true });
  assert.equal(database.on.workflow_call.inputs.full_suite.default, false);
  const steps = database.jobs['preview-schema-compatibility'].steps;
  const twoServer = steps.find((step) => step.name === 'Verify database identities and tenant copies');
  assert.equal(twoServer.if, undefined);
  assert.match(twoServer.run, /tests\/database-role-split-postgres\.test\.js/);
  assert.match(twoServer.run, /tests\/platform-preview-data-policy-postgres\.test\.js/);
  assert.equal(steps.find((step) => step.run?.includes('tests/platform-signals-postgres.test.js')).if, 'inputs.full_suite');
  assert.equal(steps.find((step) => step.run?.includes('tests/private-streams-postgres.test.js')).if, 'inputs.full_suite');
  const rebuilds = steps.filter((step) => step.run?.includes('npm rebuild bcrypt'));
  assert.equal(rebuilds.length, 1);
  const restore = steps.find((step) => step.uses === 'actions/cache/restore@v6');
  const save = steps.find((step) => step.uses === 'actions/cache/save@v6');
  assert.ok(steps.indexOf(restore) < steps.indexOf(rebuilds[0]));
  assert.ok(steps.indexOf(rebuilds[0]) < steps.indexOf(twoServer));
  assert.match(rebuilds[0].run, /compareSync\('probe', b.hashSync\('probe', 4\)\)/);
  assert.equal(save.with.key, '${{ steps.bcrypt_binding.outputs.cache-primary-key }}');
  assert.match(save.if, /steps\.bcrypt_binding\.outputs\.cache-hit != 'true' && github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  const regressions = pr.jobs['security-regressions'].steps.find((step) => step.run?.includes('tests/build-stop-hook.test.js'));
  assert.match(regressions.run, /tests\/security-gate-baseline\.test\.js/);
  assert.match(regressions.run, /tests\/security-audit-report\.test\.js/);
});

test('visible-change arrays reject excessive lengths before Zod visits any elements', () => {
  const { parseIntent, VisibleChangesValidationError } = require('../src/services/visible-changes');
  const { intent } = require('./fixtures/shots');
  const oversized = (length) => {
    const values = Array(length);
    Object.defineProperty(values, 0, { get() { throw new Error('oversized element was visited'); } });
    return values;
  };
  const cases = [
    [4, ['stories'], (v, a) => { v.stories = a; }],
    [3, ['stories', '0', 'viewports'], (v, a) => { v.stories[0].viewports = a; }],
    [41, ['stories', '0', 'intent', 'steps'], (v, a) => { v.stories[0].intent.steps = a; }],
    [6, ['stories', '0', 'intent', 'hints', 'expectText'], (v, a) => { v.stories[0].intent.hints = { expectText: a }; }],
  ];
  for (const [length, expectedPath, assign] of cases) {
    const candidate = intent();
    assign(candidate, oversized(length));
    assert.throws(() => parseIntent(candidate), (err) => {
      assert.ok(err instanceof VisibleChangesValidationError);
      assert.deepEqual(err.issues, [{ path: expectedPath, message: `Array must contain at most ${length - 1} element(s)` }]);
      return true;
    });
  }
});

test('visible-change JSON under the HTTP byte limit is rejected within a bounded heap', () => {
  const script = `
    const assert = require('node:assert/strict');
    const { parseIntent, VisibleChangesValidationError } = require(process.argv[1]);
    const input = JSON.stringify({version:1, impact:'ui', rationale:'fixture', stories:Array(140000).fill({})});
    assert.ok(Buffer.byteLength(input) < 512 * 1024);
    assert.throws(() => parseIntent(JSON.parse(input)), err => err instanceof VisibleChangesValidationError
      && err.issues.length === 1 && err.issues[0].path.join('.') === 'stories');
    process.stdout.write('bounded');
  `;
  const result = spawnSync(process.execPath, ['--max-old-space-size=64', '-e', script,
    path.join(__dirname, '../src/services/visible-changes.js')], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.equal(result.stdout, 'bounded');
});


test('a stale launch cannot claim a newly reused orphan process group', () => {
  const uid = process.getuid();
  const root = { pid: 2000000000, pgid: 2000000000, uid, start: 'original', cmd: 'node old-wrapper.js', state: 'S' };
  const exec = (_file, args) => args.includes('-p') ? ''
    : `${root.pid + 1} 1 ${uid} ${root.pid} Fri Oct 23 20:00:00 2026 S node /another-workspace/server.js\n`;
  assert.deepEqual(ownership.processGroup(root, { platform: 'darwin', exec }), [],
    'no live original identity exists to authorize adopting these same-user group members');
});

// test:changed: when vendor/decode-uri-component (the patched dependency source)
const decoderRoot = path.join(__dirname, '..');
const decoder = createRequire(require.resolve('query-string')).resolve('decode-uri-component');

test('query-string uses the upstream patched decoder with only its export adapted', () => {
  const source = fs.readFileSync(decoder, 'utf8');
  const hash = (text) => createHash('sha256').update(text).digest('hex');
  assert.equal(hash(source), 'e82696ecdf0ee2c25bd90169cc7915e552d2ccb82a5006c55bc17aecdb55b919');
  const original = source.replace('module.exports = function decodeUriComponent', 'export default function decodeUriComponent');
  assert.equal(hash(original), '6a86ac891edf15c5efa0841ebb31935e3669d58b98318b57d7b08a4530317cb0');
  assert.equal(require('decode-uri-component'), require(decoder));
  assert.equal(require('../vendor/decode-uri-component/package.json').version, '0.5.1+homeroom.cjs.1');
  const lock = JSON.parse(fs.readFileSync(path.join(decoderRoot, 'package-lock.json')));
  assert.equal(Object.values(lock.packages).some((p) => p.version === '0.2.2' && /decode-uri-component/.test(p.resolved || '')), false);
  assert.match(fs.readFileSync(path.join(decoderRoot, 'vendor/decode-uri-component/LICENSE'), 'utf8'), /Copyright \(c\) 2017, Sam Verschueren/);
});

test('the advisory payload completes under a process deadline and is decoded only once', () => {
  // The old implementation takes tens of seconds for these 32,000 distinct
  // runs. A child deadline bounds that regression without relying on timing
  // ratios in the shared test process.
  const probe = `
    const assert = require('node:assert/strict');
    const decode = require(${JSON.stringify(decoder)});
    let payload = '';
    for (let i = 0; i < 32000; i++) {
      const high = Math.floor(i / 256).toString(16).padStart(2, '0');
      const low = (i % 256).toString(16).padStart(2, '0');
      payload += '%' + high + '%' + low + 'x';
    }
    payload += '%zz';
    const result = decode(payload);
    assert.equal(result.endsWith('%zz'), true);
    assert.equal(decode('%25%34%31%zz'), '%41%zz');
  `;
  const result = spawnSync(process.execPath, ['-e', probe], { timeout: 3000, killSignal: 'SIGKILL', encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('query-string retains valid and malformed Unicode decoding and encoding behavior', () => {
  const query = require('query-string');
  const decode = require(decoder);
  for (const [input, expected] of [['%C3%A5', 'å'], ['%F0%9F%98%80', '😀'], ['%FE%FF', '\uFFFD\uFFFD'],
    ['%C2', '\uFFFD'], ['%zz', '%zz'], ['%E0%A4%A', '%E0%A4%A'], ['%C0%AF', '%C0%AF']]) {
    assert.equal(decode(input), expected);
    assert.equal(query.parse(`value=${input}`).value, expected);
  }
  assert.equal(query.stringify({ label: 'hello å', key: ['a/b', 'x+y'] }), 'key=a%2Fb&key=x%2By&label=hello%20%C3%A5');
  assert.throws(() => decode(null), TypeError);
});

test('the real MinIO client can sign encoded object names with the patched dependency tree', async () => {
  const { Client } = require('minio');
  const client = new Client({ endPoint: '127.0.0.1', port: 9000, useSSL: false,
    accessKey: 'fixture-access', secretKey: 'fixture-secret-key', region: 'us-east-1' });
  const signed = new URL(await client.presignedGetObject('fixture-bucket', 'folder/hello å+%.txt', 60));
  assert.equal(signed.pathname, '/fixture-bucket/folder/hello%20%C3%A5%2B%25.txt');
  assert.equal(signed.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.equal(signed.searchParams.get('X-Amz-Expires'), '60');
  assert.match(signed.searchParams.get('X-Amz-Signature'), /^[a-f0-9]{64}$/);
});
