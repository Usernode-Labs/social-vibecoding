'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StdioClientTransport,
} = require('@modelcontextprotocol/sdk/client/stdio.js');
const { makeAccessToken } = require('../src/services/cli-auth');
const {
  CLIENT_ID,
  REQUIRED_SCOPES,
} = require('../src/services/cli-auth-constants');

test('every protected MCP API checks local readiness before credential lookup', () => {
  const source = require('node:fs').readFileSync(
    require.resolve('../src/cli/main'),
    'utf8'
  );
  const apiRequest = source.slice(
    source.indexOf('async function mcpApiRequest'),
    source.indexOf("server.registerTool('social_vibecoding.login_status'")
  );
  const whoami = source.slice(
    source.indexOf("server.registerTool('social_vibecoding.whoami'"),
    source.indexOf('const apiErrorSchema')
  );
  for (const [label, route] of [['generic API', apiRequest], ['whoami', whoami]]) {
    const readiness = route.indexOf('localProfileReady(profile)');
    const credential = route.indexOf('resolvedCredential(profile)');
    assert.ok(readiness >= 0 && readiness < credential, `${label} checks local health first`);
  }
});

test('MCP initializes without credentials and returns the external login contract', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-cli-mcp-'));
  await fs.chmod(home, 0o700);
  const checkout = path.resolve(__dirname, '..');
  const launcher = path.join(checkout, 'tools', 'social-vibecoding');
  const bootstrap = [
    "const os = require('node:os');",
    'const original = os.userInfo();',
    'os.userInfo = () => ({ ...original, homedir: process.argv[1] });',
    "const path = require('node:path');",
    "const { main } = require(path.join(process.argv[2], 'src/cli/main'));",
    "main(['mcp', '--profile', 'production'], {",
    "  launcherPath: path.join(process.argv[2], 'tools/social-vibecoding')",
    '}).then((code) => { process.exitCode = code; });',
  ].join('\n');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['-e', bootstrap, home, checkout],
    cwd: checkout,
    // Make the optional Linux native-store executable definitively
    // unavailable so this clean test account exercises the file fallback.
    env: { PATH: '/definitively-unavailable-for-cli-mcp-test' },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const client = new Client({ name: 'cli-mcp-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
    assert.deepEqual([...byName.keys()].sort(), [
      'social_vibecoding.api_read',
      'social_vibecoding.api_write',
      'social_vibecoding.login_status',
      'social_vibecoding.proposal_append_context',
      'social_vibecoding.proposal_promote',
      'social_vibecoding.proposal_start',
      'social_vibecoding.proposal_status',
      'social_vibecoding.proposal_submit_build',
      'social_vibecoding.whoami',
    ]);
    for (const [name, tool] of byName) {
      const mutating = name === 'social_vibecoding.api_write'
        || name === 'social_vibecoding.proposal_start'
        || name === 'social_vibecoding.proposal_append_context'
        || name === 'social_vibecoding.proposal_submit_build'
        || name === 'social_vibecoding.proposal_promote';
      assert.equal(tool.annotations.readOnlyHint, !mutating);
      assert.equal(tool.annotations.destructiveHint, mutating);
      assert.equal(tool.annotations.openWorldHint, false);
      assert.ok(tool.outputSchema);
    }

    const status = await client.callTool({
      name: 'social_vibecoding.login_status',
      arguments: {},
    });
    assert.equal(status.structuredContent.status, 'missing');
    assert.equal(status.structuredContent.profile, 'production');

    const whoami = await client.callTool({
      name: 'social_vibecoding.whoami',
      arguments: {},
    });
    assert.equal(whoami.isError, true);
    assert.equal(whoami.structuredContent.code, 'login_required');
    assert.equal(whoami.structuredContent.profile, 'production');
    assert.equal(whoami.structuredContent.retryable, true);
    assert.deepEqual(whoami.structuredContent.argv, [
      await fs.realpath(process.execPath),
      await fs.realpath(launcher),
      'login',
      '--profile',
      'production',
    ]);
    assert.equal(whoami.structuredContent.cwd, await fs.realpath(checkout));
    assert.doesNotMatch(JSON.stringify(whoami), /svcli_|svdev_/);

    const api = await client.callTool({
      name: 'social_vibecoding.api_read',
      arguments: { path: '/api/apps' },
    });
    assert.equal(api.isError, true);
    assert.equal(api.structuredContent.code, 'login_required');
    assert.equal(api.structuredContent.profile, 'production');
    assert.deepEqual(api.structuredContent.argv, [
      await fs.realpath(process.execPath),
      await fs.realpath(launcher),
      'login',
      '--profile',
      'production',
    ]);
    assert.doesNotMatch(stderr, /svcli_|svdev_/);
  } finally {
    await client.close().catch(() => {});
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('generic MCP API calls classify 429 and 5xx responses as retryable service errors', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-cli-mcp-transient-'));
  await fs.chmod(home, 0o700);
  const directory = path.join(home, '.config', 'social-vibecoding');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const checkout = path.resolve(__dirname, '..');
  const token = makeAccessToken();
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/api/apps');
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const status = calls === 1 ? 429 : 503;
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    if (status === 429) res.setHeader('Retry-After', '7');
    res.end(JSON.stringify({ error: status === 429 ? 'rate_limited' : 'temporarily_unavailable' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await fs.writeFile(path.join(directory, 'config.json'), `${JSON.stringify({
    version: 1,
    default_profile: 'lab',
    profiles: { lab: { origin } },
    credential_backends: { [origin]: 'file' },
  })}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(directory, 'credentials.json'), `${JSON.stringify({
    version: 1,
    servers: {
      [origin]: {
        access_token: token,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        scopes: REQUIRED_SCOPES,
        client_id: CLIENT_ID,
      },
    },
  })}\n`, { mode: 0o600 });

  const bootstrap = [
    "const os = require('node:os');",
    'const original = os.userInfo();',
    'os.userInfo = () => ({ ...original, homedir: process.argv[1] });',
    "const path = require('node:path');",
    "const { main } = require(path.join(process.argv[2], 'src/cli/main'));",
    "main(['mcp', '--profile', 'lab'], {",
    "  launcherPath: path.join(process.argv[2], 'tools/social-vibecoding')",
    '}).then((code) => { process.exitCode = code; });',
  ].join('\n');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['-e', bootstrap, home, checkout],
    cwd: checkout,
    env: { PATH: '/definitively-unavailable-for-cli-mcp-test' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'cli-mcp-transient-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    for (const [status, body] of [
      [429, { error: 'rate_limited' }],
      [503, { error: 'temporarily_unavailable' }],
    ]) {
      const result = await client.callTool({
        name: 'social_vibecoding.api_read',
        arguments: { path: '/api/apps' },
      });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.code, 'service_unavailable');
      assert.equal(result.structuredContent.retryable, true);
      assert.equal(result.structuredContent.profile, 'lab');
      assert.equal(result.structuredContent.status, status);
      assert.deepEqual(result.structuredContent.body, body);
    }
    assert.equal(calls, 2);
  } finally {
    await client.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('proposal MCP tools call the native handoff lifecycle and gate promotion on ready status', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-cli-mcp-proposal-'));
  await fs.chmod(home, 0o700);
  const directory = path.join(home, '.config', 'social-vibecoding');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const checkout = path.resolve(__dirname, '..');
  const token = makeAccessToken();
  const requests = [];
  let promoted = false;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({
      method: req.method,
      url: req.url,
      body: raw ? JSON.parse(raw) : undefined,
      authorization: req.headers.authorization,
    });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/apps/demo/proposal-handoffs') {
      res.statusCode = 201;
      res.end(JSON.stringify({ sessionId: 41, state: 'draft', branch: 'dev/cli-u7-feature-0001' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/sessions/41/proposal-handoff/context') {
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, inserted: 1 }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/sessions/41/proposal-handoff/build') {
      res.statusCode = 202;
      res.end(JSON.stringify({ sessionId: 41, status: 'deploying', headSha: 'b'.repeat(40) }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/sessions/41/proposal-handoff') {
      res.statusCode = 200;
      res.end(JSON.stringify({
        sessionId: 41,
        state: promoted ? 'promoted' : 'ready',
        headSha: 'b'.repeat(40),
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/sessions/41/promote') {
      promoted = true;
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, prNumber: 88 }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await fs.writeFile(path.join(directory, 'config.json'), `${JSON.stringify({
    version: 1,
    default_profile: 'lab',
    profiles: { lab: { origin } },
    credential_backends: { [origin]: 'file' },
  })}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(directory, 'credentials.json'), `${JSON.stringify({
    version: 1,
    servers: {
      [origin]: {
        access_token: token,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        scopes: REQUIRED_SCOPES,
        client_id: CLIENT_ID,
      },
    },
  })}\n`, { mode: 0o600 });

  const bootstrap = [
    "const os = require('node:os');",
    'const original = os.userInfo();',
    'os.userInfo = () => ({ ...original, homedir: process.argv[1] });',
    "const path = require('node:path');",
    "const { main } = require(path.join(process.argv[2], 'src/cli/main'));",
    "main(['mcp', '--profile', 'lab'], {",
    "  launcherPath: path.join(process.argv[2], 'tools/social-vibecoding')",
    '}).then((code) => { process.exitCode = code; });',
  ].join('\n');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['-e', bootstrap, home, checkout],
    cwd: checkout,
    env: { PATH: '/definitively-unavailable-for-cli-mcp-test' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'cli-mcp-proposal-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const start = await client.callTool({
      name: 'social_vibecoding.proposal_start',
      arguments: {
        app_slug: 'demo',
        request_id: 'feature-0001',
        base_sha: 'a'.repeat(40),
        title: 'Feature',
        spec: '# Spec',
        history: [{ id: 'u1', kind: 'user', content: 'Build it.' }],
        linked_issues: [12],
      },
    });
    assert.equal(start.structuredContent.status, 201);
    assert.equal(start.structuredContent.body.sessionId, 41);

    const append = await client.callTool({
      name: 'social_vibecoding.proposal_append_context',
      arguments: {
        session_id: 41,
        history: [{ id: 's2', kind: 'summary', content: 'Implemented it.', phase: 'build' }],
      },
    });
    assert.equal(append.structuredContent.body.inserted, 1);

    const submit = await client.callTool({
      name: 'social_vibecoding.proposal_submit_build',
      arguments: {
        session_id: 41,
        head_sha: 'b'.repeat(40),
        history: [{ id: 's3', kind: 'summary', content: 'Verified it.', phase: 'test' }],
        tests: [{ command: 'npm test', status: 'passed', summary: 'Green.' }],
      },
    });
    assert.equal(submit.structuredContent.status, 202);

    const status = await client.callTool({
      name: 'social_vibecoding.proposal_status',
      arguments: { session_id: 41 },
    });
    assert.equal(status.structuredContent.body.state, 'ready');

    const promote = await client.callTool({
      name: 'social_vibecoding.proposal_promote',
      arguments: { session_id: 41 },
    });
    assert.equal(promote.structuredContent.status, 200);
    assert.equal(promote.structuredContent.body.prNumber, 88);

    const promoteRetry = await client.callTool({
      name: 'social_vibecoding.proposal_promote',
      arguments: { session_id: 41 },
    });
    assert.equal(promoteRetry.structuredContent.body.state, 'promoted',
      'a lost promote response can be retried without issuing a second mutation');

    assert.deepEqual(requests.map((request) => [request.method, request.url]), [
      ['POST', '/api/apps/demo/proposal-handoffs'],
      ['POST', '/api/sessions/41/proposal-handoff/context'],
      ['POST', '/api/sessions/41/proposal-handoff/build'],
      ['GET', '/api/sessions/41/proposal-handoff'],
      ['GET', '/api/sessions/41/proposal-handoff'],
      ['POST', '/api/sessions/41/promote'],
      ['GET', '/api/sessions/41/proposal-handoff'],
    ]);
    assert.deepEqual(requests[0].body, {
      schemaVersion: 1,
      requestId: 'feature-0001',
      baseSha: 'a'.repeat(40),
      title: 'Feature',
      spec: '# Spec',
      history: [{ id: 'u1', kind: 'user', content: 'Build it.' }],
      linkedIssues: [12],
    });
    assert.deepEqual(requests[1].body, {
      schemaVersion: 1,
      history: [{ id: 's2', kind: 'summary', content: 'Implemented it.', phase: 'build' }],
    });
    assert.deepEqual(requests[2].body, {
      schemaVersion: 1,
      headSha: 'b'.repeat(40),
      history: [{ id: 's3', kind: 'summary', content: 'Verified it.', phase: 'test' }],
      tests: [{ command: 'npm test', status: 'passed', summary: 'Green.' }],
    });
    assert.ok(requests.every((request) => request.authorization === `Bearer ${token}`));
  } finally {
    await client.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('whoami reports an insufficient environment grant as a restart-required override', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-cli-mcp-env-scope-'));
  await fs.chmod(home, 0o700);
  const directory = path.join(home, '.config', 'social-vibecoding');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const checkout = path.resolve(__dirname, '..');
  const token = makeAccessToken();
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/api/cli/rpc/me');
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'insufficient_scope' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await fs.writeFile(path.join(directory, 'config.json'), `${JSON.stringify({
    version: 1,
    default_profile: 'lab',
    profiles: { lab: { origin } },
    credential_backends: {},
  })}\n`, { mode: 0o600 });

  const bootstrap = [
    "const os = require('node:os');",
    'const original = os.userInfo();',
    'os.userInfo = () => ({ ...original, homedir: process.argv[1] });',
    "const path = require('node:path');",
    "const { main } = require(path.join(process.argv[2], 'src/cli/main'));",
    "main(['mcp', '--profile', 'lab'], {",
    "  launcherPath: path.join(process.argv[2], 'tools/social-vibecoding')",
    '}).then((code) => { process.exitCode = code; });',
  ].join('\n');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['-e', bootstrap, home, checkout],
    cwd: checkout,
    env: {
      PATH: '/definitively-unavailable-for-cli-mcp-test',
      SOCIAL_VIBECODING_TOKEN: token,
      SOCIAL_VIBECODING_SERVER: origin,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'cli-mcp-env-scope-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: 'social_vibecoding.whoami',
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, 'environment_credential_invalid');
    assert.equal(result.structuredContent.profile, 'lab');
    assert.equal(result.structuredContent.retryable, false);
    assert.match(result.structuredContent.message, /restart this MCP process/);
    assert.equal(result.structuredContent.argv, undefined);
    assert.doesNotMatch(JSON.stringify(result), /svcli_/);
  } finally {
    await client.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(home, { recursive: true, force: true });
  }
});
