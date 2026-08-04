'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const main = require('../src/cli/main');
const { makeAccessToken } = require('../src/services/cli-auth');
const {
  CLIENT_ID,
  REQUIRED_SCOPES,
} = require('../src/services/cli-auth-constants');

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', shell: false,
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout.trim();
}

test('proposal push uploads the exact committed tree through the authenticated API', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-cli-proposal-push-home-'));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-cli-proposal-push-repo-'));
  await fs.chmod(home, 0o700);
  let server;
  const originalUserInfo = os.userInfo;
  try {
    git(repo, ['init', '-q']);
    await fs.writeFile(path.join(repo, 'app.js'), 'module.exports = 1;\n');
    git(repo, ['add', '.']);
    git(repo, ['-c', 'user.name=Local Tester', '-c', 'user.email=test@example.invalid',
      'commit', '-qm', 'Base']);
    const parentSha = git(repo, ['rev-parse', 'HEAD']);
    const parentTreeSha = git(repo, ['rev-parse', 'HEAD^{tree}']);
    await fs.writeFile(path.join(repo, 'app.js'), 'module.exports = 2;\n');
    git(repo, ['add', '.']);
    git(repo, ['-c', 'user.name=Local Tester', '-c', 'user.email=test@example.invalid',
      'commit', '-qm', 'Increment the app']);
    const localCommitSha = git(repo, ['rev-parse', 'HEAD']);
    const treeSha = git(repo, ['rev-parse', 'HEAD^{tree}']);

    const token = makeAccessToken();
    let received;
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        received = {
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        };
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          sessionId: 41,
          localCommitSha,
          headSha: 'e'.repeat(40),
          treeSha,
          uploaded: true,
        }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const directory = path.join(home, '.config', 'social-vibecoding');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
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

    os.userInfo = () => ({ ...originalUserInfo(), homedir: home });
    let stdout = '';
    let stderr = '';
    const code = await main.main([
      'proposal', 'push', '--session', '41', '--commit', localCommitSha,
      '--repo', repo, '--profile', 'lab',
    ], {
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } },
    });

    assert.equal(code, 0);
    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(stdout), {
      status: 201,
      body: {
        ok: true, sessionId: 41, localCommitSha,
        headSha: 'e'.repeat(40), treeSha, uploaded: true,
      },
    });
    assert.equal(received.method, 'POST');
    assert.equal(received.url, '/api/sessions/41/proposal-handoff/commits');
    assert.equal(received.authorization, `Bearer ${token}`);
    assert.equal(received.body.localCommitSha, localCommitSha);
    assert.equal(received.body.parentSha, parentSha);
    assert.equal(received.body.parentTreeSha, parentTreeSha);
    assert.equal(received.body.treeSha, treeSha);
    assert.equal(received.body.files.length, 1);
    assert.deepEqual(received.body.files[0], {
      path: 'app.js',
      mode: '100644',
      contentBase64: Buffer.from('module.exports = 2;\n').toString('base64'),
    });
    assert.doesNotMatch(stdout + stderr, /svcli_|svdev_/);
  } finally {
    os.userInfo = originalUserInfo;
    if (server) await new Promise((resolve) => server.close(resolve));
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(repo, { recursive: true, force: true });
  }
});
