'use strict';

// A live draft's preview, from the inside (services/live-drafts.js). A draft
// is a change Homeroom bot edits while a person watches: its preview is an
// ordinary preview of the draft's branch, built and deployed by the preview
// machine, except that the container starts THIS script instead of the
// app's own command. It keeps the app up between edits and changes it in
// place, so an edit shows in seconds instead of after a new image.
//
//   - It answers the container's port (PORT, 3000) itself and passes every
//     request through to the app, which it runs as a child on an inner port
//     (INNER_PORT). While the app restarts, a request waits a moment for it,
//     then gets a short "restarting" page.
//   - POST /__usernode_live__/apply, with the draft's own secret in
//     x-usernode-live-token, writes the files it is sent, restarts the app
//     and answers once the app listens again, or with why it did not (the
//     tail of its output). A change to what the app installs (package.json's
//     dependencies, its lockfile) is not applied: it answers needsRebuild,
//     and the platform builds the branch again the ordinary way.
//   - Before the restart it runs the app's `build` script, when it has one.
//     A build that fails puts the files back (needsRebuild, why 'build').
//     A build whose command is not installed in this image (exit 127) is a
//     different thing: the app template compiles its stylesheet in a
//     Dockerfile stage of its own and installs the runtime without dev
//     dependencies, so `tailwindcss` is not here to run. Then the edit is
//     kept and the app restarted, so it shows at once, and the answer says
//     `buildSkipped`: the platform builds the preview again the ordinary
//     way, where the build's tools are, to bring what it makes up to date.
//   - GET /__usernode_live__/status, with the secret, says how the app is,
//     and which commit its files are at (`head`): the image's own
//     (USERNODE_LIVE_HEAD) until an edit names the commit it brings. A
//     preview that slept and woke runs its image again, so the platform
//     reads this to send what changed since.
//   - /health is the supervisor's own, so the preview stays reachable for the
//     next edit while an edit has broken the app.
//
// It is started as `node -e <this file>` (with the CNB launcher in front for
// a buildpack image), so it is one file, CommonJS, Node's own modules only.
// The secret is never handed to the app: its environment is the container's
// less USERNODE_LIVE_TOKEN, with PORT set to the inner port.

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const CONTROL_PREFIX = '/__usernode_live__/';
const TOKEN_HEADER = 'x-usernode-live-token';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_PATH_CHARS = 300;
const LOG_KEEP_CHARS = 16 * 1024;
const BOOT_TIMEOUT_MS = 30 * 1000;
const BUILD_TIMEOUT_MS = 120 * 1000;
const WAIT_FOR_APP_MS = 20 * 1000;
const STOP_GRACE_MS = 3000;
const AUTO_RESTART_GAP_MS = 30 * 1000;
// What a shell exits with when the command it was asked to run is not there.
// npm passes a script's code through, so `npm run build` that calls a missing
// `tailwindcss` exits with it too, as does a missing npm itself.
const COMMAND_NOT_FOUND = 127;
// Files the image's install step reads: a change to one is a new install.
const INSTALL_FILES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);
const INSTALL_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides', 'engines'];

/** Pure: a path as sent, made relative and safe, or null. */
function safePath(raw) {
  const text = String(raw == null ? '' : raw).replace(/\\/g, '/').trim();
  if (!text || text.length > MAX_PATH_CHARS || text.includes('\u0000')) return null;
  if (text.startsWith('/')) return null;
  const parts = text.split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..')) return null;
  if (parts[0] === 'node_modules' || parts[0] === '.git') return null;
  return parts.join('/');
}

/** Pure: whether two package.json texts install the same things. */
function sameInstall(before, after) {
  let a;
  let b;
  try { a = JSON.parse(before || '{}'); } catch { return false; }
  try { b = JSON.parse(after || '{}'); } catch { return false; }
  return INSTALL_KEYS.every((key) => JSON.stringify(a?.[key] ?? null) === JSON.stringify(b?.[key] ?? null));
}

/**
 * Pure: whether applying `files` (normalised, against what is on disk now:
 * `current(path)` → text or null) changes what the image installed.
 */
function needsInstall(files, current) {
  for (const file of files) {
    if (!INSTALL_FILES.has(file.path)) continue;
    if (file.path !== 'package.json') return true;
    if (file.delete) return true;
    if (!sameInstall(current(file.path), file.content)) return true;
  }
  return false;
}

/**
 * Pure: how to start the app, from its package.json: `{ command, args }`.
 * A `start` of the shape `node <file> [args]` runs on this same Node binary
 * (a buildpack image has no npm on its PATH for certain); any other `start`
 * runs in a shell with node_modules/.bin on the PATH; with none, `main`,
 * then server.js, index.js, app.js.
 */
function startCommand(pkgText, exists = () => false, nodePath = process.execPath) {
  let pkg = {};
  try { pkg = JSON.parse(pkgText || '{}') || {}; } catch { pkg = {}; }
  const start = typeof pkg?.scripts?.start === 'string' ? pkg.scripts.start.trim() : '';
  const direct = /^node\s+([^\s;&|<>`$]+)((?:\s+[^\s;&|<>`$]+)*)\s*$/.exec(start);
  if (direct) return { command: nodePath, args: [direct[1], ...direct[2].split(/\s+/).filter(Boolean)] };
  if (start) return { command: 'sh', args: ['-c', start] };
  const main = typeof pkg.main === 'string' && pkg.main.trim() ? pkg.main.trim() : null;
  const candidates = [main, 'server.js', 'index.js', 'app.js'].filter(Boolean);
  const found = candidates.find((file) => exists(file)) || candidates[0];
  return { command: nodePath, args: [found] };
}

/** Pure: a package.json's build script, or null. */
function buildScript(pkgText) {
  try {
    const pkg = JSON.parse(pkgText || '{}');
    const build = pkg?.scripts?.build;
    return typeof build === 'string' && build.trim() ? build.trim() : null;
  } catch { return null; }
}

/** Pure: whether the secret given is the one held, in constant time. */
function tokenMatches(given, held) {
  if (!held || typeof given !== 'string' || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(String(held));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createLog(max = LOG_KEEP_CHARS) {
  let text = '';
  return {
    add(chunk) {
      text = (text + String(chunk)).slice(-max);
    },
    since(mark) {
      return mark >= 0 && mark <= text.length ? text.slice(mark) : text;
    },
    mark() { return text.length; },
    tail(chars = 4000) { return text.slice(-chars); },
  };
}

function writable(dir) {
  const probe = path.join(dir, `.usernode-live-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch { return false; }
}

// The app's files, copied where they may be written: an image whose files
// belong to root runs as a user that cannot change them. Its installed
// packages stay where the image put them.
function copyApp(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.name === 'node_modules') {
      fs.symlinkSync(src, dest);
      continue;
    }
    fs.cpSync(src, dest, { recursive: true, dereference: false });
  }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function start(options = {}) {
  const env = options.env || process.env;
  const frontPort = Number(options.port || env.PORT) || 3000;
  const innerPort = Number(options.innerPort || env.USERNODE_LIVE_INNER_PORT) || 3080;
  const token = options.token || env.USERNODE_LIVE_TOKEN || '';
  const origin = options.appDir || process.cwd();
  const log = createLog();
  const say = (line) => { process.stdout.write(`[live-draft] ${line}\n`); };
  if (!token) say('No USERNODE_LIVE_TOKEN: edits will be refused.');

  let appDir = origin;
  if (!writable(origin)) {
    appDir = path.join(env.TMPDIR || '/tmp', 'usernode-live', 'app');
    copyApp(origin, appDir);
    say(`App files copied to ${appDir} (the image's are read-only to this user).`);
  }

  const childEnv = { ...env, PORT: String(innerPort) };
  delete childEnv.USERNODE_LIVE_TOKEN;
  delete childEnv.USERNODE_LIVE_SUPERVISOR;
  delete childEnv.USERNODE_LIVE_HEAD;
  const binDirs = [path.join(appDir, 'node_modules', '.bin'), path.dirname(process.execPath)];
  childEnv.PATH = [...binDirs, env.PATH || ''].filter(Boolean).join(path.delimiter);

  const state = {
    child: null, ready: false, booting: null, restarts: 0, startedAt: null, lastExit: null, firstBootDone: false,
    applying: Promise.resolve(),
    head: /^[0-9a-f]{40}$/i.test(String(env.USERNODE_LIVE_HEAD || '')) ? String(env.USERNODE_LIVE_HEAD).toLowerCase() : null,
  };

  const probe = () => new Promise((resolve) => {
    const socket = net.connect(innerPort, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });

  const gone = (child) => !child || child.exitCode != null || child.signalCode != null;
  // The app and anything it started (a shell's children): its own group.
  const signal = (child, sig) => {
    try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} }
  };

  function stopChild() {
    const child = state.child;
    state.ready = false;
    state.stopping = child;
    if (gone(child)) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(soft);
        clearTimeout(hard);
        resolve();
      };
      child.once('exit', finish);
      const soft = setTimeout(() => signal(child, 'SIGKILL'), STOP_GRACE_MS);
      // A kill the kernel never reports still ends the wait.
      const hard = setTimeout(finish, STOP_GRACE_MS + 2000);
      signal(child, 'SIGTERM');
      if (gone(child)) finish();
    });
  }

  // Start the app and wait until it listens: { ok, bootMs } or { ok: false, why, log }.
  function boot() {
    const pkg = readText(path.join(appDir, 'package.json'));
    const { command, args } = startCommand(pkg, (file) => fs.existsSync(path.join(appDir, file)));
    const mark = log.mark();
    const began = Date.now();
    const child = spawn(command, args, { cwd: appDir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    state.child = child;
    state.startedAt = new Date().toISOString();
    const relay = (chunk) => { log.add(chunk); process.stdout.write(chunk); };
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);
    let exited = null;
    child.once('error', (err) => { exited = { code: null, signal: null, error: err.message }; log.add(`\n${err.message}\n`); });
    child.once('exit', (code, sig) => {
      exited = exited || { code, signal: sig };
      state.lastExit = { ...exited, at: new Date().toISOString() };
      if (state.child !== child) return;
      const wasUp = state.ready;
      state.ready = false;
      // An app that ran and then stopped by itself (not stopped here) is
      // started again, at most once every AUTO_RESTART_GAP_MS, so one bad
      // request does not leave the draft down until the next edit.
      if (wasUp && state.stopping !== child && Date.now() - (state.autoRestartedAt || 0) > AUTO_RESTART_GAP_MS) {
        state.autoRestartedAt = Date.now();
        say('The app stopped by itself; starting it again.');
        state.restarts += 1;
        boot();
      }
    });
    const done = (async () => {
      while (Date.now() - began < BOOT_TIMEOUT_MS) {
        if (exited) {
          return { ok: false, why: 'exited', exit: exited, log: log.since(mark).slice(-4000) || log.tail() };
        }
        if (await probe()) {
          if (state.child === child) state.ready = true;
          return { ok: true, bootMs: Date.now() - began };
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return { ok: false, why: 'timeout', log: log.since(mark).slice(-4000) || log.tail() };
    })();
    state.booting = done.finally(() => { if (state.child === child) state.booting = null; state.firstBootDone = true; });
    return done;
  }

  async function restart() {
    await stopChild();
    state.restarts += 1;
    return boot();
  }

  function runBuild(script) {
    return new Promise((resolve) => {
      const mark = log.mark();
      const child = spawn('sh', ['-c', script], { cwd: appDir, env: { ...childEnv, NODE_ENV: env.NODE_ENV || 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
      const relay = (chunk) => { log.add(chunk); process.stdout.write(chunk); };
      child.stdout.on('data', relay);
      child.stderr.on('data', relay);
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, BUILD_TIMEOUT_MS);
      child.once('error', (err) => { clearTimeout(timer); resolve({ ok: false, code: null, log: err.message }); });
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? { ok: true } : { ok: false, code, log: log.since(mark).slice(-4000) });
      });
    });
  }

  // Write the files, keeping what each held before so a build that fails
  // can put them back. Resolves the undo list.
  function writeFiles(files) {
    const undo = [];
    for (const file of files) {
      const abs = path.join(appDir, file.path);
      undo.push({ abs, before: readText(abs) });
      if (file.delete) {
        fs.rmSync(abs, { force: true });
        continue;
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.usernode-live-${process.pid}`;
      fs.writeFileSync(tmp, file.content);
      fs.renameSync(tmp, abs);
    }
    return undo;
  }

  function undoFiles(undo) {
    for (const { abs, before } of undo.reverse()) {
      try {
        if (before == null) fs.rmSync(abs, { force: true });
        else fs.writeFileSync(abs, before);
      } catch {}
    }
  }

  function normalise(body) {
    const list = Array.isArray(body?.files) ? body.files : null;
    if (!list || !list.length) return { error: 'No files' };
    if (list.length > MAX_FILES) return { error: `At most ${MAX_FILES} files at once` };
    const files = [];
    for (const raw of list) {
      const filePath = safePath(raw?.path);
      if (!filePath) return { error: `Not a file path in the app: ${String(raw?.path).slice(0, 80)}` };
      if (raw.delete === true) files.push({ path: filePath, delete: true });
      else if (typeof raw.content === 'string') files.push({ path: filePath, content: raw.content });
      else return { error: `No content for ${filePath}` };
    }
    return { files };
  }

  async function apply(body) {
    const { files, error } = normalise(body);
    if (error) return { status: 400, body: { ok: false, error } };
    if (needsInstall(files, (p) => readText(path.join(appDir, p)))) {
      return { status: 409, body: { ok: false, needsRebuild: true, why: 'install' } };
    }
    const before = state.head;
    const undo = writeFiles(files);
    // The files are now the commit the edit names (or no known commit).
    state.head = /^[0-9a-f]{40}$/i.test(String(body?.head || '')) ? String(body.head).toLowerCase() : null;
    const script = buildScript(readText(path.join(appDir, 'package.json')));
    let buildSkipped = null;
    if (script) {
      const built = await runBuild(script);
      if (!built.ok && built.code === COMMAND_NOT_FOUND) {
        // This image cannot run the build (see the header): keep the edit,
        // and leave what the build makes as the image built it.
        buildSkipped = { log: built.log };
      } else if (!built.ok) {
        undoFiles(undo);
        state.head = before;
        return { status: 409, body: { ok: false, needsRebuild: true, why: 'build', log: built.log, head: state.head } };
      }
    }
    const result = await restart();
    return {
      status: 200,
      body: {
        ...result, restarts: state.restarts, head: state.head,
        ...(buildSkipped ? { buildSkipped: true, buildLog: buildSkipped.log } : {}),
      },
    };
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error('too_big'), { status: 413 })); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  }

  async function control(req, res) {
    // Anything without the secret is answered as an unknown path would be.
    if (!tokenMatches(req.headers[TOKEN_HEADER], token)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const route = req.url.slice(CONTROL_PREFIX.length).split('?')[0];
    if (route === 'status' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true, running: !!state.child && state.child.exitCode == null && state.child.signalCode == null,
        ready: state.ready, restarts: state.restarts, startedAt: state.startedAt, lastExit: state.lastExit,
        head: state.head, log: log.tail(),
      });
      return;
    }
    if (route === 'apply' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); } catch (err) {
        sendJson(res, err.status || 400, { ok: false, error: err.status === 413 ? 'Too big' : 'Not JSON' });
        return;
      }
      // One edit at a time: a second waits for the first to finish.
      const run = state.applying.then(() => apply(body));
      state.applying = run.catch(() => {});
      try {
        const out = await run;
        sendJson(res, out.status, out.body);
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err.message });
      }
      return;
    }
    sendJson(res, 404, { ok: false, error: 'No such control route' });
  }

  async function waitForApp() {
    const until = Date.now() + WAIT_FOR_APP_MS;
    while (Date.now() < until) {
      if (state.ready) return true;
      if (state.booting) await Promise.race([state.booting, new Promise((r) => setTimeout(r, 250))]);
      else if (state.firstBootDone && !state.ready) return false;
      else await new Promise((r) => setTimeout(r, 150));
    }
    return state.ready;
  }

  const RESTARTING_PAGE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
    + '<title>Restarting</title><body style="font:15px system-ui,sans-serif;margin:40px;color:#555">'
    + '<p>This draft is restarting, or the last change stopped it from starting. Homeroom bot is told what went wrong.</p>';

  function passThrough(req, res) {
    const upstream = http.request({
      host: '127.0.0.1', port: innerPort, method: req.method, path: req.url, headers: req.headers,
    }, (answer) => {
      res.writeHead(answer.statusCode || 502, answer.statusMessage, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '2' });
      }
      res.end(RESTARTING_PAGE);
    });
    req.pipe(upstream);
  }

  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith(CONTROL_PREFIX)) {
      control(req, res).catch((err) => { try { sendJson(res, 500, { ok: false, error: err.message }); } catch {} });
      return;
    }
    if (req.url === '/health' || req.url.startsWith('/health?')) {
      // The supervisor's own: the preview stays reachable for the next edit.
      if (!state.firstBootDone && state.booting) await state.booting.catch(() => {});
      sendJson(res, 200, { status: 'ok', live: true, app: state.ready ? 'up' : 'down' });
      return;
    }
    if (!state.ready && !(await waitForApp())) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '2' });
      res.end(RESTARTING_PAGE);
      return;
    }
    passThrough(req, res);
  });

  // A WebSocket (or any upgrade) goes straight through, byte for byte.
  server.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith(CONTROL_PREFIX)) { socket.destroy(); return; }
    const upstream = net.connect(innerPort, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  boot().then((result) => {
    say(result.ok ? `App up in ${result.bootMs}ms.` : `App did not start (${result.why}).`);
  });
  server.listen(frontPort, () => say(`Supervising the app on :${frontPort} (app on :${innerPort}).`));

  const shutdown = () => {
    server.close();
    stopChild().then(() => process.exit(0));
    setTimeout(() => process.exit(0), STOP_GRACE_MS + 1000).unref();
  };
  if (!options.noSignals) {
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }
  return { server, state, stop: () => new Promise((resolve) => { server.close(); stopChild().then(resolve); }), appDir };
}

module.exports = {
  start, safePath, sameInstall, needsInstall, startCommand, buildScript, tokenMatches,
  CONTROL_PREFIX, TOKEN_HEADER,
};

// `node -e <this file>` in a draft's preview, with USERNODE_LIVE_SUPERVISOR=1.
if (process.env.USERNODE_LIVE_SUPERVISOR === '1' && (typeof require === 'undefined' || require.main === module || !module.parent)) {
  start();
}
