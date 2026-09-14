'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createGuard } = require('../src/services/build-retention-guard');
const { STAGING_BUILD_LOCK, PRODUCTION_BUILD_LOCK, STAGING_TEMPLATE_LOCK } = require('../src/services/advisory-locks');
const config = { appRuntime: 'kubernetes', databaseUrl: 'postgres://unused/platform' };
const pause = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

// Independent guards model separate platform Pods, with a shared lock server.
// Ownership is session-scoped and reentrant just like Postgres, so omitting
// local serialization or accidentally sharing connection ownership is visible.
function harness() {
  const locks = new Map();
  const clients = [];
  let losses = 0;
  const makeClient = () => {
    const client = new EventEmitter();
    clients.push(client);
    client.connect = async () => {};
    client.query = async (sql, args) => {
      const key = args.join(':');
      if (sql.includes('pg_advisory_lock_shared')) return { rows: [] };
      if (sql.includes('pg_try_advisory_lock')) {
        const acquired = !locks.has(key) || locks.get(key) === client;
        if (acquired) locks.set(key, client);
        return { rows: [{ acquired }] };
      }
      assert.match(sql, /pg_advisory_unlock/);
      const released = locks.get(key) === client;
      if (released) locks.delete(key);
      return { rows: [{ released }] };
    };
    client.end = async () => {
      for (const [key, owner] of locks) if (owner === client) locks.delete(key);
      client.emit('end');
    };
    return client;
  };
  return { clients, locks, losses: () => losses,
    guard: () => createGuard({ makeClient, retryMs: 1, onLockLost: () => { losses++; } }) };
}

test('old/new Pods cannot clone the same preview concurrently; other previews remain parallel', async () => {
  const h = harness(); const oldPod = h.guard(); const newPod = h.guard();
  const started = deferred(); const finish = deferred();
  const events = [];
  const first = oldPod.withResourceUse(config, STAGING_BUILD_LOCK, 7, async () => {
    events.push('old clone'); started.resolve(); await finish.promise; events.push('old deployed');
  });
  await started.promise;
  const second = newPod.withResourceUse(config, STAGING_BUILD_LOCK, 7, async () => { events.push('new clone'); });
  await newPod.withResourceUse(config, STAGING_BUILD_LOCK, 8, async () => { events.push('other clone'); });
  assert.deepEqual(events, ['old clone', 'other clone']);
  assert.equal(h.clients.length, 2, 'one connection per Pod, including blocked and independent builds');
  finish.resolve(); await Promise.all([first, second]);
  assert.deepEqual(events, ['old clone', 'other clone', 'old deployed', 'new clone']);
  assert.equal(h.locks.size, 0);
});

test('same-Pod requests cannot reenter the same resource lock and a failure releases it', async () => {
  const h = harness(); const pod = h.guard();
  const started = deferred(); const finish = deferred(); let ran = false;
  const first = pod.withResourceUse(config, PRODUCTION_BUILD_LOCK, 'demo', async () => {
    started.resolve(); await finish.promise; throw new Error('build failed');
  });
  const rejected = assert.rejects(first, /build failed/);
  await started.promise;
  const second = pod.withResourceUse(config, PRODUCTION_BUILD_LOCK, 'demo', async () => { ran = true; });
  await pause(); assert.equal(ran, false);
  finish.resolve(); await rejected; await second;
  assert.equal(ran, true); assert.equal(h.locks.size, 0);
});

test('nested template protection can proceed while another Pod waits on the preview lock', async () => {
  const h = harness(); const pod = h.guard(); const peer = h.guard();
  await pod.withResourceUse(config, STAGING_BUILD_LOCK, 7, async () => {
    await peer.withResourceUse(config, STAGING_BUILD_LOCK, 8, async () => {
      await pod.withResourceUse(config, STAGING_TEMPLATE_LOCK, 'app_demo', async () => {});
    });
  });
  assert.equal(h.locks.size, 0);
  assert.equal(h.clients.length, 2, 'nested scopes reuse the guard connection');
});

test('a lost connection prevents a waiting builder from entering its critical section', async () => {
  const h = harness(); const oldPod = h.guard(); const newPod = h.guard();
  const started = deferred(); const finish = deferred();
  const first = oldPod.withResourceUse(config, STAGING_BUILD_LOCK, 7, async () => {
    started.resolve(); await finish.promise;
  });
  await started.promise;
  const second = newPod.withResourceUse(config, STAGING_BUILD_LOCK, 7, async () => assert.fail('lost lock'));
  const rejected = assert.rejects(second, /connection lost/);
  while (h.clients.length < 2) await pause();
  h.clients[1].emit('error', new Error('connection lost'));
  await rejected; assert.equal(h.losses(), 1);
  finish.resolve(); await first;
});

test('Docker retains its existing local serialization without opening database locks', async () => {
  const h = harness();
  assert.equal(await h.guard().withResourceUse({ appRuntime: 'docker' }, STAGING_BUILD_LOCK, 1, async () => 'ok'), 'ok');
  assert.equal(h.clients.length, 0);
});
