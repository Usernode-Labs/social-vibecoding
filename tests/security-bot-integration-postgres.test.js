'use strict';

// Security bot integration (#4678, checkpoint two): the broker lets nothing
// escape its pinned origin, and a cancelled or expired campaign is fenced and
// torn down. Drives the real broker, run-lease fencing, cancellation/expiry
// reconciliation and arena.destroy as runCleanup's teardown adapter.

const test = require('node:test');
const assert = require('node:assert/strict');
const runs = require('../src/services/security-bot/runs');
const arena = require('../src/services/security-bot/arena');
const { createBroker } = require('../src/services/security-bot/broker');
const { database, reset } = require('./lib/security-bot-postgres');

const ORIGIN = 'http://arena-host:3000';

// A fetchImpl that records every URL it is actually asked to open, so a test can
// assert that nothing ever left for a non-target origin and that a redirect was
// not chased.
function recordingFetch({ redirectTo } = {}) {
  const urls = [];
  const fn = async (url) => {
    urls.push(url);
    if (redirectTo) return { status: 302, text: async () => '', headers: { get: (h) => (h.toLowerCase() === 'location' ? redirectTo : null) } };
    return { status: 200, text: async () => 'ok' };
  };
  fn.urls = urls;
  return fn;
}

function brokerFor(pool, lease, fetchImpl) {
  return createBroker({
    origin: ORIGIN, pool, lease, maxParallel: 2,
    resolveIdentity: async (ref) => ({ headers: { 'x-usernode-token': ref || 'id' } }),
    fetchImpl,
  });
}

const PROVISION_RUNTIME = {
  provision: async (s) => ({ ref: s.ref }),
  origin: (r) => `http://${r.ref}:3000`,
};

test('broker egress containment and campaign teardown on real Postgres', { timeout: 120000 }, async (t) => {
  const db = await database(t, 'security_integ');
  if (!db) return;
  const { pool } = db;
  t.beforeEach(() => reset(pool));

  async function activeLease() {
    const run = await runs.claimRun(pool, { runId: (await runs.createRun(pool)).id, owner: 'worker-a' });
    return runs.leaseFor(run);
  }

  await t.test('path, protocol and userinfo escapes never reach the network', async () => {
    const lease = await activeLease();
    const fetchImpl = recordingFetch();
    const broker = brokerFor(pool, lease, fetchImpl);
    for (const bad of [
      'http://evil.example/x', 'https://evil.example/x', '//evil.example/x',
      '/../etc/passwd', '/a/../../b', '/a/%2e%2e/b', '/%2e%2e%2fetc',
      '/user@evil.example/x', 'relative/path', '/a\\b', '/a b', '/a\u0000b',
    ]) {
      await assert.rejects(broker.request(bad), (e) => e.name === 'SecurityBotBrokerError', `expected ${bad} refused`);
    }
    assert.equal(fetchImpl.urls.length, 0, 'no escaping request may reach the network');
    // Nothing was counted against the run either, since nothing dispatched.
    assert.equal((await runs.getRun(pool, lease.runId)).target_requests, 0);
  });

  await t.test('caller Host and forwarding headers are refused, with no egress', async () => {
    const lease = await activeLease();
    const fetchImpl = recordingFetch();
    const broker = brokerFor(pool, lease, fetchImpl);
    for (const header of ['Host', 'X-Forwarded-For', 'X-Forwarded-Host', 'Forwarded', 'X-Real-IP', 'Via', 'Cookie', 'Authorization']) {
      await assert.rejects(broker.request('/x', { headers: { [header]: 'spoof' } }), { code: 'forbidden_header' });
    }
    assert.equal(fetchImpl.urls.length, 0);
  });

  await t.test('a redirect is returned, never followed, and only the target origin is ever dialled', async () => {
    const lease = await activeLease();
    const fetchImpl = recordingFetch({ redirectTo: 'http://evil.example/next' });
    const broker = brokerFor(pool, lease, fetchImpl);
    const res = await broker.request('/redirect-me');
    assert.equal(res.status, 302); // surfaced to the caller
    // Exactly one dial, to the pinned origin; the Location was never followed.
    assert.equal(fetchImpl.urls.length, 1);
    assert.ok(fetchImpl.urls[0].startsWith(ORIGIN + '/'));
    assert.ok(!fetchImpl.urls.some((u) => u.includes('evil.example')));
  });

  await t.test('every dispatched request lands on the pinned origin', async () => {
    const lease = await activeLease();
    const fetchImpl = recordingFetch();
    const broker = brokerFor(pool, lease, fetchImpl);
    await broker.request('/api/a');
    await broker.request('/api/b?x=1#frag');
    assert.ok(fetchImpl.urls.every((u) => new URL(u).origin === ORIGIN), 'all egress on the pinned origin');
    assert.equal(fetchImpl.urls.length, 2);
  });

  await t.test('cancellation fences the broker and runCleanup tears the arena down', async () => {
    const lease = await activeLease();
    await arena.provision(pool, lease, { runtime: PROVISION_RUNTIME });
    const fetchImpl = recordingFetch();
    const broker = brokerFor(pool, lease, fetchImpl);
    await broker.request('/api/warm'); // works while live
    assert.equal(fetchImpl.urls.length, 1);

    const run = await runs.getRun(pool, lease.runId);
    await runs.cancelRun(pool, { runId: run.id, generation: run.lease_generation });
    const cancelled = await runs.getRun(pool, lease.runId);
    assert.ok(cancelled.capabilities_revoked_at);

    // The broker holding the old lease can no longer dispatch, and no further
    // request leaves.
    // The rejection comes from the run-lease gate (a SecurityBotRunError the
    // broker surfaces); the property that matters is that nothing more leaves.
    await assert.rejects(broker.request('/api/again'));
    assert.equal(fetchImpl.urls.length, 1);

    const destroyed = [];
    const revoked = [];
    const stopped = [];
    const result = await runs.runCleanup(pool, {
      owner: 'cleanup-worker',
      revokeCapabilities: async (claim) => { revoked.push(claim.cleanup_target_generation); },
      stopJobs: async (claim) => { stopped.push(claim.id); },
      destroyArena: async (claim) => { destroyed.push(claim.id); await arena.destroy(pool, claim, { runtime: { destroy: async () => {} } }); },
    });
    assert.equal(result.cleanup_status, 'completed');
    assert.equal(result.status, 'cancelled');
    assert.equal(destroyed.length, 1);
    assert.equal(revoked.length, 1);
    assert.equal(stopped.length, 1);
    assert.equal((await runs.getRun(pool, lease.runId)).arena_status, arena.STATUS.destroyed);
  });

  await t.test('an expired lease is reconciled and its arena is cleaned up', async () => {
    const lease = await activeLease();
    await arena.provision(pool, lease, { runtime: PROVISION_RUNTIME });
    const fetchImpl = recordingFetch();
    const broker = brokerFor(pool, lease, fetchImpl);

    // The owner process vanished: its lease expires with the deadline still
    // ahead, so recovery is possible but the current attempt is fenced.
    await pool.query(
      "UPDATE security_bot_runs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [lease.runId],
    );
    const [reconciled] = await runs.reconcileExpired(pool);
    assert.equal(reconciled.status, 'interrupted');

    // The stale broker cannot dispatch after its lease was fenced.
    await assert.rejects(broker.request('/api/after-expiry'));
    assert.equal(fetchImpl.urls.length, 0);

    // Cleanup, bound to the fenced generation, tears the arena down before any
    // recovered campaign may start.
    const seenTargetGenerations = [];
    const result = await runs.runCleanup(pool, {
      owner: 'cleanup-worker',
      revokeCapabilities: async () => {},
      stopJobs: async () => {},
      destroyArena: async (claim) => {
        seenTargetGenerations.push(claim.cleanup_target_generation);
        await arena.destroy(pool, claim, { runtime: { destroy: async () => {} } });
      },
    });
    assert.equal(result.cleanup_status, 'completed');
    assert.equal((await runs.getRun(pool, lease.runId)).arena_status, arena.STATUS.destroyed);
    assert.equal(seenTargetGenerations.length, 1);
    assert.ok(Number.isInteger(seenTargetGenerations[0]));
  });
});
