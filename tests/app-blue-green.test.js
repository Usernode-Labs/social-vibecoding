'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appManifest = require('../src/services/app-manifest');
const { createController, isEligible } = require('../src/services/app-blue-green');

function readManifest(value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-blue-green-'));
  fs.writeFileSync(path.join(dir, 'dapp.json'), JSON.stringify(value));
  try { return appManifest.read(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('manifest requires the complete rolling-safety contract', () => {
  const exact = readManifest({
    deployment: {
      strategy: 'blue-green',
      databaseCompatibility: 'expand-contract',
      backgroundWork: 'none',
    },
  });
  assert.equal(isEligible(exact.deployment), true);
  assert.equal(isEligible(readManifest({}).deployment), false);
  assert.equal(isEligible(readManifest({ deployment: { strategy: 'blue-green' } }).deployment), false);
  assert.equal(isEligible(readManifest({
    deployment: {
      strategy: 'blue-green',
      databaseCompatibility: 'blocking',
      backgroundWork: 'none',
    },
  }).deployment), false);
});

function fixture(initial = {}, opts = {}) {
  const state = new Map(Object.entries(initial).map(([name, status]) => [name, { status, id: `id-${name}` }]));
  const events = [];
  let edgeCalls = 0;
  const docker = {
    async inspectContainer(name) {
      const row = state.get(name);
      return row ? { status: row.status, labels: {} } : { status: 'not_found', labels: {} };
    },
    async runContainer(name) {
      events.push(`run:${name}`);
      state.set(name, { status: 'running', id: 'id-new' });
      return 'id-new';
    },
    async waitForHealthy(name) {
      events.push(`wait:${name}`);
      if (opts.candidateFails && name.endsWith('--next')) {
        const err = new Error('candidate unhealthy');
        err.healthcheckFailed = true;
        throw err;
      }
      return { attempts: 1, waitedMs: 0 };
    },
    async probeHealthOnce(name) {
      events.push(`probe:${name}`);
      return state.get(name)?.status === 'running';
    },
    async renameContainer(from, to) {
      events.push(`rename:${from}->${to}`);
      if (opts.candidateRenameFails && from.endsWith('--next') && !to.endsWith('--old')) {
        throw new Error('candidate rename failed');
      }
      if (opts.rollbackRenameFails && to.endsWith('--failed')) {
        throw new Error('rollback rename failed');
      }
      assert.ok(state.has(from), `rename source ${from} exists`);
      assert.equal(state.has(to), false, `rename target ${to} is free`);
      const row = state.get(from);
      state.delete(from);
      state.set(to, row);
    },
    async stopAndRemove(name) {
      events.push(`remove:${name}`);
      if (opts.oldRemoveFails && name.endsWith('--old')) {
        return { removed: false, error: 'device busy' };
      }
      state.delete(name);
      return { removed: true, stopMs: 1, forceKilled: false, error: null };
    },
  };
  const caddy = {
    async probeEdge() {
      edgeCalls += 1;
      events.push('edge');
      if (opts.edgeFailsAt === edgeCalls) return { ok: true, code: 502, error: null };
      return { ok: true, code: 200, error: null };
    },
  };
  const controller = createController({
    docker, caddy,
    log: { info() {}, warn() {} },
    sleep: async () => {},
    maxParallel: 1,
    drainMs: 0,
    checkIntervalMs: 100,
  });
  return { state, events, controller };
}

test('healthy candidate cuts over before the old container drains', async () => {
  const stable = 'usernode-app-demo';
  const f = fixture({ [stable]: 'running' });
  const out = await f.controller.deploy({ slug: 'demo', image: 'img', env: {}, hostname: 'demo.example' });
  assert.deepEqual(out, { containerId: 'id-new', strategy: 'blue-green' });
  assert.equal(f.state.get(stable)?.id, 'id-new');
  const ready = f.events.indexOf(`wait:${stable}--next`);
  const firstRename = f.events.indexOf(`rename:${stable}->${stable}--old`);
  const oldRemoved = f.events.indexOf(`remove:${stable}--old`);
  assert.ok(ready >= 0 && ready < firstRename, 'candidate readiness precedes live mutation');
  assert.ok(oldRemoved > firstRename, 'old is retained through cutover verification');
});

test('candidate failure leaves the old stable container untouched', async () => {
  const stable = 'usernode-app-demo';
  const f = fixture({ [stable]: 'running' }, { candidateFails: true });
  await assert.rejects(
    f.controller.deploy({ slug: 'demo', image: 'img', env: {}, hostname: 'demo.example' }),
    /candidate unhealthy/
  );
  assert.equal(f.state.get(stable)?.id, `id-${stable}`);
  assert.equal(f.events.some((e) => e.startsWith(`rename:${stable}->`)), false);
  assert.ok(f.events.includes(`remove:${stable}--next`));
});

test('candidate name-swap failure restores the old stable identity', async () => {
  const stable = 'usernode-app-demo';
  const f = fixture({ [stable]: 'running' }, { candidateRenameFails: true });
  await assert.rejects(
    f.controller.deploy({ slug: 'demo', image: 'img', env: {}, hostname: 'demo.example' }),
    /candidate rename failed/
  );
  assert.equal(f.state.get(stable)?.id, `id-${stable}`);
  assert.equal(f.state.has(`${stable}--next`), false);
});

test('failed post-cutover edge verification restores the old version', async () => {
  const stable = 'usernode-app-demo';
  const f = fixture({ [stable]: 'running' }, { edgeFailsAt: 1 });
  await assert.rejects(
    f.controller.deploy({ slug: 'demo', image: 'img', env: {}, hostname: 'demo.example' }),
    /edge probe failed/
  );
  assert.equal(f.state.get(stable)?.id, `id-${stable}`);
  assert.ok(f.events.includes(`rename:${stable}->${stable}--failed`));
  assert.ok(f.events.includes(`rename:${stable}--old->${stable}`));
  assert.ok(f.events.includes(`remove:${stable}--failed`));
});

test('rollback removes failed stable if Docker cannot rename it aside', async () => {
  const stable = 'usernode-app-demo';
  const f = fixture({ [stable]: 'running' }, { edgeFailsAt: 1, rollbackRenameFails: true });
  await assert.rejects(
    f.controller.deploy({ slug: 'demo', image: 'img', env: {}, hostname: 'demo.example' }),
    /edge probe failed/
  );
  assert.equal(f.state.get(stable)?.id, `id-${stable}`);
  assert.ok(f.events.includes(`remove:${stable}`), 'failed new stable is removed before restore');
});

test('an undrainable rollback slot restores old instead of leaking overlap', async () => {
  const stable = 'usernode-app-demo';
  const f = fixture({ [stable]: 'running' }, { oldRemoveFails: true });
  await assert.rejects(
    f.controller.deploy({ slug: 'demo', image: 'img', env: {}, hostname: 'demo.example' }),
    /rollback-slot drain failed/
  );
  assert.equal(f.state.get(stable)?.id, `id-${stable}`);
  assert.equal(f.state.has(`${stable}--failed`), false);
});

test('first deploy promotes a ready candidate with no rollback slot', async () => {
  const stable = 'usernode-app-demo';
  const f = fixture();
  await f.controller.deploy({ slug: 'demo', image: 'img', env: {}, hostname: 'demo.example' });
  assert.equal(f.state.get(stable)?.id, 'id-new');
  assert.equal(f.events.some((e) => e.includes('--old')), false);
});

test('failed edge check with no old version keeps the only ready stable target', async () => {
  const stable = 'usernode-app-demo';
  const f = fixture({}, { edgeFailsAt: 1 });
  await assert.rejects(
    f.controller.deploy({ slug: 'demo', image: 'img', env: {}, hostname: 'demo.example' }),
    /edge probe failed/
  );
  assert.equal(f.state.get(stable)?.id, 'id-new');
});

test('interrupted cutover recovery prefers the prior production slot', async () => {
  const stable = 'usernode-app-demo';
  const f = fixture({ [`${stable}--old`]: 'running', [`${stable}--next`]: 'running' });
  const recovered = await f.controller.recoverSlots({
    stableName: stable, nextName: `${stable}--next`, oldName: `${stable}--old`, port: 3000,
  });
  assert.equal(recovered.status, 'running');
  assert.equal(f.state.get(stable)?.id, `id-${stable}--old`);
  assert.equal(f.state.has(`${stable}--next`), false);
});

test('dead stable never causes the only runnable old version to be deleted', async () => {
  const stable = 'usernode-app-demo';
  const f = fixture({
    [stable]: 'exited',
    [`${stable}--old`]: 'running',
    [`${stable}--next`]: 'running',
  });
  await f.controller.recoverSlots({
    stableName: stable, nextName: `${stable}--next`, oldName: `${stable}--old`, port: 3000,
  });
  assert.equal(f.state.get(stable)?.id, `id-${stable}--old`);
  assert.equal(f.state.has(`${stable}--next`), false);
  assert.ok(f.events.indexOf(`rename:${stable}--old->${stable}`)
    < f.events.indexOf(`remove:${stable}--next`));
});

test('healthy next recovers an empty-or-dead first-deploy slot', async () => {
  const stable = 'usernode-app-demo';
  const f = fixture({ [stable]: 'exited', [`${stable}--next`]: 'running' });
  await f.controller.recoverSlots({
    stableName: stable, nextName: `${stable}--next`, oldName: `${stable}--old`, port: 3000,
  });
  assert.equal(f.state.get(stable)?.id, `id-${stable}--next`);
});

test('global admission cap allows only one candidate overlap when set to one', async () => {
  const state = new Map();
  const events = [];
  let releaseFirst;
  let firstReached;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise((resolve) => { firstReached = resolve; });
  const docker = {
    async inspectContainer(name) {
      return state.has(name) ? { status: 'running', labels: {} } : { status: 'not_found', labels: {} };
    },
    async runContainer(name) { state.set(name, true); events.push(`run:${name}`); return `id-${name}`; },
    async waitForHealthy(name) {
      if (name === 'usernode-app-a--next') { firstReached(); await firstGate; }
      return { attempts: 1, waitedMs: 0 };
    },
    async probeHealthOnce(name) { return state.has(name); },
    async renameContainer(from, to) { state.delete(from); state.set(to, true); },
    async stopAndRemove(name) { state.delete(name); return { removed: true }; },
  };
  const controller = createController({
    docker,
    caddy: { async probeEdge() { return { ok: true, code: 200 }; } },
    log: { info() {}, warn() {} },
    sleep: async () => {}, maxParallel: 1, drainMs: 0,
  });
  const first = controller.deploy({ slug: 'a', image: 'img', env: {}, hostname: 'a.example' });
  await firstStarted;
  const second = controller.deploy({ slug: 'b', image: 'img', env: {}, hostname: 'b.example' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.includes('run:usernode-app-b--next'), false, 'second candidate waits for admission');
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(events.includes('run:usernode-app-b--next'), true);
});

test('Caddy and new scaffold pin retry, opt-in, and graceful drain contracts', () => {
  const root = path.join(__dirname, '..');
  const caddy = fs.readFileSync(path.join(root, 'Caddyfile'), 'utf8');
  const template = fs.readFileSync(path.join(root, 'src/services/template.js'), 'utf8');
  assert.match(caddy, /lb_try_duration 3s/);
  assert.match(caddy, /lb_try_interval 100ms/);
  assert.match(template, /databaseCompatibility: 'expand-contract'/);
  assert.match(template, /backgroundWork: 'none'/);
  assert.match(template, /process\.on\('SIGTERM'/);
  assert.match(template, /status\(503\).*shutting_down/);
});
