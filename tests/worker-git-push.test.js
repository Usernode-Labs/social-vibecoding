'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const push = require('../src/services/worker-git-push');
const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_TERMINAL_PROMPT: '0' };
const branchName = 'dev/security-test';
function git(cwd, ...args) { return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function commit(cwd, name) {
  fs.writeFileSync(path.join(cwd, name), name);
  git(cwd, 'add', name); git(cwd, 'commit', '-qm', name);
  return git(cwd, 'rev-parse', 'HEAD');
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trusted-worker-push-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const origin = path.join(dir, 'origin.git'), ws = path.join(dir, 'worker');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, ws);
  const base = commit(ws, 'base'); git(ws, 'push', '-q', 'origin', 'HEAD:main');
  git(ws, 'checkout', '-qb', branchName);
  const exportWorker = async () => ({ stdout: execFileSync('sh', ['-c', push.buildExportScript({ workspace: ws, branchName })], { env, encoding: 'utf8' }), stderr: '' });
  return { dir, origin, ws, base, exportWorker };
}
function publish(f, extra = {}) { return push.push({ remoteUrl: f.origin, branchName, token: 'FAKE_WORKER_PUSH_TOKEN_123', exportWorker: f.exportWorker, ...extra }); }

test('exports real commits and merges, and repeats a successful push', async (t) => {
  const f = fixture(t); const first = commit(f.ws, 'first');
  assert.equal((await publish(f)).sha, first);
  assert.equal(git(f.origin, 'rev-parse', `refs/heads/${branchName}`), first);
  assert.equal((await publish(f)).sha, first);
  git(f.ws, 'checkout', '-qb', 'side', f.base); commit(f.ws, 'side');
  git(f.ws, 'checkout', '-q', branchName); git(f.ws, 'merge', '--no-edit', 'side');
  const merged = git(f.ws, 'rev-parse', 'HEAD');
  assert.equal((await publish(f)).sha, merged);
  assert.equal(git(f.origin, 'rev-parse', `refs/heads/${branchName}`), merged);
});

test('an unchanged base can create a session branch without an empty bundle', async (t) => {
  const f = fixture(t);
  assert.equal((await publish(f)).sha, f.base);
  assert.equal((await publish(f)).sha, f.base);
});

test('worker hooks, push URLs, rewrites and credential helpers never govern the trusted push', async (t) => {
  const f = fixture(t), marker = path.join(f.dir, 'hook-ran'), wrong = path.join(f.dir, 'wrong.git');
  git(f.dir, 'init', '-q', '--bare', wrong);
  const hooks = path.join(f.dir, 'hostile-hooks'); fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, 'pre-push'), `#!/bin/sh\necho "$FAKE_WORKER_PUSH_TOKEN_123" > '${marker}'\nexit 1\n`, { mode: 0o755 });
  git(f.ws, 'config', 'core.hooksPath', hooks);
  git(f.ws, 'config', 'credential.helper', `!echo helper > '${marker}'; false`);
  git(f.ws, 'config', 'remote.origin.pushurl', wrong);
  git(f.ws, 'config', `url.${wrong}.pushInsteadOf`, f.origin);
  const config = path.join(f.ws, '.git', 'config');
  const externalConfig = path.join(f.dir, 'worker-controlled-config');
  fs.renameSync(config, externalConfig); fs.symlinkSync(externalConfig, config);
  const sha = commit(f.ws, 'safe');
  assert.equal((await publish(f)).sha, sha);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(git(f.origin, 'rev-parse', `refs/heads/${branchName}`), sha);
  assert.equal(git(wrong, 'for-each-ref'), '');
});

test('a worker cannot rewind an advanced canonical branch', async (t) => {
  const f = fixture(t); commit(f.ws, 'first'); await publish(f);
  commit(f.ws, 'newer'); await publish(f);
  git(f.ws, 'reset', '--hard', 'HEAD^');
  await assert.rejects(publish(f));
});

test('malformed export records are rejected before Git import', () => {
  const sha = 'a'.repeat(40);
  for (const stdout of ['', sha, `__USERNODE_GIT_EXPORT_V1__ ${sha}\n!!!!\n`, `__USERNODE_GIT_EXPORT_V1__ ${sha}\n-\nextra\n`, `__USERNODE_GIT_EXPORT_V1__ ${sha.slice(1)}\n-\n`]) {
    assert.throws(() => push.parseExport(stdout, branchName));
  }
});

test('bundle headers cannot add refs, capabilities, URLs or unbounded prerequisites', () => {
  const sha = 'a'.repeat(40);
  const parse = header => push.parseExport(`__USERNODE_GIT_EXPORT_V1__ ${sha}\n${Buffer.from(`${header}\n\nPACK`).toString('base64')}\n`, branchName);
  const ref = `${sha} refs/heads/${branchName}`;
  for (const header of [
    `# v3 git bundle\n${ref}`,
    `# v2 git bundle\n${sha} refs/heads/main`,
    `# v2 git bundle\n${sha} refs/heads/main\n${ref}`,
    `# v2 git bundle\n${'b'.repeat(40)} refs/heads/${branchName}`,
    `# v2 git bundle\n-https://attacker.invalid/x bad prerequisite\n${ref}`,
    `# v2 git bundle\n${Array.from({ length: 33 }, () => `-${sha} comment`).join('\n')}\n${ref}`,
  ]) assert.throws(() => parse(header));
  assert.throws(() => push.parseExport('x'.repeat(push.MAX_EXPORT_BYTES + 1), branchName), /size limit/);
});

test('trusted Git ignores inherited hooks, templates, executables, helpers, tracing and object paths', async t => {
  const f = fixture(t);
  const sha = commit(f.ws, 'isolated-environment');
  const marker = path.join(f.dir, 'host-environment-capture');
  const hooks = path.join(f.dir, 'host-hooks'); fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, 'pre-push'), `#!/bin/sh\nenv > '${marker}'\nexit 1\n`, { mode: 0o755 });
  const globalConfig = path.join(f.dir, 'host-gitconfig');
  fs.writeFileSync(globalConfig, `[core]\n hooksPath = ${hooks}\n[credential]\n helper = !env > '${marker}'; false\n`);
  const injected = {
    GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_SYSTEM: globalConfig,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks,
    GIT_CONFIG_PARAMETERS: `'core.hooksPath=${hooks}'`,
    GIT_TEMPLATE_DIR: hooks, GIT_EXEC_PATH: hooks, GIT_ASKPASS: path.join(hooks, 'pre-push'),
    GIT_DIR: path.join(f.ws, '.git'), GIT_WORK_TREE: f.ws,
    GIT_OBJECT_DIRECTORY: path.join(f.dir, 'absent-objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(f.ws, '.git', 'objects'),
    GIT_TRACE: path.join(f.dir, 'trace'), GIT_TRACE_CURL: path.join(f.dir, 'trace-curl'),
  };
  for (const [key, value] of Object.entries(injected)) {
    const previous = process.env[key]; process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  assert.equal((await publish(f)).sha, sha);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(injected.GIT_TRACE), false);
  assert.equal(fs.existsSync(injected.GIT_TRACE_CURL), false);
});

test('trusted scratch directories are private and removed on success and import failure', async t => {
  const f = fixture(t);
  const promises = require('node:fs/promises');
  const mkdtemp = promises.mkdtemp.bind(promises), dirs = [];
  t.mock.method(promises, 'mkdtemp', async prefix => {
    const dir = await mkdtemp(prefix);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    dirs.push(dir); return dir;
  });
  commit(f.ws, 'cleaned-up');
  await publish(f);
  const exported = await f.exportWorker();
  const lines = exported.stdout.split('\n');
  const damaged = Buffer.from(lines[1], 'base64');
  damaged[damaged.length - 1] ^= 255; // Valid budget, invalid pack checksum.
  lines[1] = damaged.toString('base64');
  await assert.rejects(publish(f, { exportWorker: async () => ({ stdout: lines.join('\n') }) }));
  assert.equal(dirs.length, 2);
  for (const dir of dirs) assert.equal(fs.existsSync(dir), false);
});


test('a no-op export cannot name an object absent from the canonical repository', async (t) => {
  const f = fixture(t);
  await assert.rejects(publish(f, { exportWorker: async () => ({ stdout: `__USERNODE_GIT_EXPORT_V1__ ${'1'.repeat(40)}\n-\n`, stderr: '' }) }));
  assert.equal(git(f.origin, 'for-each-ref', '--format=%(refname)', `refs/heads/${branchName}`), '');
});

test('trusted HTTP push authenticates while public prerequisite fetch stays anonymous', { timeout: 20000 }, async (t) => {
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const f = fixture(t);
  git(f.origin, 'config', 'http.receivepack', 'true');
  const fakeToken = 'FAKE_WORKER_PUSH_TOKEN_123';
  const expectedAuth = `Basic ${Buffer.from(`x-access-token:${fakeToken}`).toString('base64')}`;
  const observed = [];
  const children = new Set();
  let redirect = false;
  let redirectedRequests = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/credential-sink') {
      redirectedRequests++;
      res.writeHead(500); res.end(); return;
    }
    const receive = url.pathname.endsWith('/git-receive-pack') || url.searchParams.get('service') === 'git-receive-pack';
    observed.push({ receive, auth: req.headers.authorization || null });
    if (receive && req.headers.authorization !== expectedAuth) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test-git"' }); res.end(); return;
    }
    if (receive && redirect) {
      res.writeHead(302, { Location: '/credential-sink' }); res.end(); return;
    }
    const child = spawn('git', ['http-backend'], { env: {
      PATH: process.env.PATH, GIT_PROJECT_ROOT: f.dir, GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname, REQUEST_METHOD: req.method, QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers['content-type'] || '', REMOTE_USER: receive ? 'test' : '',
      SERVER_PROTOCOL: 'HTTP/1.1',
    }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child); child.on('close', () => children.delete(child));
    child.on('error', error => { res.writeHead(500); res.end(error.message); });
    req.pipe(child.stdin); child.stdin.on('error', () => {});
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.on('close', () => {
      const output = Buffer.concat(chunks); let end = output.indexOf('\r\n\r\n'), sep = 4;
      if (end < 0) { end = output.indexOf('\n\n'); sep = 2; }
      if (end < 0) { res.writeHead(500); res.end('Invalid CGI response'); return; }
      const headers = {}; let status = 200;
      for (const line of output.subarray(0, end).toString('utf8').split(/\r?\n/)) {
        const colon = line.indexOf(':'); if (colon < 0) continue;
        const name = line.slice(0, colon), value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]); else headers[name] = value;
      }
      res.writeHead(status, headers); res.end(output.subarray(end + sep));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const child of children) child.kill(); await new Promise(resolve => server.close(resolve)); });
  const marker = path.join(f.dir, 'credential-stolen');
  const hook = path.join(f.ws, '.git', 'hooks', 'pre-push');
  fs.writeFileSync(hook, `#!/bin/sh\nenv > '${marker}'\nexit 1\n`, { mode: 0o755 });
  git(f.ws, 'config', 'credential.helper', `!env > '${marker}'; false`);
  const sha = commit(f.ws, 'authenticated');
  const remoteUrl = `http://127.0.0.1:${server.address().port}/origin.git`;
  // Positive control: the former design really does let this worker hook
  // capture a credential passed transiently to its Git process.
  const execFileAsync = require('node:util').promisify(require('node:child_process').execFile);
  const helper = '!f() { if [ "$1" = get ]; then printf "%s\\n" "username=x-access-token" "password=$PAT"; fi; }; f';
  await assert.rejects(execFileAsync('git', ['-c', `credential.helper=${helper}`, 'push', remoteUrl,
    `HEAD:refs/heads/${branchName}`], { cwd: f.ws, env: { ...env, PAT: fakeToken }, timeout: 5000 }));
  assert.ok(fs.readFileSync(marker, 'utf8').includes(`PAT=${fakeToken}`), 'control hook captures the transient token');
  fs.unlinkSync(marker);
  observed.length = 0;
  assert.equal((await publish(f, { remoteUrl, token: fakeToken })).sha, sha);
  assert.equal(git(f.origin, 'rev-parse', `refs/heads/${branchName}`), sha);
  assert.ok(observed.some(request => request.receive && request.auth === expectedAuth), 'the trusted push used the fake credential');
  assert.ok(observed.some(request => !request.receive), 'prerequisites were fetched publicly');
  assert.ok(observed.filter(request => !request.receive).every(request => request.auth === null), 'public reads carry no push credential');
  assert.equal(fs.existsSync(marker), false, 'worker hook and credential helper never ran');

  // A remote rejection may echo credentials. The caller gets a new error
  // with every literal and HTTP Basic representation removed.
  const receiveHook = path.join(f.origin, 'hooks', 'pre-receive');
  const encoded = expectedAuth.slice('Basic '.length);
  fs.writeFileSync(receiveHook, `#!/bin/sh\nprintf '%s\\n' '${fakeToken} ${fakeToken} ${encoded}' >&2\nexit 1\n`, { mode: 0o755 });
  commit(f.ws, 'rejected');
  await assert.rejects(publish(f, { remoteUrl, token: fakeToken }), error => {
    assert.match(error.stderr, /\*\*\*/);
    for (const text of [error.message, error.stderr]) {
      assert.equal(text.includes(fakeToken), false);
      assert.equal(text.includes(encoded), false);
    }
    return true;
  });
  fs.unlinkSync(receiveHook);
  redirect = true;
  await assert.rejects(publish(f, { remoteUrl, token: fakeToken }));
  assert.equal(redirectedRequests, 0, 'authenticated Git never follows a redirect');
  assert.equal(fs.existsSync(marker), false, 'failure and redirect paths still never run worker helpers');
});

// Homeroom's git host (services/git-host.js): the service account's name
// with its token, and a destination that may not be public, so the base
// commits are fetched with the same credential. Still nothing the worker
// controls ever sees it, and a rejection echoing it is redacted.
test('a push to the git host authenticates as its service account, base fetch included', { timeout: 20000 }, async (t) => {
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const f = fixture(t);
  git(f.origin, 'config', 'http.receivepack', 'true');
  const fakeToken = 'FAKE_GIT_HOST_TOKEN_456';
  const expectedAuth = `Basic ${Buffer.from(`homeroom:${fakeToken}`).toString('base64')}`;
  const observed = [];
  const children = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    observed.push({ path: url.pathname, auth: req.headers.authorization || null });
    if (req.headers.authorization !== expectedAuth) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="forgejo"' }); res.end(); return;
    }
    const child = spawn('git', ['http-backend'], { env: {
      PATH: process.env.PATH, GIT_PROJECT_ROOT: f.dir, GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname, REQUEST_METHOD: req.method, QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers['content-type'] || '', REMOTE_USER: 'homeroom', SERVER_PROTOCOL: 'HTTP/1.1',
    }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child); child.on('close', () => children.delete(child));
    req.pipe(child.stdin); child.stdin.on('error', () => {});
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.on('close', () => {
      const output = Buffer.concat(chunks); let end = output.indexOf('\r\n\r\n'), sep = 4;
      if (end < 0) { end = output.indexOf('\n\n'); sep = 2; }
      const headers = {}; let status = 200;
      for (const line of output.subarray(0, end).toString('utf8').split(/\r?\n/)) {
        const colon = line.indexOf(':'); if (colon < 0) continue;
        const name = line.slice(0, colon), value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]); else headers[name] = value;
      }
      res.writeHead(status, headers); res.end(output.subarray(end + sep));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const child of children) child.kill(); await new Promise(resolve => server.close(resolve)); });
  const marker = path.join(f.dir, 'credential-stolen');
  git(f.ws, 'config', 'credential.helper', `!env > '${marker}'; false`);
  const sha = commit(f.ws, 'to the git host');
  const remoteUrl = `http://127.0.0.1:${server.address().port}/origin.git`;
  const pushed = await publish(f, { remoteUrl, token: fakeToken, username: 'homeroom', authFetch: true });
  assert.equal(pushed.sha, sha);
  assert.equal(git(f.origin, 'rev-parse', `refs/heads/${branchName}`), sha);
  assert.ok(observed.some((r) => r.auth === expectedAuth), 'the service account authenticated');
  assert.equal(fs.existsSync(marker), false, 'the worker\'s credential helper never ran');

  const receiveHook = path.join(f.origin, 'hooks', 'pre-receive');
  const encoded = expectedAuth.slice('Basic '.length);
  fs.writeFileSync(receiveHook, `#!/bin/sh\nprintf '%s\\n' '${fakeToken} ${encoded}' >&2\nexit 1\n`, { mode: 0o755 });
  commit(f.ws, 'rejected');
  await assert.rejects(publish(f, { remoteUrl, token: fakeToken, username: 'homeroom', authFetch: true }), (error) => {
    for (const text of [error.message, error.stderr]) {
      assert.equal(text.includes(fakeToken), false);
      assert.equal(text.includes(encoded), false, 'the service account\'s Basic credential is redacted');
    }
    return true;
  });
});
