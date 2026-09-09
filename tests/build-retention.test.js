const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { sweep, stop } = require('../src/services/build-retention');
const { createGuard } = require('../src/services/build-retention-guard');
const { BUILD_RETENTION_LOCK } = require('../src/services/advisory-locks');
const kubernetes = require('../src/services/kubernetes');

const config = { appRuntime: 'kubernetes', kubernetes: { buildNamespace: 'social-builds' } };
const now = Date.parse('2026-09-10T12:00:00Z');
const hour = 3600000;
function build(name, hours = 49) {
  return {
    metadata: { name, namespace: 'social-builds', uid: `uid-${name}`, resourceVersion: '10',
      labels: { 'app.kubernetes.io/managed-by': 'social-vibecoding-runtime', 'social.usernode.io/app-id': '7' } },
    status: { latestImage: `registry.example/${name}@sha256:${'a'.repeat(64)}`,
      conditions: [{ type: 'Succeeded', status: 'True', lastTransitionTime: new Date(now - hours * hour).toISOString() }] },
  };
}
function harness(builds = [build('old')]) {
  const state = { refs: [], freshRefs: [], images: [], freshImages: [], deleted: [], events: [], busy: false, released: [], current: new Map() };
  const rows = (refs, images) => ({ rows: [...refs.map((ref) => ({ ref })), ...images.map((image) => ({ ref: null, image }))] });
  const pool = {
    query: async (sql) => {
      assert.match(sql, /FROM apps/);
      assert.match(sql, /FROM chat_sessions/);
      assert.match(sql, /image_ref AS image FROM apps/);
      assert.match(sql, /staging_image_ref AS image FROM chat_sessions/);
      return rows(state.refs, state.images);
    },
    connect: async () => ({
      query: async (sql, args) => {
        state.events.push(sql);
        if (sql.includes('pg_try_advisory_lock')) {
          assert.deepEqual(args, [BUILD_RETENTION_LOCK, 0]);
          return { rows: [{ acquired: !state.busy }] };
        }
        if (sql.includes('pg_advisory_unlock')) return { rows: [] };
        return rows(state.freshRefs, state.freshImages);
      },
      release: (err) => state.released.push(err),
    }),
  };
  const runtime = {
    listManagedBuilds: async () => builds,
    readBuild: async (_, name) => state.current.get(name) || structuredClone(builds.find((b) => b.metadata.name === name)),
    deleteBuildSnapshot: async (_, current) => { state.deleted.push(current.metadata.name); },
  };
  return { state, pool, runtime, run: (options = {}) => sweep(config, { now, dryRun: false, pool, runtime, ...options }) };
}

test('retention defaults to a read-only preview and Docker never reads either inventory', async () => {
  const h = harness();
  const preview = await sweep(config, { now, pool: h.pool, runtime: h.runtime });
  assert.deepEqual(preview.candidates, ['social-builds/old']);
  assert.deepEqual(h.state.deleted, []);
  assert.deepEqual(h.state.events, []);
  const docker = await sweep({ appRuntime: 'docker' });
  assert.equal(docker.examined, 0);
});

test('only expired, successful, standalone, managed Builds with reliable metadata qualify', async () => {
  const changes = [
    (b) => { b.status.conditions[0].status = 'Unknown'; },
    (b) => { b.status.conditions[0].status = 'False'; },
    (b) => { delete b.status; },
    (b) => { delete b.status.latestImage; },
    (b) => { delete b.status.conditions[0].lastTransitionTime; b.metadata.creationTimestamp = '2020-01-01T00:00:00Z'; },
    (b) => { b.status.conditions[0].lastTransitionTime = 'invalid'; },
    (b) => { b.metadata.namespace = 'other'; },
    (b) => { b.metadata.labels['app.kubernetes.io/managed-by'] = 'other'; },
    (b) => { delete b.metadata.labels['social.usernode.io/app-id']; },
    (b) => { delete b.metadata.uid; },
    (b) => { delete b.metadata.resourceVersion; },
    (b) => { b.metadata.deletionTimestamp = new Date(now).toISOString(); },
    (b) => { b.metadata.ownerReferences = [{ kind: 'Image', uid: 'image' }]; },
  ];
  const protectedBuilds = changes.map((change, i) => { const b = build(`skip-${i}`); change(b); return b; });
  const h = harness([...protectedBuilds, build('recent', 47.99), build('future', -1), build('boundary', 48), build('old', 72)]);
  await h.run();
  assert.deepEqual(h.state.deleted, ['old', 'boundary']);
});

test('production and preview references are protected; a new reference is rechecked under the lock', async () => {
  const h = harness([build('production'), build('preview'), build('race'), build('expired')]);
  h.state.refs = ['social-builds/production', 'social-builds/preview'];
  h.state.freshRefs = [...h.state.refs, 'social-builds/race'];
  await h.run();
  assert.deepEqual(h.state.deleted, ['expired']);
  assert.match(h.state.events[0], /pg_try_advisory_lock/);
  assert.match(h.state.events[1], /FROM apps/);
  assert.match(h.state.events[2], /pg_advisory_unlock/);
});

test('an active deployment in any instance defers cleanup without waiting', async () => {
  const h = harness();
  h.state.busy = true;
  const result = await h.run();
  assert.equal(result.busy, true);
  assert.deepEqual(h.state.deleted, []);
  assert.equal(h.state.events.length, 1);
  assert.deepEqual(h.state.released, [undefined]);
});

test('legacy production and preview image references protect Builds even without build_ref', async () => {
  const production = build('legacy-production');
  const preview = build('legacy-preview');
  const h = harness([production, preview, build('expired')]);
  h.state.images = [production.status.latestImage, preview.status.latestImage];
  h.state.freshImages = [...h.state.images];
  const dryRun = await h.run({ dryRun: true });
  assert.deepEqual(dryRun.candidates, ['social-builds/expired']);
  await h.run();
  assert.deepEqual(h.state.deleted, ['expired']);
});

test('an image reference added during inventory is rechecked under the deployment lock', async () => {
  const current = build('newly-deployed-image');
  const h = harness([current, build('expired')]);
  h.state.freshImages = [current.status.latestImage];
  await h.run();
  assert.deepEqual(h.state.deleted, ['expired']);
  assert.match(h.state.events[0], /pg_try_advisory_lock/);
  assert.match(h.state.events[1], /image_ref AS image/);
});

test('all Builds producing the deployed digest remain protected', async () => {
  const first = build('first');
  const second = build('second');
  second.status.latestImage = first.status.latestImage;
  const h = harness([first, second]);
  h.state.images = [first.status.latestImage];
  assert.deepEqual((await h.run()).candidates, []);
  assert.deepEqual(h.state.deleted, []);
});

test('completion window is configurable and invalid values cannot delete anything', async () => {
  const h = harness([build('old', 49)]);
  assert.deepEqual((await sweep({ ...config, kubernetes: { ...config.kubernetes, successfulBuildRetentionHours: 72 } },
    { now, pool: h.pool, runtime: h.runtime })).candidates, []);
  for (const value of [0, -1, NaN, Infinity, 'invalid']) {
    await assert.rejects(sweep({ ...config, kubernetes: { ...config.kubernetes, successfulBuildRetentionHours: value } },
      { now, dryRun: false, pool: h.pool, runtime: h.runtime }), /must be at least 1/);
  }
  assert.deepEqual(h.state.deleted, []);
});

test('each sweep attempts at most 20 deletions, oldest completion first', async () => {
  const h = harness(Array.from({ length: 25 }, (_, i) => build(`old-${i}`, 49 + i)));
  const result = await h.run();
  assert.equal(result.deleted.length, 20);
  assert.deepEqual(h.state.deleted, Array.from({ length: 20 }, (_, i) => `old-${24 - i}`));
});

test('changed or replaced Build snapshots are skipped', async () => {
  const h = harness([build('replaced'), build('changed'), build('running')]);
  const replaced = build('replaced'); replaced.metadata.uid = 'replacement';
  const changed = build('changed'); changed.metadata.resourceVersion = '11';
  const running = build('running'); running.status.conditions[0].status = 'Unknown';
  for (const b of [replaced, changed, running]) h.state.current.set(b.metadata.name, b);
  await h.run();
  assert.deepEqual(h.state.deleted, []);
});

for (const failure of ['kubernetes-list', 'database-list', 'database-recheck', 'kubernetes-read', 'delete']) {
  test(`${failure} failure stops the pass and never treats missing information as unreferenced`, async () => {
    const h = harness([build('first'), build('second')]);
    const fail = async () => { throw new Error('unavailable'); };
    if (failure === 'kubernetes-list') h.runtime.listManagedBuilds = fail;
    if (failure === 'database-list') h.pool.query = fail;
    if (failure === 'database-recheck') {
      const connect = h.pool.connect;
      h.pool.connect = async () => {
        const client = await connect(); const query = client.query;
        client.query = (sql, args) => sql.includes('FROM apps') ? fail() : query(sql, args);
        return client;
      };
    }
    if (failure === 'kubernetes-read') h.runtime.readBuild = fail;
    if (failure === 'delete') h.runtime.deleteBuildSnapshot = fail;
    await assert.rejects(h.run(), /unavailable/);
    assert.deepEqual(h.state.deleted, []);
    if (h.state.events.length) assert.match(h.state.events.at(-1), /pg_advisory_unlock/);
  });
}

test('404 and precondition conflicts are skipped; conflicts still count toward the cap', async () => {
  const h = harness(Array.from({ length: 25 }, (_, i) => build(`old-${i}`)));
  let attempts = 0;
  h.runtime.deleteBuildSnapshot = async () => { attempts++; throw Object.assign(new Error('changed'), { code: attempts % 2 ? 404 : 409 }); };
  const result = await h.run();
  assert.equal(attempts, 20);
  assert.deepEqual(result.deleted, []);
});

test('failed unlock destroys the pooled connection and stops further deletions', async () => {
  const h = harness([build('first'), build('second')]);
  const connect = h.pool.connect;
  h.pool.connect = async () => {
    const client = await connect(); const query = client.query;
    client.query = (sql, args) => {
      if (sql.includes('pg_advisory_unlock')) throw new Error('unlock failed');
      return query(sql, args);
    };
    return client;
  };
  await assert.rejects(h.run(), /unlock failed/);
  assert.deepEqual(h.state.deleted, ['first']);
  assert.match(h.state.released[0].message, /unlock failed/);
});

test('shutdown stops deletion before the next candidate', async () => {
  const h = harness([build('first'), build('second')]);
  await h.run({ shouldStop: () => h.state.deleted.length > 0 });
  assert.deepEqual(h.state.deleted, ['first']);
});

test('Kubernetes inventory follows pagination and deletion supplies identity preconditions', async (t) => {
  t.after(() => kubernetes._setClientsForTest(null));
  const listed = [];
  let deleted;
  kubernetes._setClientsForTest({ custom: {
    listNamespacedCustomObject: async (args) => {
      listed.push(args);
      return { items: [build(args._continue ? 'second' : 'first')], metadata: { continue: args._continue ? '' : 'next-page' } };
    },
    deleteNamespacedCustomObject: async (args) => { deleted = args; },
  } });
  const inventory = await kubernetes.listManagedBuilds(config);
  assert.equal(inventory.length, 2);
  assert.equal(listed[1]._continue, 'next-page');
  assert.equal(listed[0].namespace, 'social-builds');
  assert.match(listed[0].labelSelector, /managed-by=social-vibecoding-runtime/);
  await kubernetes.deleteBuildSnapshot(config, inventory[0]);
  assert.deepEqual(deleted.body, { propagationPolicy: 'Background', preconditions: { uid: 'uid-first', resourceVersion: '10' } });
  assert.equal(deleted.plural, 'builds');
  await assert.rejects(kubernetes.deleteBuildSnapshot(config, { metadata: { name: 'unsafe' } }), /requires UID/);
});

test('malformed Kubernetes inventory fails closed', async (t) => {
  t.after(() => kubernetes._setClientsForTest(null));
  kubernetes._setClientsForTest({ custom: { listNamespacedCustomObject: async () => ({}) } });
  await assert.rejects(kubernetes.listManagedBuilds(config), /Invalid kpack Build inventory/);
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
function guardHarness() {
  const clients = [];
  let lockLosses = 0;
  const guard = createGuard({ makeClient: () => {
    const client = new EventEmitter();
    client.connected = false; client.ended = false;
    client.connect = async () => { client.connected = true; };
    client.query = async (sql, args) => {
      assert.match(sql, /pg_advisory_lock_shared/);
      assert.deepEqual(args, [BUILD_RETENTION_LOCK, 0]);
    };
    client.end = async () => { client.ended = true; client.emit('end'); };
    clients.push(client);
    return client;
  }, onLockLost: () => { lockLosses++; } });
  return { guard, clients, lockLosses: () => lockLosses };
}

test('overlapping deployments share one connection and keep the lock through both reference writes', async () => {
  const h = guardHarness();
  const entered = deferred(); const finishA = deferred(); const finishB = deferred();
  let enteredCount = 0;
  const run = (finish) => h.guard.withBuildUse(config, async () => {
    if (++enteredCount === 2) entered.resolve();
    await finish.promise;
    assert.equal(h.clients[0].ended, false, 'reference persistence still protected');
  });
  const a = run(finishA); const b = run(finishB);
  await entered.promise;
  assert.equal(h.clients.length, 1);
  finishA.resolve(); await a;
  assert.equal(h.clients[0].ended, false);
  finishB.resolve(); await b;
  assert.equal(h.clients[0].ended, true);
  assert.equal(h.lockLosses(), 0);
});

test('deployment errors release the lock; the next deployment acquires a new session', async () => {
  const h = guardHarness();
  await assert.rejects(h.guard.withBuildUse(config, async () => { throw new Error('deploy failed'); }), /deploy failed/);
  assert.equal(h.clients[0].ended, true);
  assert.equal(await h.guard.withBuildUse(config, async () => 'persisted'), 'persisted');
  assert.equal(h.clients.length, 2);
});

test('Docker deploys need no lock connection', async () => {
  const h = guardHarness();
  assert.equal(await h.guard.withBuildUse({ appRuntime: 'docker' }, async () => 'docker'), 'docker');
  assert.equal(h.clients.length, 0);
});

test('a failed lock acquisition prevents deployment and closes the failed connection', async () => {
  let ended = false;
  const guard = createGuard({ makeClient: () => Object.assign(new EventEmitter(), {
    connect: async () => {},
    query: async () => { throw new Error('database unavailable'); },
    end: async () => { ended = true; },
  }) });
  await assert.rejects(guard.withBuildUse(config, async () => assert.fail('must not deploy')), /database unavailable/);
  assert.equal(ended, true);
});

test('loss of a held session lock invokes fail-closed handling once', async () => {
  const h = guardHarness();
  const entered = deferred(); const finish = deferred();
  const deploy = h.guard.withBuildUse(config, async () => { entered.resolve(); await finish.promise; });
  await entered.promise;
  h.clients[0].emit('error', new Error('connection lost'));
  h.clients[0].emit('end');
  assert.equal(h.lockLosses(), 1);
  await assert.rejects(h.guard.withBuildUse(config, async () => assert.fail('must not deploy')), /connection lost/);
  finish.resolve(); await deploy;
});

test('leader scheduler previews at startup, waits an hour, and stops cleanly', async (t) => {
  await stop();
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = harness([build('old', 1000)]);
  const list = t.mock.method(kubernetes, 'listManagedBuilds', h.runtime.listManagedBuilds);
  // An empty inventory still requires a readable reference inventory.
  // Patch the shared pool module before loading an isolated scheduler module.
  const poolModule = require('../src/db/pool');
  t.mock.method(poolModule, 'getPool', () => h.pool);
  const moduleId = require.resolve('../src/services/build-retention');
  const cached = require.cache[moduleId];
  delete require.cache[moduleId];
  const scheduler = require(moduleId);
  t.after(async () => { await scheduler.stop(); require.cache[moduleId] = cached; });
  t.mock.method(kubernetes, 'readBuild', h.runtime.readBuild);
  t.mock.method(kubernetes, 'deleteBuildSnapshot', h.runtime.deleteBuildSnapshot);
  scheduler.start(config);
  scheduler.start(config);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.state.deleted, []);
  t.mock.timers.tick(hour - 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.state.deleted, []);
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.state.deleted, ['old']);
  assert.equal(list.mock.callCount(), 2);
  await scheduler.stop();
  t.mock.timers.tick(hour);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(list.mock.callCount(), 2);
});
