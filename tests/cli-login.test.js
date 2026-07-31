'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  makeAccessToken,
  makeDeviceCode,
} = require('../src/services/cli-auth');
const {
  REQUIRED_SCOPE_TEXT,
} = require('../src/services/cli-auth-constants');

test('API command automatically logs in, waits for approval, then retries the request', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-cli-login-'));
  await fs.chmod(home, 0o700);
  const directory = path.join(home, '.config', 'social-vibecoding');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const accessToken = makeAccessToken();
  const deviceCode = makeDeviceCode();
  let creates = 0;
  let polls = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/api/cli/device/code') {
        creates += 1;
        res.end(JSON.stringify({
          device_code: deviceCode,
          user_code: 'ABCD-EFGH',
          verification_uri: `http://127.0.0.1:${server.address().port}/cli/authorize`,
          verification_uri_complete:
            `http://127.0.0.1:${server.address().port}/cli/authorize#code=ABCD-EFGH`,
          expires_in: 600,
          interval: 5,
        }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/cli/device/token') {
        polls += 1;
        res.end(JSON.stringify({
          access_token: accessToken,
          token_type: 'Bearer',
          scope: REQUIRED_SCOPE_TEXT,
          expires_in: 2592000,
          expires_at: new Date(Date.now() + 2592000 * 1000).toISOString(),
        }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/apps/demo/github-issues') {
        if (req.headers.authorization !== `Bearer ${accessToken}`) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'invalid_token' }));
          return;
        }
        res.end(JSON.stringify({ issues: [{ number: 7, title: 'Example' }] }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not_found' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const checkout = path.resolve(__dirname, '..');
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
    "main(['api', 'GET', '/api/apps/demo/github-issues', '--profile', 'lab'], {",
    '  stdout: process.stdout, stderr: process.stderr,',
    "  launcherPath: path.join(process.argv[2], 'tools/social-vibecoding')",
    '}).then((code) => { process.exitCode = code; });',
  ].join('\n');
  let stdout = '';
  let stderr = '';
  try {
    const child = spawn(process.execPath, ['-e', bootstrap, home, checkout], {
      cwd: checkout,
      env: {
        ...process.env,
        PATH: '/definitively-unavailable-for-cli-login-test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(exitCode, 0, stderr);
    assert.equal(creates, 1);
    assert.equal(polls, 1);
    assert.match(
      stdout,
      new RegExp(`${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/cli/authorize#code=ABCD-EFGH`)
    );
    assert.match(stdout, /Code: ABCD-EFGH/);
    assert.match(stdout, /"status": 200/);
    assert.match(stdout, /"title": "Example"/);
    assert.doesNotMatch(stdout + stderr, /svcli_|svdev_/);

    const credentials = JSON.parse(
      await fs.readFile(path.join(directory, 'credentials.json'), 'utf8')
    );
    const stored = Buffer.from(
      crypto.createHash('sha256').update(credentials.servers[origin].access_token).digest('hex')
    );
    const expected = Buffer.from(
      crypto.createHash('sha256').update(accessToken).digest('hex')
    );
    assert.equal(crypto.timingSafeEqual(stored, expected), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(home, { recursive: true, force: true });
  }
});
