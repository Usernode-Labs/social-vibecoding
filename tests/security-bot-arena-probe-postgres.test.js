'use strict';

// The security bot's arena lifecycle and cross-account protected-data probe
// against the full PostgreSQL schema (services/security-bot/arena.js and
// probe.js), driven through the real broker and the real run-lease fencing.

const test = require('node:test');
const assert = require('node:assert/strict');
const runs = require('../src/services/security-bot/runs');
const arena = require('../src/services/security-bot/arena');
const probe = require('../src/services/security-bot/probe');
const { createBroker } = require('../src/services/security-bot/broker');
const { database, reset } = require('./lib/security-bot-postgres');

// A fake target app reachable only through the broker. `secure` scopes each
// owner's secret to that owner's token; `vulnerable` leaks any owner's secret
// to any caller.
function fakeTarget({ vulnerable, owners }) {
  return async (url, options) => {
    const path = new URL(url).pathname;
    const token = options.headers['x-usernode-token'];
    const match = /^\/api\/owners\/([^/]+)\/secret$/.exec(path);
    if (!match) return { status: 404, text: async () => '' };
    const pathOwner = owners.find((o) => o.username === match[1]);
    const caller = owners.find((o) => o.identityRef === token);
    if (!pathOwner || !caller) return { status: 401, text: async () => '' };
    if (vulnerable || caller.username === pathOwner.username) {
      return { status: 200, text: async () => pathOwner.secret };
    }
    return { status: 403, text: async () => '' };
  };
}

function brokerFor(pool, lease, target, owners) {
  return createBroker({
    origin: 'http://arena-host:3000',
    pool,
    lease,
    maxParallel: 2,
    resolveIdentity: async (ref) => ({ headers: { 'x-usernode-token': ref } }),
    fetchImpl: target,
  });
}

const resourcePathFor = (owner) => `/api/owners/${owner.username}/secret`;

test('arena lifecycle and the cross-account probe on real Postgres', { timeout: 120000 }, async (t) => {
  const db = await database(t, 'security_arena');
  if (!db) return;
  const { pool } = db;
  t.beforeEach(() => reset(pool));

  async function activeLease() {
    const run = await runs.claimRun(pool, { runId: (await runs.createRun(pool)).id, owner: 'worker-a' });
    return runs.leaseFor(run);
  }

  await t.test('provision generates independent secrets and synthetic fixtures through the boundary', async () => {
    const lease = await activeLease();
    const provisioned = [];
    const runtime = {
      provision: async (spec) => { provisioned.push(spec); return { ref: spec.ref }; },
      origin: (ref) => `http://${ref.ref}:3000`,
    };
    const first = arena.generateArenaSecrets();
    const second = arena.generateArenaSecrets();
    assert.notEqual(first.jwtPrivateKey, second.jwtPrivateKey);
    assert.ok(first.jwtPublicKey.includes('BEGIN PUBLIC KEY'));
    assert.notEqual(first.appAudience, second.appAudience);

    const handle = await arena.provision(pool, lease, { runtime });
    assert.ok(handle.ref.startsWith('secbot-arena-'));
    assert.equal(handle.origin, `http://${handle.ref}:3000`);
    assert.notEqual(handle.fixtures.ownerA.secret, handle.fixtures.ownerB.secret);
    assert.notEqual(handle.fixtures.ownerA.username, handle.fixtures.ownerB.username);
    // The private key is handed to the runtime, never returned to the caller.
    assert.equal(handle.jwtPrivateKey, undefined);
    assert.ok(provisioned[0].secrets.jwtPrivateKey.includes('BEGIN PRIVATE KEY'));
    assert.equal(provisioned[0].freshDatabase, true);
    const run = await runs.getRun(pool, lease.runId);
    assert.equal(run.arena_ref, handle.ref);
    assert.equal(run.arena_status, arena.STATUS.ready);
  });

  await t.test('a lost lease cannot write arena state, and failed provision records failure', async () => {
    const lease = await activeLease();
    const stale = { ...lease, generation: lease.generation + 5 };
    await assert.rejects(arena.setStatus(pool, stale, arena.STATUS.ready), { code: 'lease_lost' });
    await assert.rejects(arena.provision(pool, lease, {
      runtime: { provision: async () => { throw new Error('boom'); } },
    }), /boom/);
    assert.equal((await runs.getRun(pool, lease.runId)).arena_status, arena.STATUS.failed);
  });

  await t.test('destroy is idempotent, generation-bound, and tolerates a never-saved ref', async () => {
    const lease = await activeLease();
    await arena.provision(pool, lease, {
      runtime: { provision: async (s) => ({ ref: s.ref }), origin: (r) => `http://${r.ref}:3000` },
    });
    let destroyCalls = 0;
    const runtime = { destroy: async () => { destroyCalls += 1; } };
    const claim = { id: lease.runId, cleanup_target_generation: null };
    const first = await arena.destroy(pool, claim, { runtime });
    assert.equal(first.destroyed, true);
    assert.equal((await runs.getRun(pool, lease.runId)).arena_status, arena.STATUS.destroyed);
    const again = await arena.destroy(pool, claim, { runtime });
    assert.equal(again.reason, 'already');
    assert.equal(destroyCalls, 1);

    // A fenced run carries a cleanup_target_generation; a stale claim naming a
    // different generation must not tear down this generation's arena.
    await pool.query(
      "UPDATE security_bot_runs SET cleanup_target_generation = 3, arena_status = 'ready' WHERE id = $1",
      [lease.runId],
    );
    await assert.rejects(arena.destroy(pool, { id: lease.runId, cleanup_target_generation: 999 }, { runtime }),
      { code: 'cleanup_generation_mismatch' });
    const matched = await arena.destroy(pool, { id: lease.runId, cleanup_target_generation: 3 }, { runtime });
    assert.equal(matched.destroyed, true);
    assert.equal(destroyCalls, 2);
  });

  await t.test('reconcile asks for cleanup on a ready arena whose run is not cleaned up', async () => {
    const lease = await activeLease();
    await arena.provision(pool, lease, {
      runtime: { provision: async (s) => ({ ref: s.ref }), origin: (r) => `http://${r.ref}:3000` },
    });
    const run = await runs.getRun(pool, lease.runId);
    assert.deepEqual(arena.reconcile(run), { action: 'cleanup', ref: run.arena_ref });
    assert.deepEqual(arena.reconcile({ arena_status: 'destroyed' }), { action: 'none' });
  });

  await t.test('a secure target: cross-account read is blocked, probe passes, no finding', async () => {
    const lease = await activeLease();
    const fixtures = arena.buildSyntheticFixtures();
    const owners = [fixtures.ownerA, fixtures.ownerB];
    const broker = brokerFor(pool, lease, fakeTarget({ vulnerable: false, owners }), owners);
    const result = await probe.runCrossAccountProbe(pool, lease, { broker, fixtures, resourcePathFor });
    assert.equal(result.outcome, 'passed');
    const probes = (await pool.query('SELECT * FROM security_bot_probes WHERE run_id = $1', [lease.runId])).rows;
    assert.equal(probes.length, 1);
    assert.equal(probes[0].category, 'private-data');
    assert.equal((await pool.query('SELECT COUNT(*) FROM security_bot_findings')).rows[0].count, '0');
    // Every physical request was counted against the run's ceiling.
    assert.ok((await runs.getRun(pool, lease.runId)).target_requests >= 2);
  });

  await t.test('a broken read path records unsupported, never a finding', async () => {
    const lease = await activeLease();
    const fixtures = arena.buildSyntheticFixtures();
    const owners = [fixtures.ownerA, fixtures.ownerB];
    // A target that refuses even the owner's own read breaks the positive control.
    const broken = async () => ({ status: 500, text: async () => '' });
    const broker = brokerFor(pool, lease, broken, owners);
    const result = await probe.runCrossAccountProbe(pool, lease, { broker, fixtures, resourcePathFor });
    assert.equal(result.outcome, 'unsupported');
    assert.equal((await pool.query('SELECT COUNT(*) FROM security_bot_findings')).rows[0].count, '0');
  });

  await t.test('a vulnerable target: leak is independently verified and recorded as a finding', async () => {
    const lease = await activeLease();
    const fixtures = arena.buildSyntheticFixtures();
    const owners = [fixtures.ownerA, fixtures.ownerB];
    const broker = brokerFor(pool, lease, fakeTarget({ vulnerable: true, owners }), owners);
    const result = await probe.runCrossAccountProbe(pool, lease, { broker, fixtures, resourcePathFor });
    assert.equal(result.outcome, 'variant-confirmed');
    assert.ok(result.finding);
    const probes = (await pool.query('SELECT * FROM security_bot_probes WHERE run_id = $1', [lease.runId])).rows;
    assert.equal(probes[0].outcome, 'variant-confirmed');
    assert.equal(probes[0].variant, true);
    const findings = (await pool.query('SELECT * FROM security_bot_findings')).rows;
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'high');
    assert.equal(findings[0].verified_by, 'independent-verifier');
    const occ = (await pool.query('SELECT COUNT(*) FROM security_bot_finding_occurrences')).rows[0].count;
    assert.equal(occ, '1');
  });

  await t.test('a candidate the independent verifier rejects is not a finding', async () => {
    const lease = await activeLease();
    const fixtures = arena.buildSyntheticFixtures();
    const owners = [fixtures.ownerA, fixtures.ownerB];
    const broker = brokerFor(pool, lease, fakeTarget({ vulnerable: true, owners }), owners);
    // A verifier that never confirms, standing in for independent evidence that
    // does not reproduce the leak.
    const result = await probe.runCrossAccountProbe(pool, lease, {
      broker, fixtures, resourcePathFor, verify: async () => false,
    });
    assert.equal(result.outcome, 'failed');
    assert.equal((await pool.query('SELECT COUNT(*) FROM security_bot_findings')).rows[0].count, '0');
    assert.equal((await pool.query('SELECT outcome FROM security_bot_probes WHERE run_id = $1', [lease.runId])).rows[0].outcome, 'failed');
  });
});
