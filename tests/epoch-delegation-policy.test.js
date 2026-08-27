'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const nodeStatus = require('../src/services/node-status');
const {
  policyRequestSchema,
} = require('../src/services/topochain/epoch-delegations');
const {
  managedEpochDelegationRoutes,
} = require('../src/routes/topochain/epoch-delegation');

const NETWORK = {
  id: 'testnet',
  chainId: 'utc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkmzk3k',
};
const requestId = (byte) => `ndp_${Buffer.alloc(32, byte).toString('base64url')}`;

test('native delegation request is a closed DTO', () => {
  assert.equal(policyRequestSchema.safeParse({ requestId: requestId(1), delegated: true }).success, true);
  assert.equal(policyRequestSchema.safeParse({ requestId: 'request-1', delegated: true }).success, false);
  assert.equal(policyRequestSchema.safeParse({
    requestId: requestId(1), delegated: true, account: 'caller-owned',
  }).success, false);
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

test('managed E through E+2 read requires its API key', async () => {
  const expected = {
    success: true,
    epochs: [
      { epoch: 8, accounts: [] },
      { epoch: 9, accounts: [] },
      { epoch: 10, accounts: [] },
    ],
  };
  const app = express();
  app.use(managedEpochDelegationRoutes(
    { topochainPartnerApiKey: 'managed-secret' },
    { service: { getManagedAssignments: async () => expected } },
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
