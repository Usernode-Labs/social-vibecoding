'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StdioClientTransport,
} = require('@modelcontextprotocol/sdk/client/stdio.js');

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
      'social_vibecoding.whoami',
    ]);
    for (const [name, tool] of byName) {
      const mutating = name === 'social_vibecoding.api_write';
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
