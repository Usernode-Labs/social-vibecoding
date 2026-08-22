'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const main = require('../src/cli/main');
const { makeAccessToken } = require('../src/services/cli-auth');
const {
  CLIENT_ID,
  REQUIRED_SCOPES,
} = require('../src/services/cli-auth-constants');

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=',
  'base64'
);

test('proposal upload-image sends validated image bytes through authenticated session storage', async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sv-cli-proposal-image-home-')));
  const imageDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sv-cli-proposal-image-file-')));
  await fs.chmod(home, 0o700);
  const imagePath = path.join(imageDir, 'review details.png');
  await fs.writeFile(imagePath, PNG_1X1);
  const token = makeAccessToken();
  const attachmentId = 'a'.repeat(32);
  let server;
  let received;
  const originalUserInfo = os.userInfo;
  try {
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        received = {
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization,
          contentType: req.headers['content-type'],
          body: Buffer.concat(chunks),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: attachmentId,
          kind: 'image',
          filename: 'review details.png',
          contentType: 'image/png',
          sizeBytes: PNG_1X1.length,
          meta: null,
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
      'proposal', 'upload-image', '--session', '41', '--file', imagePath, '--profile', 'lab',
    ], {
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } },
    });

    assert.equal(code, 0);
    assert.equal(stderr, '');
    assert.equal(received.method, 'POST');
    assert.equal(received.url, '/api/sessions/41/attachments?filename=review%20details.png');
    assert.equal(received.authorization, `Bearer ${token}`);
    assert.equal(received.contentType, 'application/octet-stream');
    assert.deepEqual(received.body, PNG_1X1);
    assert.equal(JSON.parse(stdout).body.id, attachmentId);
    assert.doesNotMatch(stdout + stderr, /svcli_|svdev_/);
  } finally {
    os.userInfo = originalUserInfo;
    if (server) await new Promise((resolve) => server.close(resolve));
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(imageDir, { recursive: true, force: true });
  }
});

test('proposal upload-image rejects relative paths and non-images before any request', async () => {
  let out = '';
  const relative = await main.main([
    'proposal', 'upload-image', '--session', '41', '--file', 'details.png',
  ], {
    stdout: { write: () => {} },
    stderr: { write: (chunk) => { out += chunk; } },
  });
  assert.equal(relative, 1);
  assert.match(out, /absolute --file path/);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-cli-proposal-not-image-'));
  const textPath = path.join(dir, 'notes.txt');
  try {
    await fs.writeFile(textPath, 'not an image');
    out = '';
    const nonImage = await main.main([
      'proposal', 'upload-image', '--session', '41', '--file', textPath,
    ], {
      stdout: { write: () => {} },
      stderr: { write: (chunk) => { out += chunk; } },
    });
    assert.equal(nonImage, 1);
    assert.match(out, /accepts PNG, JPEG, GIF, or WebP/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
