'use strict';

// A test-only known-vulnerable arena variant proves the private-data detector
// fires (services/security-bot/probe.js + fixtures.js + the scripted target in
// tests/lib/security-bot-arena-target.js). The vulnerable variant leaks one
// project's secret to a member of another; the detector must confirm it as a
// finding, and must stay silent on the secure variant.

const test = require('node:test');
const assert = require('node:assert/strict');
const runs = require('../src/services/security-bot/runs');
const probe = require('../src/services/security-bot/probe');
const fixtures = require('../src/services/security-bot/fixtures');
const { createBroker } = require('../src/services/security-bot/broker');
const { buildArenaTarget } = require('./lib/security-bot-arena-target');
const { database, reset } = require('./lib/security-bot-postgres');

const resourcePathFor = (owner) => `/api/projects/${owner.username}/secret`;

function brokerFor(pool, lease, fetchImpl) {
  return createBroker({
    origin: 'http://arena-host:3000',
    pool,
    lease,
    maxParallel: 2,
    resolveIdentity: async (ref) => ({ headers: { 'x-usernode-token': ref } }),
    fetchImpl,
  });
}

test('the known-vulnerable variant makes the private-data detector fire', { timeout: 120000 }, async (t) => {
  const db = await database(t, 'security_vuln');
  if (!db) return;
  const { pool } = db;
  t.beforeEach(() => reset(pool));

  async function activeLease() {
    const run = await runs.claimRun(pool, { runId: (await runs.createRun(pool)).id, owner: 'worker-a' });
    return runs.leaseFor(run);
  }

  await t.test('vulnerable variant: cross-account leak is confirmed as a finding', async () => {
    const lease = await activeLease();
    const set = fixtures.buildFixtureSet({ runId: lease.runId });
    const broker = brokerFor(pool, lease, buildArenaTarget({ set, vulnerable: true }));
    const result = await probe.runCrossAccountProbe(pool, lease, {
      broker, fixtures: fixtures.probeOwners(set), resourcePathFor,
    });
    assert.equal(result.outcome, 'variant-confirmed');
    assert.ok(result.finding);
    const findings = (await pool.query('SELECT * FROM security_bot_findings')).rows;
    assert.equal(findings.length, 1);
    assert.equal(findings[0].category, 'private-data');
    assert.equal(findings[0].severity, 'high');
    const probes = (await pool.query("SELECT * FROM security_bot_probes WHERE run_id = $1", [lease.runId])).rows;
    assert.equal(probes[0].outcome, 'variant-confirmed');
  });

  await t.test('secure variant: the same probe finds nothing', async () => {
    const lease = await activeLease();
    const set = fixtures.buildFixtureSet({ runId: lease.runId });
    const broker = brokerFor(pool, lease, buildArenaTarget({ set, vulnerable: false }));
    const result = await probe.runCrossAccountProbe(pool, lease, {
      broker, fixtures: fixtures.probeOwners(set), resourcePathFor,
    });
    assert.equal(result.outcome, 'passed');
    assert.equal((await pool.query('SELECT COUNT(*) FROM security_bot_findings')).rows[0].count, '0');
  });

  await t.test('the confirmed leak carries this run marker, proving it is planted data', async () => {
    const lease = await activeLease();
    const set = fixtures.buildFixtureSet({ runId: lease.runId });
    // The target leaks project B's secret to alice; that secret embeds the run
    // marker, so the leak is unambiguously this run's planted data.
    const broker = brokerFor(pool, lease, buildArenaTarget({ set, vulnerable: true }));
    const { ownerA, ownerB } = fixtures.probeOwners(set);
    const response = await broker.request(resourcePathFor(ownerB), { identityRef: ownerA.identityRef });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.ok(body.includes(set.runMarker));
    assert.equal(body, set.projects.B.secret);
  });
});
