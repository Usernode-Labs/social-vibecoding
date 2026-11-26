// A live draft's preview supervisor (src/services/live-draft-supervisor.js),
// run the way a draft's container runs it: `node -e <the file>` in the app's
// directory, in front of the app. Covers the pure rules (safe paths, what
// counts as a new install, how the app is started, the secret's check), and,
// against a real little app in a temp directory: requests pass through, the
// control routes answer only with the secret, an edit restarts the app in
// place, an edit that breaks it says why and a fix brings it back, a
// change to what it installs is refused for a rebuild, a build whose command
// is not installed keeps the edit, and a build that fails puts it back.
//
// Run with: node --test tests/live-draft-supervisor.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const supervisor = require('../src/services/live-draft-supervisor');

const SOURCE = fs.readFileSync(path.join(__dirname, '../src/services/live-draft-supervisor.js'), 'utf8');
const TOKEN = 'd'.repeat(64);
const IMAGE_HEAD = 'a'.repeat(40);
const EDIT_HEAD = 'b'.repeat(40);

function appSource(version) {
  return `const http = require('http');
http.createServer((req, res) => {
  if (req.url === '/token') { res.end(String(process.env.USERNODE_LIVE_TOKEN || 'none')); return; }
  res.end('version ${version}');
}).listen(Number(process.env.PORT));
`;
}

// `count` free ports, all different. Every probe stays open until the last
// one has its port: a probe that closes before the next opens leaves the
// system free to hand the same port out again, and it did (PR 6935's checks:
// the supervisor and the app were both given :46371, the app could not
// listen, and seven tests failed on a restart page).
async function freePorts(count) {
  const probes = [];
  try {
    for (let i = 0; i < count; i += 1) {
      probes.push(await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server));
      }));
    }
    return probes.map((server) => server.address().port);
  } finally {
    await Promise.all(probes.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('safePath keeps paths inside the app and out of its installed packages', () => {
  assert.equal(supervisor.safePath('public/index.html'), 'public/index.html');
  assert.equal(supervisor.safePath('./server.js'), 'server.js');
  assert.equal(supervisor.safePath('a\\b.js'), 'a/b.js');
  for (const bad of ['', '/etc/passwd', '../x.js', 'a/../../x', 'node_modules/x/index.js', '.git/config', 'a\u0000b']) {
    assert.equal(supervisor.safePath(bad), null, bad);
  }
});

test('needsInstall: what package.json installs, and any lockfile, mean a rebuild', () => {
  const pkg = JSON.stringify({ name: 'a', scripts: { start: 'node server.js' }, dependencies: { express: '^4' } });
  const current = (p) => (p === 'package.json' ? pkg : null);
  const renamed = JSON.stringify({ name: 'b', scripts: { start: 'node server.js' }, dependencies: { express: '^4' } });
  const added = JSON.stringify({ name: 'a', scripts: { start: 'node server.js' }, dependencies: { express: '^4', pg: '^8' } });
  assert.equal(supervisor.needsInstall([{ path: 'server.js', content: '' }], current), false);
  assert.equal(supervisor.needsInstall([{ path: 'package.json', content: renamed }], current), false);
  assert.equal(supervisor.needsInstall([{ path: 'package.json', content: added }], current), true);
  assert.equal(supervisor.needsInstall([{ path: 'package-lock.json', content: '{}' }], current), true);
  assert.equal(supervisor.needsInstall([{ path: 'package.json', delete: true }], current), true);
});

test('startCommand runs `node <file>` on the same Node, anything else in a shell', () => {
  const node = '/usr/bin/node-x';
  assert.deepEqual(supervisor.startCommand(JSON.stringify({ scripts: { start: 'node server.js' } }), () => false, node),
    { command: node, args: ['server.js'] });
  assert.deepEqual(supervisor.startCommand(JSON.stringify({ scripts: { start: 'node src/index.js --port 1' } }), () => false, node),
    { command: node, args: ['src/index.js', '--port', '1'] });
  assert.deepEqual(supervisor.startCommand(JSON.stringify({ scripts: { start: 'npm run migrate && node s.js' } }), () => false, node),
    { command: 'sh', args: ['-c', 'npm run migrate && node s.js'] });
  assert.deepEqual(supervisor.startCommand(JSON.stringify({ main: 'app/main.js' }), () => false, node),
    { command: node, args: ['app/main.js'] });
  assert.deepEqual(supervisor.startCommand('{}', (f) => f === 'index.js', node), { command: node, args: ['index.js'] });
  assert.deepEqual(supervisor.startCommand('not json', () => false, node), { command: node, args: ['server.js'] });
});

test('tokenMatches needs the exact secret, and never matches an empty one', () => {
  assert.equal(supervisor.tokenMatches(TOKEN, TOKEN), true);
  assert.equal(supervisor.tokenMatches(`${TOKEN}x`, TOKEN), false);
  assert.equal(supervisor.tokenMatches('', TOKEN), false);
  assert.equal(supervisor.tokenMatches(undefined, TOKEN), false);
  assert.equal(supervisor.tokenMatches('anything', ''), false);
});

let dir;
let child;
let port;
let output = '';
const base = () => `http://127.0.0.1:${port}`;
const apply = (files, token = TOKEN, head = undefined) => fetch(`${base()}${supervisor.CONTROL_PREFIX}apply`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { [supervisor.TOKEN_HEADER]: token } : {}) },
  body: JSON.stringify({ files, ...(head ? { head } : {}) }),
});
const status = async () => (await fetch(`${base()}${supervisor.CONTROL_PREFIX}status`, { headers: { [supervisor.TOKEN_HEADER]: TOKEN } })).json();

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-draft-app-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'tiny', scripts: { start: 'node server.js' }, dependencies: {},
  }));
  fs.writeFileSync(path.join(dir, 'server.js'), appSource(1));
  const [outer, inner] = await freePorts(2);
  port = outer;
  child = spawn(process.execPath, ['-e', SOURCE], {
    cwd: dir,
    env: {
      ...process.env, USERNODE_LIVE_SUPERVISOR: '1', USERNODE_LIVE_TOKEN: TOKEN, USERNODE_LIVE_HEAD: IMAGE_HEAD,
      PORT: String(port), USERNODE_LIVE_INNER_PORT: String(inner),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  // Up means the app answers through the supervisor, not only the
  // supervisor's own /health: the first test reads the app's page, and a
  // supervisor that is up before its app answers with the restart page. A
  // start that never gets there fails here, once, with what the two said.
  let up = false;
  for (let i = 0; i < 150 && !up; i += 1) {
    try {
      const health = await fetch(`${base()}/health`);
      up = health.ok && (await (await fetch(`${base()}/`)).text()) === 'version 1';
    } catch {}
    if (!up) await sleep(100);
  }
  assert.ok(up, `the draft's app never answered through its supervisor:\n${output}`);
});

after(async () => {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 6000); });
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('requests pass through to the app, and /health is the supervisor\'s', async () => {
  const health = await fetch(`${base()}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).live, true);
  const page = await fetch(`${base()}/`);
  assert.equal(await page.text(), 'version 1', output);
});

test('the files start at the image\'s commit', async () => {
  assert.equal((await status()).head, IMAGE_HEAD);
});

test('the app never sees the secret', async () => {
  const res = await fetch(`${base()}/token`);
  assert.equal(await res.text(), 'none');
});

test('the control routes answer only with the secret', async () => {
  const none = await apply([{ path: 'server.js', content: appSource(9) }], null);
  assert.equal(none.status, 404);
  const wrong = await apply([{ path: 'server.js', content: appSource(9) }], 'e'.repeat(64));
  assert.equal(wrong.status, 404);
  const status = await fetch(`${base()}${supervisor.CONTROL_PREFIX}status`);
  assert.equal(status.status, 404);
  assert.equal(await (await fetch(`${base()}/`)).text(), 'version 1');
});

test('an edit restarts the app in place, and its files are the commit it names', async () => {
  const res = await apply([{ path: 'server.js', content: appSource(2) }], TOKEN, EDIT_HEAD);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal(body.head, EDIT_HEAD);
  assert.equal((await status()).head, EDIT_HEAD);
  assert.equal(typeof body.bootMs, 'number');
  assert.equal(await (await fetch(`${base()}/`)).text(), 'version 2');
  assert.equal(fs.readFileSync(path.join(dir, 'server.js'), 'utf8'), appSource(2));
});

test('an edit that breaks the app says why; the next edit brings it back', async () => {
  const broken = await apply([{ path: 'server.js', content: 'throw new Error("draft broke on purpose")\n' }]);
  const said = await broken.json();
  assert.equal(said.ok, false);
  assert.equal(said.why, 'exited');
  assert.match(said.log, /draft broke on purpose/);
  const page = await fetch(`${base()}/`);
  assert.equal(page.status, 503);
  assert.match(await page.text(), /restarting/);
  // Still reachable for the fix.
  assert.equal((await fetch(`${base()}/health`)).status, 200);
  const fixed = await apply([{ path: 'server.js', content: appSource(3) }]);
  assert.equal((await fixed.json()).ok, true);
  assert.equal(await (await fetch(`${base()}/`)).text(), 'version 3');
});

test('a new dependency is not applied: the preview is built again', async () => {
  const pkg = JSON.stringify({ name: 'tiny', scripts: { start: 'node server.js' }, dependencies: { leftpad: '1.0.0' } });
  const res = await apply([{ path: 'package.json', content: pkg }, { path: 'server.js', content: appSource(4) }]);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.needsRebuild, true);
  assert.equal(body.why, 'install');
  // Nothing of it was written, and the app still serves the last version.
  assert.equal(fs.readFileSync(path.join(dir, 'server.js'), 'utf8'), appSource(3));
  // An edit that names no commit leaves the files at none known.
  assert.equal((await status()).head, null);
  assert.equal(await (await fetch(`${base()}/`)).text(), 'version 3');
});

// The same install as the app's own package.json (dependencies: {}), with a
// build script or none: only `scripts` differ, so it is not a new install.
const withBuild = (build) => JSON.stringify({
  name: 'tiny', scripts: { start: 'node server.js', ...(build ? { build } : {}) }, dependencies: {},
});

// 24 Nov 2026: an app made from the template compiles Tailwind in
// a Dockerfile stage of its own and installs the runtime without dev
// dependencies, so the preview's image has no `tailwindcss`. Every edit's build
// failed there and was put back; the preview never showed one.
test('a build whose command is not installed keeps the edit and says so', async () => {
  const res = await apply([
    { path: 'package.json', content: withBuild('tailwindcss-not-installed-here --minify') },
    { path: 'server.js', content: appSource(5) },
  ], TOKEN, EDIT_HEAD);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal(body.buildSkipped, true);
  assert.match(body.buildLog, /not found/);
  assert.equal(body.head, EDIT_HEAD);
  assert.equal(fs.readFileSync(path.join(dir, 'server.js'), 'utf8'), appSource(5));
  assert.equal(await (await fetch(`${base()}/`)).text(), 'version 5');
});

test('a build that runs and fails puts the edit back; the app keeps the version before it', async () => {
  const res = await apply([
    { path: 'package.json', content: withBuild('node -e "process.exit(2)"') },
    { path: 'server.js', content: appSource(6) },
  ]);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.needsRebuild, true);
  assert.equal(body.why, 'build');
  assert.equal(body.buildSkipped, undefined);
  // Both files are as they were, and the app was never stopped.
  assert.equal(fs.readFileSync(path.join(dir, 'server.js'), 'utf8'), appSource(5));
  assert.match(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), /tailwindcss-not-installed-here/);
  assert.equal(await (await fetch(`${base()}/`)).text(), 'version 5');
  assert.equal((await status()).head, EDIT_HEAD);
  // Back to no build step for the tests after this one.
  const reset = await apply([{ path: 'package.json', content: withBuild(null) }]);
  const cleared = await reset.json();
  assert.equal(cleared.ok, true, JSON.stringify(cleared));
  assert.equal(cleared.buildSkipped, undefined);
});

test('files outside the app are refused', async () => {
  const res = await apply([{ path: '../escape.js', content: 'x' }]);
  assert.equal(res.status, 400);
  assert.equal(fs.existsSync(path.join(dir, '..', 'escape.js')), false);
});

test('status says how the app is, with the secret', async () => {
  const res = await fetch(`${base()}${supervisor.CONTROL_PREFIX}status`, { headers: { [supervisor.TOKEN_HEADER]: TOKEN } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ready, true);
  assert.ok(body.restarts >= 3);
});

test('an app that stops by itself is started again', async () => {
  const quitter = `const http = require('http');
const fs = require('fs');
const marker = __dirname + '/started-once';
const again = fs.existsSync(marker);
fs.writeFileSync(marker, '1');
http.createServer((req, res) => {
  if (req.url === '/quit' && !again) { res.end('bye'); setTimeout(() => process.exit(1), 50); return; }
  res.end(again ? 'started again' : 'first run');
}).listen(Number(process.env.PORT));
`;
  const res = await apply([{ path: 'server.js', content: quitter }]);
  assert.equal((await res.json()).ok, true);
  assert.equal(await (await fetch(`${base()}/`)).text(), 'first run');
  await fetch(`${base()}/quit`);
  let text = '';
  for (let i = 0; i < 50 && text !== 'started again'; i += 1) {
    await sleep(100);
    try { text = await (await fetch(`${base()}/`)).text(); } catch {}
  }
  assert.equal(text, 'started again', output);
});
