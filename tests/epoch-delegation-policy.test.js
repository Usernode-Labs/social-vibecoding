'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const nodeStatus = require('../src/services/node-status');
const {
  policyRequestSchema,
  EpochDelegationService,
} = require('../src/services/topochain/epoch-delegations');
const {
  nativeEpochDelegationRoutes,
  managedEpochDelegationRoutes,
} = require('../src/routes/topochain/epoch-delegation');

const NETWORK = {
  id: 'testnet',
  chainId: 'utc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqcmpl5h',
};
const requestId = (byte) => `ndp_${Buffer.alloc(32, byte).toString('base64url')}`;

test('native delegation request is closed and its rollout gate defaults shut', () => {
  assert.equal(policyRequestSchema.safeParse({ requestId: requestId(1), delegated: true }).success, true);
  assert.equal(policyRequestSchema.safeParse({ requestId: 'request-1', delegated: true }).success, false);
  assert.equal(policyRequestSchema.safeParse({
    requestId: requestId(1), delegated: true, account: 'caller-owned',
  }).success, false);
  assert.equal(new EpochDelegationService({
    pool: null,
    config: { nativeSessionV2Network: NETWORK },
  }).enabled, false);
});

test('canonical epoch sampling uses one live, internally consistent node status', async () => {
  let response = {
    node: {
      chain_id: NETWORK.chainId,
      cur_global_slot: 129,
      slots_in_epoch: 10,
      cur_epoch: 12,
    },
  };
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(response));
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const rpcUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await nodeStatus.sampleCanonicalEpoch({ rpcUrl, network: NETWORK }), {
      networkId: NETWORK.id,
      chainId: NETWORK.chainId,
      epoch: 12,
      globalSlot: 129,
      slotsInEpoch: 10,
    });
    response = { node: { ...response.node, cur_epoch: 11 } };
    await assert.rejects(
      nodeStatus.sampleCanonicalEpoch({ rpcUrl, network: NETWORK }),
      /epoch does not match/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('managed current+next read requires its API key', async () => {
  const expected = {
    success: true,
    epochs: [{ epoch: 8, accounts: [] }, { epoch: 9, accounts: [] }],
  };
  const app = express();
  app.use(managedEpochDelegationRoutes(
    { topochainPartnerApiKey: 'managed-secret' },
    { service: { enabled: true, getManagedAssignments: async () => expected } },
  ));
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/api/v1/delegations?include=next`)).status, 401);
    const accepted = await fetch(`${base}/api/v1/delegations?include=next`, {
      headers: { 'x-api-key': 'managed-secret' },
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), expected);
  });
});

test('disabled rollout keeps native dark and managed polling fail-closed', async () => {
  const app = express();
  const disabled = { enabled: false };
  app.use(nativeEpochDelegationRoutes({}, { service: disabled }));
  app.use(managedEpochDelegationRoutes(
    { topochainPartnerApiKey: 'managed-secret' },
    { service: disabled },
  ));
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/api/v4/mobile/native/delegation`)).status, 404);
    const managed = await fetch(`${base}/api/v1/delegations?include=next`, {
      headers: { 'x-api-key': 'managed-secret' },
    });
    assert.equal(managed.status, 503);
    assert.equal((await managed.json()).code, 'native_delegation_unavailable');
  });
});
