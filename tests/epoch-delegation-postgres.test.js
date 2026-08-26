'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, Pool } = require('pg');

const {
  EpochDelegationError,
  EpochDelegationService,
} = require('../src/services/topochain/epoch-delegations');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';
const NETWORK = {
  id: 'testnet',
  chainId: 'utc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqcmpl5h',
};
const AUTH = { userId: '41', mobileTokenId: '71' };
const ADDRESS = 'ut1-policy-account';
const CREDENTIAL = `nsc_${Buffer.alloc(32, 7).toString('base64url')}`;
const requestId = (byte) => `ndp_${Buffer.alloc(32, byte).toString('base64url')}`;
const schemaSql = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');

function extractTable(name) {
  const match = schemaSql.match(new RegExp(
    `CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`,
  ));
  if (!match) throw new Error(`schema.sql no longer contains ${name}`);
  return match[0];
}

const POLICY_DDL = [
  extractTable('native_epoch_delegation_fences'),
  extractTable('native_epoch_delegation_policies'),
];
const STUB_DDL = `
  CREATE TABLE onchain_accounts (
    id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    address VARCHAR(255) NOT NULL,
    PRIMARY KEY (id, user_id)
  );
  CREATE TABLE native_session_credentials (
    credential_reference VARCHAR(47) PRIMARY KEY,
    credential_generation INTEGER NOT NULL,
    user_id BIGINT NOT NULL,
    account_id BIGINT NOT NULL,
    network_id VARCHAR(16) NOT NULL,
    chain_id VARCHAR(100) NOT NULL,
    mobile_auth_token_id BIGINT UNIQUE,
    state VARCHAR(16) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
  );`;

async function withDatabase(t, run) {
  const admin = new Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch (error) {
    await admin.end().catch(() => {});
    return t.skip(`no postgres reachable at ${DSN}: ${error.message || error.code || error}`);
  }

  const schema = `epoch_delegation_test_${process.pid}`;
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: DSN,
    connectionTimeoutMillis: 3000,
    max: 6,
    options: `-c search_path=${schema}`,
  });
  try {
    await pool.query(STUB_DDL);
    for (const ddl of POLICY_DDL) await pool.query(ddl);
    await pool.query(
      'INSERT INTO onchain_accounts (id, user_id, address) VALUES (9001, 41, $1)',
      [ADDRESS],
    );
    await pool.query(
      `INSERT INTO native_session_credentials
         (credential_reference, credential_generation, user_id, account_id,
          network_id, chain_id, mobile_auth_token_id, state, expires_at)
       VALUES ($1, 1, 41, 9001, 'testnet', $2, 71, 'valid', NOW() + INTERVAL '1 day')`,
      [CREDENTIAL, NETWORK.chainId],
    );
    await run(pool);
  } finally {
    await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

function sample(epoch) {
  return {
    networkId: NETWORK.id,
    chainId: NETWORK.chainId,
    epoch,
    globalSlot: epoch * 10,
    slotsInEpoch: 10,
  };
}

function service(pool, sampleEpoch) {
  return new EpochDelegationService({
    pool,
    config: {
      nativeEpochDelegationEnabled: true,
      nativeSessionV2Network: NETWORK,
    },
    sampleEpoch,
  });
}

test('real PostgreSQL enforces epoch policy ordering, constraints, and replay', async (t) => {
  await withDatabase(t, async (pool) => {
    let epoch = 10;
    const protocol = service(pool, async () => sample(epoch));
    const [left, right] = await Promise.all([
      protocol.setNativePolicy({
        ...AUTH, body: { requestId: requestId(1), delegated: false },
      }),
      protocol.setNativePolicy({
        ...AUTH, body: { requestId: requestId(2), delegated: true },
      }),
    ]);
    const latest = BigInt(left.operation.requestRevision) > BigInt(right.operation.requestRevision)
      ? left : right;
    assert.deepEqual(Object.keys(latest).sort(), [
      'account', 'credentialGeneration', 'credentialReference', 'epochs',
      'network', 'observedEpoch', 'operation', 'policyRevision', 'protocol',
    ]);
    assert.deepEqual(Object.keys(latest.operation).sort(), [
      'acceptedEpoch', 'changed', 'delegated', 'effectiveEpoch', 'replayed',
      'requestId', 'requestRevision',
    ]);
    assert.deepEqual(Object.keys(latest.epochs[0]).sort(), ['delegated', 'epoch']);
    assert.equal(latest.credentialReference, CREDENTIAL);
    assert.deepEqual(latest.account, { accountId: '9001', address: ADDRESS });
    assert.deepEqual([latest.operation.acceptedEpoch, latest.operation.effectiveEpoch], [10, 12]);

    epoch = 11;
    const nextDesired = !latest.operation.delegated;
    const next = await protocol.setNativePolicy({
      ...AUTH, body: { requestId: requestId(3), delegated: nextDesired },
    });
    assert.deepEqual([next.operation.acceptedEpoch, next.operation.effectiveEpoch], [11, 13]);
    assert.deepEqual(next.epochs.map(({ epoch: at, delegated }) => [at, delegated]), [
      [11, false], [12, latest.operation.delegated], [13, nextDesired],
    ]);
    const managed = await protocol.getManagedAssignments();
    assert.deepEqual(managed.epochs.map(({ epoch: at }) => at), [11, 12]);
    assert.deepEqual(managed.epochs[1].accounts,
      latest.operation.delegated ? [{ account: ADDRESS }] : []);

    await assert.rejects(pool.query(
      `INSERT INTO native_epoch_delegation_policies
         (request_id, credential_reference, credential_generation, user_id,
          account_id, account_address, network_id, chain_id, delegated,
          changed, accepted_epoch, effective_epoch)
       SELECT request_id, credential_reference, credential_generation, user_id,
              account_id, account_address, network_id, chain_id, delegated,
              changed, accepted_epoch, effective_epoch
         FROM native_epoch_delegation_policies WHERE request_id = $1`,
      [requestId(1)],
    ), (error) => error.code === '23505');
    await assert.rejects(pool.query(
      `UPDATE native_epoch_delegation_policies
          SET effective_epoch = effective_epoch + 1
        WHERE request_id = $1`,
      [requestId(1)],
    ), (error) => error.code === '23514');

    let releaseOld;
    let oldSampled;
    const sampled = new Promise((resolve) => { oldSampled = resolve; });
    const release = new Promise((resolve) => { releaseOld = resolve; });
    const old = service(pool, async () => {
      oldSampled();
      await release;
      return sample(50);
    });
    const newer = service(pool, async () => sample(51));
    const raceBody = { requestId: requestId(9), delegated: true };
    const staleCall = old.setNativePolicy({ ...AUTH, body: raceBody });
    await sampled;
    const committed = await newer.setNativePolicy({ ...AUTH, body: raceBody });
    releaseOld();
    await assert.rejects(staleCall, (error) => error instanceof EpochDelegationError
      && error.code === 'node_epoch_sample_stale');
    assert.equal((await pool.query(
      'SELECT COUNT(*)::int AS count FROM native_epoch_delegation_policies WHERE request_id = $1',
      [raceBody.requestId],
    )).rows[0].count, 1);

    const replay = await service(pool, async () => sample(52))
      .setNativePolicy({ ...AUTH, body: raceBody });
    assert.equal(replay.operation.replayed, true);
    assert.equal(replay.operation.requestRevision, committed.operation.requestRevision);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::int AS count FROM native_epoch_delegation_policies WHERE request_id = $1',
      [raceBody.requestId],
    )).rows[0].count, 1);
    assert.equal((await pool.query(
      'SELECT observed_epoch FROM native_epoch_delegation_fences',
    )).rows[0].observed_epoch, '52');
  });
});
