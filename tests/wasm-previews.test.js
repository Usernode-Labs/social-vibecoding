// Wasm previews, a pilot (runtime/wasm/README.md): the rules the platform
// shares about a preview's Wasm twin (src/services/wasm-previews.js), how the
// databases and the sweeps see a twin's copy, and the app gate's part: the
// platform's pass passed on, an operation ID on every write, and one more
// send, with the same ID, when a runner fails before answering.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');

const previews = require('../src/services/wasm-previews');
const dbManager = require('../src/services/db-manager');
const { createGate } = require('../scripts/app-gate');

const ATTEMPT = 'app_grocery_staging_s101_abc123';

function withEnv(vars, fn) {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  previews._resetForTest();
  try { return fn(); } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    previews._resetForTest();
  }
}

const passKey = crypto.generateKeyPairSync('ed25519');
const passEnv = { WASM_PASS_KEY: passKey.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };

test('a twin database is its attempt database with _w, short enough for its owner login', () => {
  assert.equal(previews.twinDb(ATTEMPT), `${ATTEMPT}_w`);
  assert.ok(previews.isTwinDb(`${ATTEMPT}_w`));
  assert.equal(previews.isTwinDb(ATTEMPT), false);
  // The longest attempt name (57 bytes) still leaves room for `_owner`.
  const long = `app_${'x'.repeat(57 - 'app_'.length - '_staging_s123456_abcdef'.length)}_staging_s123456_abcdef`;
  assert.equal(long.length, 57);
  const twin = previews.twinDb(long);
  assert.ok(twin.length + '_owner'.length <= 63, twin);
  assert.ok(twin.endsWith('_staging_s123456_abcdef_w'));
  // A name that is not an attempt's (a platform preview, an older build) gets none.
  assert.equal(previews.twinDb('app_grocery_staging_s101_latest'), null);
  assert.equal(previews.twinDb('app_grocery'), null);
});

test('a twin copy is a preview database: on the preview server and swept with its session', () => {
  assert.ok(dbManager.isStagingCloneDb(`${ATTEMPT}_w`));
  assert.ok(dbManager.isStagingCloneDb(ATTEMPT));
  assert.equal(dbManager.isStagingCloneDb(`${ATTEMPT}_x`), false);
  const reap = require('node:fs').readFileSync(require.resolve('../src/services/staging-reap.js'), 'utf8');
  const re = new RegExp(/const STAGING_DB_NAME_RE = \/(.+)\/;/.exec(reap)[1]);
  assert.deepEqual(re.exec(`${ATTEMPT}_w`).slice(1, 3), ['101', 'abc123_w']);
});

test('a twin address is its preview address with --wasm, which the gate reads as that preview', () => {
  assert.equal(previews.twinLabel('grocery', 101), 'grocery--s101--wasm');
  assert.deepEqual(previews.twinOfLabel('grocery--s101--wasm'), { slug: 'grocery', sessionId: 101 });
  assert.equal(previews.twinOfLabel('grocery--s101'), null);
  assert.equal(previews.twinOfLabel('grocery'), null);
  const { parseAppHost } = require('../src/services/app-access');
  const parsed = parseAppHost(`grocery--s101--wasm.${process.env.USERNODE_PREVIEWS_DOMAIN || process.env.USERNODE_APPS_DOMAIN || 'onhomeroom.app'}`);
  if (parsed) assert.equal(parsed.slug, 'grocery');
});

test('a pass names the project, preview, module, database and person, signed with Ed25519', () => withEnv(passEnv, () => {
  const mod = 'a'.repeat(64);
  const now = Date.UTC(2026, 10, 27, 12, 0, 0);
  const pass = previews.signPass({ appId: 7, sessionId: 101, moduleHash: mod, db: `${ATTEMPT}_w`, userId: 42 }, { now });
  const [body, sig] = pass.split('.');
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  assert.deepEqual(claims, { v: 1, app: 7, ses: 101, mod, db: `${ATTEMPT}_w`, user: 42, scope: 'req', exp: now / 1000 + 60 });
  assert.ok(crypto.verify(null, Buffer.from(body), passKey.publicKey, Buffer.from(sig, 'base64url')));
  // The raw public half the runners and the data service are given.
  const raw = Buffer.from(previews.passPublicKey(), 'base64');
  assert.equal(raw.length, 32);
  const spki = passKey.publicKey.export({ format: 'der', type: 'spki' });
  assert.deepEqual(raw, spki.subarray(spki.length - 32));
  const setup = previews.signPass({ appId: 7, sessionId: 101, moduleHash: mod, db: `${ATTEMPT}_w`, scope: 'setup' }, { now });
  assert.equal(JSON.parse(Buffer.from(setup.split('.')[0], 'base64url').toString()).exp, now / 1000 + 300);
  // What the twin's code finds in process.env rides in the pass, as its container's env would.
  const env = previews.twinEnv({ name: 'Grocery List', slug: 'grocery' });
  assert.equal(env.USERNODE_APP_NAME, 'Grocery List');
  assert.equal(env.USERNODE_APP_SLUG, 'grocery');
  const withEnv = previews.signPass({ appId: 7, sessionId: 101, moduleHash: mod, db: `${ATTEMPT}_w`, env }, { now });
  assert.deepEqual(JSON.parse(Buffer.from(withEnv.split('.')[0], 'base64url').toString()).env, env);
  assert.throws(() => previews.signPass({ appId: 7, sessionId: 101, moduleHash: mod, db: ATTEMPT }), /twin database/);
  assert.throws(() => previews.signPass({ appId: 7, sessionId: 101, moduleHash: 'nope', db: `${ATTEMPT}_w` }), /SHA-256/);
}));

test('a twin login password is derived from the database name, and only for twins', () => {
  withEnv({ WASM_DB_SECRET: 's'.repeat(40) }, () => {
    const p = previews.dbPassword(`${ATTEMPT}_w`);
    assert.match(p, /^[0-9a-f]{64}$/);
    assert.equal(p, crypto.createHmac('sha256', 's'.repeat(40)).update(`${ATTEMPT}_w`).digest('hex'));
    assert.throws(() => previews.dbPassword(ATTEMPT), /twin/);
  });
  withEnv({ WASM_DB_SECRET: 'short' }, () => assert.throws(() => previews.dbPassword(`${ATTEMPT}_w`), /WASM_DB_SECRET/));
});

test('only a Kubernetes deploy with WASM_PREVIEWS=on builds twins, and only for listed projects', async () => {
  const pool = { query: async () => ({ rows: [{ value: '[7, 9]' }] }) };
  const on = { wasmPreviews: { mode: 'on' }, appRuntime: 'kubernetes' };
  assert.equal(await previews.enabledFor(on, pool, 7), true);
  assert.equal(await previews.enabledFor(on, pool, 8), false);
  assert.equal(await previews.enabledFor({ ...on, wasmPreviews: { mode: 'off' } }, pool, 7), false);
  assert.equal(await previews.enabledFor({ ...on, appRuntime: 'docker' }, pool, 7), false);
  const broken = { query: async () => { throw new Error('down'); } };
  assert.equal(await previews.enabledFor(on, broken, 7), false);
  assert.equal(previews.validate([1, 2]), null);
  assert.match(previews.validate('1'), /list/);
  assert.match(previews.validate([0]), /ids/);
});

test('the gate passes a twin request on with the pass, an operation ID per write, and sends it once more if the runner dies first', async () => {
  const pass = 'PASS.SIG';
  const platform = http.createServer((req, res) => {
    res.writeHead(200, {
      'x-usernode-upstream': 'usernode-wasm-runner', 'x-usernode-runtime': 'wasm',
      'x-usernode-pass': pass, 'x-usernode-identity': 'ID.TOKEN',
    });
    res.end('ok');
  });
  const seen = [];
  let drops = 1;
  const runner = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      // The first write: the runner goes away after reading it, before answering.
      if (req.method === 'POST' && drops > 0) { drops -= 1; req.socket.destroy(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ n: seen.length }));
    });
  });
  const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
  const platformPort = await listen(platform);
  const runnerPort = await listen(runner);
  const gate = createGate({
    platformUrl: `http://127.0.0.1:${platformPort}`,
    resolveUpstream: () => ({ host: '127.0.0.1', port: runnerPort }),
    log: { error() {}, warn() {} },
  });
  const gatePort = await listen(gate);
  const ask = (method, path, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: gatePort, method, path,
      headers: { host: 'grocery--s101--wasm.example', ...headers, ...(body ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.end(body || undefined);
  });
  try {
    const write = await ask('POST', '/api/items', '{"text":"milk"}', { 'x-usernode-pass': 'forged', 'x-usernode-op': 'mine' });
    assert.equal(write.status, 200);
    const posts = seen.filter((s) => s.method === 'POST');
    assert.equal(posts.length, 2, 'sent once more after the runner died');
    assert.equal(posts[0].headers['x-usernode-op'], posts[1].headers['x-usernode-op'], 'with the same operation ID');
    assert.match(posts[0].headers['x-usernode-op'], /^[0-9a-f-]{36}$/);
    assert.notEqual(posts[0].headers['x-usernode-op'], 'mine', "a client's operation ID is never used");
    for (const p of posts) {
      assert.equal(p.headers['x-usernode-pass'], pass, "the platform's pass, never the client's");
      assert.equal(p.headers['x-usernode-token'], 'ID.TOKEN');
      assert.equal(p.body, '{"text":"milk"}');
    }
    const read = await ask('GET', '/api/list');
    assert.equal(read.status, 200);
    const get = seen.find((s) => s.method === 'GET');
    assert.equal(get.headers['x-usernode-op'], undefined, 'a read carries no operation ID');
    assert.equal(get.headers['x-usernode-pass'], pass);
  } finally {
    for (const s of [gate, runner, platform]) {
      if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
      await new Promise((r) => s.close(() => r()));
    }
  }
});

test('the runners are Kata microVMs with no init container, one per node, and their keys only from the Secret', () => {
  const { wasmRunnerManifest, wasmDataManifest } = require('../src/services/kubernetes')._wasmManifestsForTest;
  const cfg = { generatedAppServiceAccount: 'social-generated-app', wasmRunnerImage: 'r@sha256:1', wasmDataImage: 'd@sha256:2',
    wasmRuntimeClass: 'kata', wasmRunnerReplicas: 2, wasmWarm: 0 };
  const runner = wasmRunnerManifest({ namespace: 'social-apps', cfg, name: previews.RUNNER_NAME, platformUrl: 'http://platform' });
  const pod = runner.spec.template.spec;
  assert.equal(pod.runtimeClassName, 'kata');
  // Work in an init container killed a Kata VM 45 s in (27 Nov 2026).
  assert.equal(pod.initContainers, undefined);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution[0].topologyKey, 'kubernetes.io/hostname');
  const env = new Map(pod.containers[0].env.map((e) => [e.name, e]));
  for (const key of ['WASM_PASS_PUBKEY', 'WASM_RUNNER_TOKEN', 'USERNODE_JWT_PUBLIC_KEY']) {
    assert.ok(env.get(key).valueFrom.secretKeyRef, `${key} comes from the Secret`);
  }
  assert.equal(env.get('WASM_MODULE_URL').value, 'http://platform/internal/wasm/modules');
  assert.equal(env.get('WASM_DATA_ADDR').value, `${previews.DATA_NAME}.social-apps.svc:3000`);
  assert.equal(env.get('WASM_WARM').value, '0');
  assert.equal(env.has('WASM_DB_SECRET'), false, 'a runner never holds the database secret');
  // Runners carry no environment label, so the preview database never admits them.
  assert.equal(runner.spec.template.metadata.labels['social.usernode.io/environment'], undefined);
  const data = wasmDataManifest({ namespace: 'social-apps', cfg, name: previews.DATA_NAME, pgHost: '10.0.0.5', pgPort: 5432 });
  const dataPod = data.spec.template.spec;
  assert.equal(dataPod.runtimeClassName, undefined);
  assert.equal(data.spec.template.metadata.labels['social.usernode.io/environment'], 'staging');
  const dataEnv = new Map(dataPod.containers[0].env.map((e) => [e.name, e]));
  assert.equal(dataEnv.get('WASM_PG_HOST').value, '10.0.0.5');
  assert.ok(dataEnv.get('WASM_DB_SECRET').valueFrom.secretKeyRef);
  assert.equal(dataPod.containers[0].ports[0].containerPort, 3000);
});
