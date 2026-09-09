#!/usr/bin/env node
'use strict';

// One-shot, explicit delegation-authority cutover. It performs exactly one
// transaction: verify the supplied signer/account inventory against every
// currently open timestamp period, insert baseline policy rows effective at
// C, close those periods at C's supplied wall-clock boundary, and freeze C on
// the per-chain fence. Re-running the exact inputs verifies the committed
// result; different inputs are refused.

const crypto = require('crypto');
const fs = require('fs');
const { Client } = require('pg');
const { bech32m } = require('bech32');

const MAX_EPOCH = 0xffff_ffff;

function fail(message) {
  throw new Error(message);
}

function argsOf(argv) {
  const values = new Map();
  let apply = false;
  for (const arg of argv) {
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match || values.has(match[1])) fail(`Invalid argument: ${arg}`);
    values.set(match[1], match[2]);
  }
  const required = ['network-id', 'chain-id', 'observed-epoch', 'cutover-epoch', 'cutover-at', 'inventory'];
  for (const key of required) if (!values.get(key)) fail(`--${key}=... is required`);
  if (!apply) fail('--apply is required; this command changes delegation authority');
  return Object.fromEntries(values);
}

function canonicalEpoch(value, name) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) fail(`${name} must be a canonical unsigned integer`);
  const epoch = Number(value);
  if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > MAX_EPOCH) {
    fail(`${name} is outside the supported epoch range`);
  }
  return epoch;
}

function validateCutoverEpochs(observedEpoch, cutoverEpoch) {
  if (!Number.isSafeInteger(observedEpoch) || observedEpoch < 0 || observedEpoch > MAX_EPOCH) {
    fail('observed epoch is outside the supported range');
  }
  if (!Number.isSafeInteger(cutoverEpoch) || cutoverEpoch < 2 || cutoverEpoch > MAX_EPOCH - 2) {
    fail(`cutover epoch must be between 2 and ${MAX_EPOCH - 2}`);
  }
  if (observedEpoch > cutoverEpoch) fail('observed epoch cannot exceed cutover epoch');
}

function canonicalChainId(value) {
  if (value !== value.toLowerCase()) fail('--chain-id must be lower-case');
  try {
    const decoded = bech32m.decode(value, 1023);
    const bytes = Buffer.from(bech32m.fromWords(decoded.words));
    if (decoded.prefix !== 'utc' || bytes.length !== 32
        || bech32m.encode('utc', bech32m.toWords(bytes), 1023) !== value) {
      fail('--chain-id is not a canonical 32-byte utc ChainId');
    }
  } catch (error) {
    if (error.message.startsWith('--chain-id')) throw error;
    fail('--chain-id is not a canonical 32-byte utc ChainId');
  }
  return value;
}

function canonicalId(value, name) {
  const text = String(value);
  if (!/^[1-9][0-9]*$/.test(text)) fail(`${name} must be a positive integer string`);
  return text;
}

function loadInventory(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) fail('inventory must be a JSON array');
  const addresses = new Set();
  const accountIds = new Set();
  return parsed.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || Object.keys(row).sort().join(',') !== 'account,accountId,userId') {
      fail(`inventory[${index}] must contain exactly account, accountId, userId`);
    }
    const account = typeof row.account === 'string' ? row.account.trim() : '';
    if (!account || account.length > 255 || account !== row.account) {
      fail(`inventory[${index}].account is invalid`);
    }
    const accountId = canonicalId(row.accountId, `inventory[${index}].accountId`);
    const userId = canonicalId(row.userId, `inventory[${index}].userId`);
    if (addresses.has(account)) fail(`duplicate inventory account: ${account}`);
    if (accountIds.has(accountId)) fail(`duplicate inventory accountId: ${accountId}`);
    addresses.add(account);
    accountIds.add(accountId);
    return { account, accountId, userId };
  }).sort((a, b) => a.account.localeCompare(b.account));
}

function baselineRequestId(networkId, chainId, cutoverEpoch, account) {
  const digest = crypto.createHash('sha256')
    .update(`${networkId}\0${chainId}\0${cutoverEpoch}\0${account}`)
    .digest('base64url');
  return `ndb_${digest}`;
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function verifyAccountBindings(client, inventory) {
  const { rows } = await client.query(
    `SELECT id::text, user_id::text, address
       FROM onchain_accounts
      WHERE id = ANY($1::bigint[])`,
    [inventory.map((row) => row.accountId)]
  );
  const actual = new Map(rows.map((row) => [row.id, row]));
  for (const expected of inventory) {
    const row = actual.get(expected.accountId);
    if (!row || row.user_id !== expected.userId || row.address !== expected.account) {
      fail(`inventory binding does not match onchain_accounts for ${expected.account}`);
    }
  }
}

async function verifyCommitted(client, input, inventory, fence) {
  if (Number(fence.cutover_epoch) !== input.cutoverEpoch
      || new Date(fence.cutover_at).getTime() !== input.cutoverAt.getTime()) {
    fail('this chain already has a different immutable cutover');
  }
  const { rows } = await client.query(
    `SELECT request_id, user_id::text, account_id::text, account_address,
            accepted_epoch, effective_epoch, delegated,
            credential_reference, credential_generation
       FROM native_epoch_delegation_policies
      WHERE network_id = $1 AND chain_id = $2 AND source = 'cutover'
      ORDER BY account_address`,
    [input.networkId, input.chainId]
  );
  if (rows.length !== inventory.length) fail('committed cutover baseline size differs from inventory');
  for (let index = 0; index < inventory.length; index += 1) {
    const expected = inventory[index];
    const row = rows[index];
    if (row.request_id !== baselineRequestId(input.networkId, input.chainId, input.cutoverEpoch, expected.account)
        || row.user_id !== expected.userId || row.account_id !== expected.accountId
        || row.account_address !== expected.account || !row.delegated
        || Number(row.accepted_epoch) !== input.cutoverEpoch
        || Number(row.effective_epoch) !== input.cutoverEpoch
        || row.credential_reference !== null || row.credential_generation !== null) {
      fail(`committed cutover baseline differs for ${expected.account}`);
    }
  }
  const { rows: closedRows } = await client.query(
    `SELECT DISTINCT account
       FROM account_delegation_periods
      WHERE account = ANY($1::text[]) AND ended_at = $2
      ORDER BY account`,
    [inventory.map((row) => row.account), input.cutoverAt]
  );
  if (!sameStrings(closedRows.map((row) => row.account), inventory.map((row) => row.account))) {
    fail('legacy periods are not closed at the committed cutover boundary');
  }
}

async function cutover(client, input, inventory) {
  validateCutoverEpochs(input.observedEpoch, input.cutoverEpoch);
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('native-delegation-cutover', 0))");
    await client.query('LOCK TABLE account_delegation_periods IN SHARE ROW EXCLUSIVE MODE');
    await verifyAccountBindings(client, inventory);

    let { rows: fenceRows } = await client.query(
      `SELECT observed_epoch, cutover_epoch, cutover_at
         FROM native_epoch_delegation_fences
        WHERE network_id = $1 AND chain_id = $2
        FOR UPDATE`,
      [input.networkId, input.chainId]
    );
    if (fenceRows[0]?.cutover_epoch != null) {
      await verifyCommitted(client, input, inventory, fenceRows[0]);
      await client.query('COMMIT');
      return 'already-applied';
    }

    if (fenceRows[0] && Number(fenceRows[0].observed_epoch) > input.observedEpoch) {
      fail('supplied observed epoch is stale relative to the existing fence');
    }
    const { rows: policyCountRows } = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM native_epoch_delegation_policies
        WHERE network_id = $1 AND chain_id = $2`,
      [input.networkId, input.chainId]
    );
    if (policyCountRows[0].count !== 0) {
      fail('refusing initial cutover: epoch policies already exist for this chain');
    }

    const { rows: activeRows } = await client.query(
      `SELECT account, started_at
         FROM account_delegation_periods
        WHERE ended_at IS NULL
        ORDER BY account
        FOR UPDATE`,
    );
    if (!sameStrings(activeRows.map((row) => row.account), inventory.map((row) => row.account))) {
      fail('supplied inventory is not the exact set of open legacy delegations');
    }
    if (activeRows.some((row) => new Date(row.started_at) > input.cutoverAt)) {
      fail('cutover timestamp precedes an open legacy delegation period');
    }

    if (!fenceRows[0]) {
      await client.query(
        `INSERT INTO native_epoch_delegation_fences
           (network_id, chain_id, observed_epoch, updated_at)
         VALUES ($1, $2, $3, NOW())`,
        [input.networkId, input.chainId, input.observedEpoch]
      );
    } else {
      await client.query(
        `UPDATE native_epoch_delegation_fences
            SET observed_epoch = $3, updated_at = NOW()
          WHERE network_id = $1 AND chain_id = $2`,
        [input.networkId, input.chainId, input.observedEpoch]
      );
    }

    for (const row of inventory) {
      await client.query(
        `INSERT INTO native_epoch_delegation_policies
           (request_id, source, credential_reference, credential_generation,
            user_id, account_id, account_address, network_id, chain_id,
            delegated, changed, accepted_epoch, effective_epoch, accepted_at)
         VALUES ($1, 'cutover', NULL, NULL, $2, $3, $4, $5, $6,
                 TRUE, TRUE, $7, $7, $8)`,
        [baselineRequestId(input.networkId, input.chainId, input.cutoverEpoch, row.account),
          row.userId, row.accountId, row.account, input.networkId, input.chainId,
          input.cutoverEpoch, input.cutoverAt]
      );
    }

    await client.query(
      `UPDATE account_delegation_periods
          SET ended_at = $1, updated_at = $1
        WHERE ended_at IS NULL`,
      [input.cutoverAt]
    );
    const { rows: updatedFenceRows } = await client.query(
      `UPDATE native_epoch_delegation_fences
          SET cutover_epoch = $3, cutover_at = $4, updated_at = NOW()
        WHERE network_id = $1 AND chain_id = $2 AND cutover_epoch IS NULL
        RETURNING observed_epoch, cutover_epoch, cutover_at`,
      [input.networkId, input.chainId, input.cutoverEpoch, input.cutoverAt]
    );
    if (updatedFenceRows.length !== 1) fail('cutover fence was not established');
    await verifyCommitted(client, input, inventory, updatedFenceRows[0]);
    await client.query('COMMIT');
    return 'applied';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  if (!process.env.DATABASE_URL) fail('DATABASE_URL is required');
  if (args['network-id'] !== 'testnet') fail('--network-id must be testnet');
  if (!process.env.NATIVE_SESSION_V2_TESTNET_CHAIN_ID) {
    fail('NATIVE_SESSION_V2_TESTNET_CHAIN_ID is required to prove the single canonical delegation chain');
  }
  const configuredChainId = canonicalChainId(
    process.env.NATIVE_SESSION_V2_TESTNET_CHAIN_ID
  );
  const chainId = canonicalChainId(args['chain-id']);
  if (chainId !== configuredChainId) {
    fail('--chain-id must equal the configured single canonical delegation chain');
  }
  const observedEpoch = canonicalEpoch(args['observed-epoch'], '--observed-epoch');
  const cutoverEpoch = canonicalEpoch(args['cutover-epoch'], '--cutover-epoch');
  validateCutoverEpochs(observedEpoch, cutoverEpoch);
  const cutoverAt = new Date(args['cutover-at']);
  if (!Number.isFinite(cutoverAt.getTime()) || cutoverAt.toISOString() !== args['cutover-at']) {
    fail('--cutover-at must be an exact UTC ISO instant, for example 2030-01-01T00:00:00.000Z');
  }
  const input = {
    networkId: args['network-id'],
    chainId,
    observedEpoch,
    cutoverEpoch,
    cutoverAt,
  };
  const inventory = loadInventory(args.inventory);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const result = await cutover(client, input, inventory);
    process.stdout.write(`Native delegation cutover ${result}: ${inventory.length} baseline account(s), C=${cutoverEpoch}.\n`);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Native delegation cutover failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { baselineRequestId, cutover, loadInventory };
