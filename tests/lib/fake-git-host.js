'use strict';

// A git host stand-in for tests: bare repositories in a temporary folder
// behind a loopback HTTP server, speaking the two things the platform asks
// of its host (services/git-host.js):
//
//   * the few API calls that are not git — make a repository, change who
//     can see it — answered the way Forgejo answers them; and
//   * git's own HTTP protocol, passed to `git http-backend`, so a push and a
//     fetch are REAL git over a REAL network, not a stub that says yes.
//
// What it exists to test: a preview project's source repository must be
// public, because a Kubernetes build fetches it with no credential
// (kubernetes-buildkit.js). So a private repository here refuses an
// anonymous fetch with git's own "could not read Username", exactly as the
// real host did when projects were first turned on (#5958), and the same
// repository answers once it is made public.
//
// NOT a `*.test.js` file, so the runner does not try to run it as a suite.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

const USER = 'homeroom-test';
const TOKEN = 'FAKE_GIT_HOST_TOKEN_NOT_A_SECRET';
const ORG = 'apps';

function git(args, env = {}) {
  return run('git', args, {
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      LC_ALL: 'C',
      ...env,
    },
    maxBuffer: 64 * 1024 * 1024,
  });
}

function basic(user, token) {
  return `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

// One request through `git http-backend`, which speaks CGI: the request in
// the environment, the response on stdout with its own header block.
function backend(root, req, res, { pathInfo, remoteUser, children }) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const child = spawn('git', ['http-backend'], {
    env: {
      PATH: process.env.PATH,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1',
      GIT_PROTOCOL: req.headers['git-protocol'] || '',
      PATH_INFO: pathInfo,
      REQUEST_METHOD: req.method,
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers['content-type'] || '',
      REMOTE_USER: remoteUser || '',
      SERVER_PROTOCOL: 'HTTP/1.1',
      SERVER_NAME: '127.0.0.1',
    },
  });
  children.add(child);
  child.on('close', () => children.delete(child));
  child.on('error', (err) => { res.writeHead(500); res.end(err.message); });
  req.pipe(child.stdin);
  child.stdin.on('error', () => {});
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.on('close', () => {
    if (res.writableEnded) return;
    const output = Buffer.concat(chunks);
    let end = output.indexOf('\r\n\r\n');
    let sep = 4;
    if (end < 0) { end = output.indexOf('\n\n'); sep = 2; }
    if (end < 0) { res.writeHead(500); res.end('Invalid CGI response'); return; }
    const headers = {};
    let status = 200;
    for (const line of output.subarray(0, end).toString('utf8').split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const name = line.slice(0, colon);
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
      else headers[name] = value;
    }
    res.writeHead(status, headers);
    res.end(output.subarray(end + sep));
  });
}

/**
 * Start the stand-in and point services/git-host.js at it.
 *
 * Resolves a host with
 *   makeRepo(name, { private })   a bare repository, private or public
 *   isPrivate(name)               what the API was last told (null: absent)
 *   branchSha(name, branch)       the commit a branch points at, or null
 *   requests                      what reached the API: { method, path }
 *   url                           the base the platform was given
 *   close()                       stop it (also in t.after)
 *
 * Everything it set in the environment is put back in t.after.
 */
async function startFakeGitHost(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-git-host-'));
  fs.mkdirSync(path.join(root, ORG), { recursive: true });
  const repos = new Map();
  const requests = [];
  const children = new Set();

  const repoDir = (name) => path.join(root, ORG, `${name}.git`);

  function gitSync(args) {
    return execFileSync('git', args, {
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  }

  function makeRepo(name, { private: isPrivateRepo = false } = {}) {
    const dir = repoDir(name);
    fs.mkdirSync(dir, { recursive: true });
    gitSync(['init', '-q', '--bare', '-b', 'main', dir]);
    // As Forgejo serves them: a fetch by commit sha works, and a push is
    // allowed for the authenticated user.
    gitSync(['--git-dir', dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true']);
    gitSync(['--git-dir', dir, 'config', 'http.receivepack', 'true']);
    repos.set(name, { private: !!isPrivateRepo });
    return dir;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const auth = req.headers.authorization || null;
    const api = /^\/api\/v1\/orgs\/([^/]+)\/repos$/.exec(url.pathname);

    if (req.method === 'POST' && api) {
      requests.push({ method: 'POST', path: url.pathname });
      const body = await readBody(req).catch(() => '');
      if (api[1] !== ORG) { res.writeHead(404); res.end('{}'); return; }
      if (auth !== `token ${TOKEN}`) { res.writeHead(401); res.end('{}'); return; }
      let name = '';
      let isPrivateRepo = false;
      try { ({ name, private: isPrivateRepo = false } = JSON.parse(body || '{}')); } catch (_) { /* refused below */ }
      if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) { res.writeHead(422); res.end('{}'); return; }
      if (repos.has(name)) { res.writeHead(409); res.end('{}'); return; }
      makeRepo(name, { private: isPrivateRepo });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name, private: isPrivateRepo }));
      return;
    }

    const patch = /^\/api\/v1\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'PATCH' && patch) {
      requests.push({ method: 'PATCH', path: url.pathname });
      const body = await readBody(req).catch(() => '');
      if (auth !== `token ${TOKEN}`) { res.writeHead(401); res.end('{}'); return; }
      const name = patch[2];
      if (!repos.has(name)) { res.writeHead(404); res.end('{}'); return; }
      let isPrivateRepo;
      try { ({ private: isPrivateRepo } = JSON.parse(body || '{}')); } catch (_) { isPrivateRepo = undefined; }
      if (typeof isPrivateRepo === 'boolean') repos.get(name).private = isPrivateRepo;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name, private: repos.get(name).private }));
      return;
    }

    // Everything else is git: /apps/<name>.git/info/refs, /git-upload-pack,
    // /git-receive-pack.
    const repo = /^\/apps\/([^/]+?)\.git(?:\/|$)/.exec(url.pathname);
    if (!repo) { res.writeHead(404); res.end('Not found'); return; }
    const name = repo[1];
    const receive = url.pathname.endsWith('/git-receive-pack') || url.searchParams.get('service') === 'git-receive-pack';
    const entry = repos.get(name);
    if (!entry || !fs.existsSync(repoDir(name))) { res.writeHead(404); res.end('Repository not found'); return; }

    const authenticated = auth === basic(USER, TOKEN);
    // A push always needs the service account; a read only when the
    // repository is private. What a build does (kubernetes-buildkit.js) is
    // the anonymous read, so this is the refusal #5958 was about.
    if (!authenticated && (receive || entry.private)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fake-git"' });
      res.end('Authentication required');
      return;
    }

    backend(root, req, res, {
      pathInfo: url.pathname,
      remoteUser: authenticated ? USER : '',
      children,
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  const saved = {};
  const vars = {
    GIT_HOST_URL: url,
    GIT_HOST_INTERNAL_URL: url,
    GIT_HOST_ORG: ORG,
    GIT_HOST_USER: USER,
    GIT_HOST_TOKEN: TOKEN,
  };
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }

  async function close() {
    for (const child of children) child.kill();
    children.clear();
    const closed = new Promise((resolve) => server.close(resolve));
    // Keep-alive sockets would otherwise hold the close open.
    if (server.closeAllConnections) server.closeAllConnections();
    await closed;
    fs.rmSync(root, { recursive: true, force: true });
  }

  if (t && t.after) {
    t.after(async () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await close();
    });
  }

  return {
    root,
    url,
    requests,
    makeRepo,
    isPrivate(name) {
      const entry = repos.get(name);
      return entry ? entry.private : null;
    },
    exists(name) {
      return repos.has(name) && fs.existsSync(repoDir(name));
    },
    branchSha(name, branch) {
      try {
        return gitSync(['--git-dir', repoDir(name), 'rev-parse', `refs/heads/${branch}`]).toString().trim();
      } catch (_) {
        return null;
      }
    },
    close,
  };
}

/**
 * Fetch a project's source the way a Kubernetes build does
 * (kubernetes-buildkit.js: `git fetch --depth 1 "$REPO_URL" "$GIT_SHA"`,
 * then read-tree and checkout-index), with NO credential: the platform's
 * service account is not offered, and there is no terminal to prompt.
 *
 * `repoUrl` is an apps.repo_url, mapped through services/git-host.js to the
 * address git reads from. Rejects with git's own error when the repository
 * is private, which is the "could not read Username" a real build failed
 * with before #5958.
 *
 * Resolves { files: { path: Buffer }, modes: { path: '100644' | '100755' } }.
 */
async function fetchLikeABuild(repoUrl, sha) {
  const gitHost = require('../../src/services/git-host');
  const parsed = gitHost.parseRepoUrl(repoUrl);
  const url = parsed ? gitHost.cloneUrl(parsed) : repoUrl;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-build-checkout-'));
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    LC_ALL: 'C',
  };
  try {
    await git(['init', '-q', dir], env);
    await git(['-C', dir, '-c', 'credential.helper=', '-c', 'protocol.version=2',
      'fetch', '-q', '--depth', '1', url, String(sha)], env);
    await git(['-C', dir, 'read-tree', 'FETCH_HEAD'], env);
    await git(['-C', dir, 'checkout-index', '-a', '-f'], env);
    const files = {};
    const modes = {};
    const walk = (rel) => {
      for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(child);
        else {
          files[child] = fs.readFileSync(path.join(dir, child));
          modes[child] = (fs.statSync(path.join(dir, child)).mode & 0o111) ? '100755' : '100644';
        }
      }
    };
    walk('');
    return { files, modes };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { startFakeGitHost, fetchLikeABuild, USER, TOKEN, ORG };
